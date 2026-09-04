// Handler dispatch: chooses between the mock implementation (--mock, default)
// and the real one (SQLite-backed). Real mode serves the read path
// (ListProjects/ListEnvs/ListCases/GetCase/ListRuns), project creation,
// settings, status chat + chat sessions (chat.ts) and the T8 run execution
// path (RunCase via the AgentKernel, GetRun, DownloadArtifact via the
// artifact store). Every other method reports UNIMPLEMENTED until its wiring
// task lands (PRD parse in T9).

import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import type {
  sendUnaryData,
  ServerUnaryCall,
  ServerWritableStream,
  ServiceError,
} from "@grpc/grpc-js";
import type {
  AppSettings,
  Case,
  ChatRequest,
  ChatResponse,
  ChatSession,
  CreateChatSessionRequest,
  CreateProjectRequest,
  DeleteChatSessionRequest,
  DeleteEnvRequest,
  Env,
  GetCaseRequest,
  HpathServer,
  ListCasesRequest,
  ListCasesResponse,
  ListChatMessagesRequest,
  ListChatMessagesResponse,
  ListChatSessionsResponse,
  ListEnvsRequest,
  ListEnvsResponse,
  ListProjectsResponse,
  ListRunsRequest,
  ListRunsResponse,
  Project,
  UpsertEnvRequest,
} from "@hpath/contract";
import { Empty, RunStatus } from "@hpath/contract";
import type { MockStore } from "../mock/store.js";
import { createMockHandlers } from "../mock/handlers.js";
import { ChatService } from "../chat.js";
import { InvalidSettingsError, parseSettingsJson, type SettingsStore } from "../settings.js";
import type { HpathDb } from "../db/index.js";
import type { AgentKernel } from "../agents/pipeline.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactIndex } from "../artifacts/artifact-index.js";
import { grpcError, toGrpcError } from "./errors.js";
import {
  createDownloadArtifactHandler,
  createGetRunHandler,
  createRunCaseHandler,
  type RunExecutionDeps,
} from "./run-execution.js";

export type ServerMode = "mock" | "real";

/** Real-mode execution deps (T8). Absent deps leave the run path
 * UNIMPLEMENTED so the server still boots for read-only testing. */
export interface RealExecutionDeps {
  kernel?: AgentKernel;
  artifactStore?: ArtifactStore;
  artifactIndex?: ArtifactIndex;
}

function unimplemented(): ServiceError {
  return grpcError(
    status.UNIMPLEMENTED,
    "not wired in real mode yet (SPEC T9+); served today: ListProjects/CreateProject/ListEnvs/ListCases/GetCase/ListRuns/RunCase/GetRun/DownloadArtifact/GetSettings/UpdateSettings/Chat + chat session bookkeeping — start with --mock for the full contract",
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
    getRun: unary,
    downloadArtifact: streaming,
    getSettings: unary,
    updateSettings: unary,
    chat: streaming,
  } as unknown as HpathServer;
}

/**
 * Real-mode handlers: the SQLite read path, CreateProject, settings, status
 * chat + chat sessions, and the T8 run execution path (RunCase through the
 * AgentKernel, GetRun, DownloadArtifact through the artifact store) when
 * execution deps are provided.
 */
