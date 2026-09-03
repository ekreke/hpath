// Handler dispatch: chooses between the mock implementation (--mock, default)
// and the real one (SQLite-backed). Real mode serves the minimal read path
// (ListProjects/ListEnvs/ListCases/GetCase) from SQLite (T3) plus project
// creation (CreateProject, T5 repository); every other method reports
// UNIMPLEMENTED until its wiring task lands (runs/artifacts in T8, PRD parse
// in later tasks).

import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import type { sendUnaryData, ServerUnaryCall, ServiceError } from "@grpc/grpc-js";
import type {
  Case,
  CreateProjectRequest,
  GetCaseRequest,
  HpathServer,
  ListCasesRequest,
  ListCasesResponse,
  ListEnvsRequest,
  ListEnvsResponse,
  ListProjectsResponse,
  Project,
} from "@hpath/contract";
import type { MockStore } from "../mock/store.js";
import { createMockHandlers, grpcError } from "../mock/handlers.js";
import {
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  NotFoundError,
  RepositoryError,
} from "../db/errors.js";
import type { HpathDb } from "../db/index.js";

export type ServerMode = "mock" | "real";

function unimplemented(): ServiceError {
  return grpcError(
    status.UNIMPLEMENTED,
    "not wired in real mode yet (SPEC T8+); served today: ListProjects/CreateProject/ListEnvs/ListCases/GetCase over SQLite — start with --mock for the full contract",
  );
}

function createUnimplementedHandlers(): HpathServer {
  const unary = (_call: unknown, callback: (err: ServiceError | null) => void): void => {
    callback(unimplemented());
  };
  const streaming = (call: { emit(event: "error", err: ServiceError): boolean }): void => {
    call.emit("error", unimplemented());
  };
  return {
    listProjects: unary,
    createProject: unary,
    listEnvs: unary,
    upsertEnv: unary,
    deleteEnv: unary,
    parsePrd: streaming,
    listCases: unary,
    getCase: unary,
    reviewCase: unary,
    runCase: streaming,
    listRuns: unary,
    getRun: unary,
    downloadArtifact: streaming,
  } as unknown as HpathServer;
}

/**
 * Map repository errors onto gRPC status codes (mapping documented in
 * db/errors.ts). Anything else is passed through untouched: gRPC layer errors
 * are already ServiceErrors, and unexpected failures must stay loud.
 */
function toGrpcError(err: unknown): ServiceError {
  if (err instanceof NotFoundError) {
    return grpcError(status.NOT_FOUND, err.message);
  }
  if (err instanceof ConflictError) {
    return grpcError(status.ALREADY_EXISTS, err.message);
  }
  if (err instanceof InvalidTransitionError) {
    return grpcError(status.FAILED_PRECONDITION, err.message);
  }
  if (err instanceof ForeignKeyError) {
    return grpcError(status.INVALID_ARGUMENT, err.message);
  }
  if (err instanceof RepositoryError) {
    return grpcError(status.INTERNAL, err.message);
  }
  return err as ServiceError;
}

/**
 * Real-mode handlers: the minimal SQLite read path (T3) plus CreateProject
 * (T5 repository). Runs and artifact streaming stay UNIMPLEMENTED until their
 * wiring tasks.
 */
function createRealHandlers(db: HpathDb): HpathServer {
  return {
    ...createUnimplementedHandlers(),

    createProject: (
      call: ServerUnaryCall<CreateProjectRequest, Project>,
      callback: sendUnaryData<Project>,
    ): void => {
      try {
        const { name, repoUrl } = call.request;
        if (!name) {
          throw grpcError(status.INVALID_ARGUMENT, "name is required");
        }
        const project: Project = {
          id: randomUUID(),
          name,
          repoUrl: repoUrl ?? "",
          createdAt: new Date().toISOString(),
        };
        callback(null, db.projects.create(project));
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    listProjects: (
      _call: ServerUnaryCall<Record<string, never>, ListProjectsResponse>,
      callback: sendUnaryData<ListProjectsResponse>,
    ): void => {
      try {
        callback(null, { projects: db.projects.list() });
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    listEnvs: (
      call: ServerUnaryCall<ListEnvsRequest, ListEnvsResponse>,
      callback: sendUnaryData<ListEnvsResponse>,
    ): void => {
      try {
        db.projects.getRequired(call.request.projectId);
        callback(null, { envs: db.envs.listByProject(call.request.projectId) });
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    listCases: (
      call: ServerUnaryCall<ListCasesRequest, ListCasesResponse>,
      callback: sendUnaryData<ListCasesResponse>,
    ): void => {
      try {
        db.projects.getRequired(call.request.projectId);
        callback(null, {
          cases: db.cases.listByProject(call.request.projectId, call.request.status),
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    getCase: (
      call: ServerUnaryCall<GetCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ): void => {
      try {
        callback(null, db.cases.getRequired(call.request.caseId));
      } catch (err) {
        callback(toGrpcError(err));
      }
    },
  } as unknown as HpathServer;
}

export function createHpathService(
  mode: ServerMode,
  store?: MockStore,
  db?: HpathDb,
): HpathServer {
  if (mode === "mock") {
    if (!store) {
      throw new Error("mock mode requires a store");
    }
    return createMockHandlers(store);
  }
  if (!db) {
    throw new Error("real mode requires a database (HpathDb)");
  }
  return createRealHandlers(db);
}
