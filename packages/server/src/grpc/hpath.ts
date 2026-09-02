// Handler dispatch: chooses between the mock implementation (--mock, default)
// and the real one (real implementations land in T5+; every method reports
// UNIMPLEMENTED until then).

import { status } from "@grpc/grpc-js";
import type { ServiceError } from "@grpc/grpc-js";
import type { HpathServer } from "../gen/hpath/v1/hpath.js";
import type { MockStore } from "../mock/store.js";
import { createMockHandlers, grpcError } from "../mock/handlers.js";

export type ServerMode = "mock" | "real";

function unimplemented(): ServiceError {
  return grpcError(status.UNIMPLEMENTED, "real server implementation not built yet (SPEC T5+); start with --mock");
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

export function createHpathService(mode: ServerMode, store?: MockStore): HpathServer {
  if (mode === "mock") {
    if (!store) {
      throw new Error("mock mode requires a store");
    }
    return createMockHandlers(store);
  }
  return createUnimplementedHandlers();
}