function createRealHandlers(db: HpathDb, settings: SettingsStore, execution?: RealExecutionDeps): HpathServer {
  const chat = new ChatService(db, settings);
  const runDeps: RunExecutionDeps | undefined =
    execution?.kernel && execution.artifactStore && execution.artifactIndex
      ? {
        db,
        kernel: execution.kernel,
        artifactStore: execution.artifactStore,
        artifactIndex: execution.artifactIndex,
      }
      : undefined;
  return {
    ...createUnimplementedHandlers(),

    ...(runDeps
      ? {
        runCase: createRunCaseHandler(runDeps),
        getRun: createGetRunHandler(runDeps),
        downloadArtifact: createDownloadArtifactHandler(runDeps),
      }
      : {}),

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

    getSettings: (
      _call: ServerUnaryCall<Record<string, never>, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ): void => {
      const doc = settings.get();
      callback(null, {
        providerConfigJson: JSON.stringify(doc, null, 2),
        defaultModel: doc.defaultModel,
      });
    },

    updateSettings: (
      call: ServerUnaryCall<AppSettings, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ): void => {
      try {
        const saved = settings.update(parseSettingsJson(call.request.providerConfigJson, call.request.defaultModel));
        callback(null, {
          providerConfigJson: JSON.stringify(saved, null, 2),
          defaultModel: saved.defaultModel,
        });
      } catch (err) {
        if (err instanceof InvalidSettingsError) {
          callback(grpcError(status.INVALID_ARGUMENT, err.message));
          return;
        }
        callback(toGrpcError(err));
      }
    },

    chat: (call: ServerWritableStream<ChatRequest, ChatResponse>): void => {
      void (async () => {
        try {
          for await (const response of chat.respond(call.request.sessionId, call.request.message)) {
            if (call.cancelled) return;
            call.write(response);
          }
          call.end();
        } catch (err) {
          call.emit("error", toGrpcError(err));
        }
      })();
    },

    createChatSession: (
      call: ServerUnaryCall<CreateChatSessionRequest, ChatSession>,
      callback: sendUnaryData<ChatSession>,
    ): void => {
      try {
        const now = new Date().toISOString();
        const session: ChatSession = {
          id: randomUUID(),
          title: call.request.title?.trim() ?? "",
          createdAt: now,
          updatedAt: now,
        };
        db.chatSessions.insert(session);
        callback(null, session);
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    listChatSessions: (
      _call: ServerUnaryCall<Record<string, never>, ListChatSessionsResponse>,
      callback: sendUnaryData<ListChatSessionsResponse>,
    ): void => {
      try {
        callback(null, { sessions: db.chatSessions.list() });
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    deleteChatSession: (
      call: ServerUnaryCall<DeleteChatSessionRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ): void => {
      try {
        db.chatSessions.getRequired(call.request.sessionId);
        db.chatSessions.delete(call.request.sessionId);
        callback(null, Empty.create());
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    listChatMessages: (
      call: ServerUnaryCall<ListChatMessagesRequest, ListChatMessagesResponse>,
      callback: sendUnaryData<ListChatMessagesResponse>,
    ): void => {
      try {
        db.chatSessions.getRequired(call.request.sessionId);
        callback(null, { messages: db.chatMessages.listBySession(call.request.sessionId) });
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

    upsertEnv: (
      call: ServerUnaryCall<UpsertEnvRequest, Env>,
      callback: sendUnaryData<Env>,
    ): void => {
      try {
        const env = call.request.env;
        if (!env) {
          throw grpcError(status.INVALID_ARGUMENT, "env is required");
        }
        if (env.id === "") {
          db.projects.getRequired(env.projectId);
          callback(null, db.envs.create({ ...env, id: randomUUID() }));
          return;
        }
        callback(null, db.envs.update(env));
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    deleteEnv: (
      call: ServerUnaryCall<DeleteEnvRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ): void => {
      try {
        db.envs.delete(call.request.envId);
        callback(null, Empty.create());
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

    // Run history (T8). Mirrors the mock handler: validate the project exists
    // first (so a stale projectId surfaces as NOT_FOUND with the same shape
    // every other call uses), then delegate the filtered query to the
    // repository. Empty-string filters are treated as "no filter", matching
    // the wire convention.
    listRuns: (
      call: ServerUnaryCall<ListRunsRequest, ListRunsResponse>,
      callback: sendUnaryData<ListRunsResponse>,
    ): void => {
      try {
        const req = call.request;
        db.projects.getRequired(req.projectId);
        const runs = db.runs.list({
          projectId: req.projectId,
          envId: req.envId || undefined,
          caseId: req.caseId || undefined,
          status: req.status === RunStatus.RUN_STATUS_UNSPECIFIED ? undefined : req.status,
          from: req.from || undefined,
          to: req.to || undefined,
        });
        callback(null, { runs });
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
  settings?: SettingsStore,
  execution?: RealExecutionDeps,
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
  if (!settings) {
    throw new Error("real mode requires a settings store (SettingsStore)");
  }
  return createRealHandlers(db, settings, execution);
}
