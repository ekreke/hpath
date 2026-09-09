// Handler dispatch: chooses between the mock implementation (--mock, default)
// and the real one (SQLite-backed). Real mode serves the read path
// (ListProjects/ListEnvs/ListCases/GetCase/ListRuns), project create/update/
// cascade-delete, manual case management (CreateCase/UpdateCase/DeleteCase),
// the review workflow (ReviewCase), settings, status chat + chat sessions
// (chat.ts), the T8 run execution path (RunCase via the AgentKernel, GetRun,
// DownloadArtifact via the artifact store) and the T9 PRD analysis path
// (ParsePRD via the analyze-agent). Every other method reports UNIMPLEMENTED
// until its wiring task lands.

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
  CreateCaseRequest,
  CreateChatSessionRequest,
  CreateProjectRequest,
  DeleteCaseRequest,
  DeleteChatSessionRequest,
  DeleteEnvRequest,
  DeleteProjectRequest,
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
  ReviewCaseRequest,
  UpdateCaseRequest,
  UpdateProjectRequest,
  UpsertEnvRequest,
} from "@hpath/contract";
import { CaseStatus, CreatorType, Empty, ReviewAction, RunStatus } from "@hpath/contract";
import type { MockStore } from "../mock/store.js";
import { createMockHandlers } from "../mock/handlers.js";
import { ChatService } from "../chat.js";
import { InvalidSettingsError, parseSettingsJson, type SettingsStore } from "../settings.js";
import type { BrowserPool } from "../agents/providers/browser-pool.js";
import type { HpathDb } from "../db/index.js";
import type { AgentKernel } from "../agents/pipeline.js";
import type { ArtifactStore } from "../artifacts/store.js";
import type { ArtifactIndex } from "../artifacts/artifact-index.js";
import { grpcError, toGrpcError } from "./errors.js";
import { createParsePrdHandler } from "./prd-analysis.js";
import {
  createDeleteAssetHandler,
  createGetAssetHandler,
  createListAssetsHandler,
  createUploadAssetHandler,
} from "./assets.js";
import {
  createDownloadArtifactHandler,
  createGetRunHandler,
  createRunCaseHandler,
  createRunControlHandler,
  createWatchRunHandler,
  type RunExecutionDeps,
} from "./run-execution.js";
import { RunFrameHubRegistry } from "../agents/frames.js";

export type ServerMode = "mock" | "real";

/** Real-mode execution deps (T8). Absent deps leave the run path
 * UNIMPLEMENTED so the server still boots for read-only testing. */
export interface RealExecutionDeps {
  kernel?: AgentKernel;
  artifactStore?: ArtifactStore;
  artifactIndex?: ArtifactIndex;
  /** Warm chromium pool (T23): UpdateSettings resizes it live. */
  browserPool?: BrowserPool;
}

function unimplemented(): ServiceError {
  return grpcError(
    status.UNIMPLEMENTED,
    "not wired in real mode yet; served today: ListProjects/CreateProject/UpdateProject/DeleteProject/ListEnvs/ListCases/CreateCase/UpdateCase/DeleteCase/GetCase/ReviewCase/ListRuns/RunCase/PauseRun/ResumeRun/CancelRun/WatchRun/GetRun/DownloadArtifact/ParsePRD/UploadAsset/ListAssets/GetAsset/DeleteAsset/GetSettings/UpdateSettings/Chat + chat session bookkeeping — start with --mock for the full contract",
  );
}

/**
 * Case invariants the run path depends on: the execute-agent's input schema
 * requires at least one alignment (minItems 1) and each alignment carries a
 * non-empty rule. Enforcing it at create/update time keeps a case runnable
 * for its whole lifecycle instead of failing at the kernel's run-input
 * validation, far from the cause.
 */
function assertAlignments(alignments: { rule?: string | null }[]): void {
  if (alignments.length === 0) {
    throw grpcError(status.INVALID_ARGUMENT, "at least one alignment is required");
  }
  const emptyRule = alignments.findIndex((alignment) => !alignment.rule || alignment.rule.trim() === "");
  if (emptyRule !== -1) {
    throw grpcError(
      status.INVALID_ARGUMENT,
      `alignment #${emptyRule + 1} needs a non-empty rule (the PRD logic the run must verify)`,
    );
  }
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
    updateProject: unary,
    deleteProject: unary,
    listEnvs: unary,
    upsertEnv: unary,
    deleteEnv: unary,
    parsePrd: streaming,
    listCases: unary,
    createCase: unary,
    updateCase: unary,
    deleteCase: unary,
    getCase: unary,
    reviewCase: unary,
    runCase: streaming,
    pauseRun: unary,
    resumeRun: unary,
    cancelRun: unary,
    getRun: unary,
    downloadArtifact: streaming,
    getSettings: unary,
    updateSettings: unary,
    chat: streaming,
  } as unknown as HpathServer;
}

/**
 * Real-mode handlers: the SQLite read path, CreateProject, settings, status
 * chat + chat sessions, the T8 run execution path (RunCase through the
 * AgentKernel, GetRun, DownloadArtifact through the artifact store) and the
 * T9 PRD analysis path (ParsePRD through the analyze-agent) when execution
 * deps are provided.
 */
function createRealHandlers(db: HpathDb, settings: SettingsStore, execution?: RealExecutionDeps): HpathServer {
  const chat = new ChatService(db, settings);
  // One live-view registry per server: RunCase handlers create per-run hubs,
  // the WatchRun handler consumes from them (T21).
  const frameHubs = new RunFrameHubRegistry();
  const runDeps: RunExecutionDeps | undefined =
    execution?.kernel && execution.artifactStore && execution.artifactIndex
      ? {
        db,
        kernel: execution.kernel,
        artifactStore: execution.artifactStore,
        artifactIndex: execution.artifactIndex,
        frameHubs,
      }
      : undefined;
  return {
    ...createUnimplementedHandlers(),

    ...(runDeps
      ? {
        runCase: createRunCaseHandler(runDeps),
        pauseRun: createRunControlHandler(runDeps, "pause"),
        resumeRun: createRunControlHandler(runDeps, "resume"),
        cancelRun: createRunControlHandler(runDeps, "cancel"),
        getRun: createGetRunHandler(runDeps),
        downloadArtifact: createDownloadArtifactHandler(runDeps),
        parsePrd: createParsePrdHandler(runDeps),
        watchRun: createWatchRunHandler(runDeps),
        uploadAsset: createUploadAssetHandler(runDeps),
        listAssets: createListAssetsHandler(runDeps),
        getAsset: createGetAssetHandler(runDeps),
        deleteAsset: createDeleteAssetHandler(runDeps),
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

    updateProject: (
      call: ServerUnaryCall<UpdateProjectRequest, Project>,
      callback: sendUnaryData<Project>,
    ): void => {
      try {
        const { projectId, name } = call.request;
        if (!name) {
          throw grpcError(status.INVALID_ARGUMENT, "name is required");
        }
        callback(null, db.projects.update(projectId, { name, repoUrl: call.request.repoUrl ?? "" }));
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    deleteProject: (
      call: ServerUnaryCall<DeleteProjectRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ): void => {
      void (async () => {
        try {
          const removed = db.projects.removeCascade(call.request.projectId);
          const store = execution?.artifactStore;
          if (store) {
            // Best-effort byte purge after the committed metadata delete: the
            // database is the source of truth, leftover bytes are harmless
            // orphans and must not fail the RPC.
            await Promise.all(removed.artifactKeys.map((key) => store.remove(key).catch(() => {})));
          }
          callback(null, Empty.create());
        } catch (err) {
          callback(toGrpcError(err));
        }
      })();
    },

    getSettings: (
      _call: ServerUnaryCall<Record<string, never>, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ): void => {
      const doc = settings.get();
      callback(null, {
        providerConfigJson: JSON.stringify(doc, null, 2),
        defaultModel: doc.defaultModel,
        browserPoolSize: settings.browserPoolSize(),
      });
    },

    updateSettings: (
      call: ServerUnaryCall<AppSettings, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ): void => {
      try {
        const saved = settings.update(
          parseSettingsJson(call.request.providerConfigJson, call.request.defaultModel, call.request.browserPoolSize),
        );
        // T23: apply the new warm pool size live (grow prewarms, shrink closes
        // surplus idle browsers; leased ones close on release).
        void execution?.browserPool?.resize(saved.browserPool);
        callback(null, {
          providerConfigJson: JSON.stringify(saved, null, 2),
          defaultModel: saved.defaultModel,
          browserPoolSize: saved.browserPool,
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
        // Per-env agent hard-limit overrides: 0 = "use agent defaults", but a
        // negative value is always a client bug — reject it here so bad input
        // never reaches the repository or the kernel. The timeout is authored
        // in minutes and capped at one day so a typo can't disable the cap.
        const limits = env.agentLimits;
        if (
          limits &&
          (limits.maxSteps < 0 || limits.tokenBudget < 0 || limits.timeoutMin < 0 || limits.timeoutMin > 1440)
        ) {
          throw grpcError(status.INVALID_ARGUMENT, "env agent limits must be >= 0 (timeout_min <= 1440)");
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

    createCase: (
      call: ServerUnaryCall<CreateCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ): void => {
      try {
        const req = call.request;
        if (!req.title) {
          throw grpcError(status.INVALID_ARGUMENT, "title is required");
        }
        if (!req.goal) {
          throw grpcError(status.INVALID_ARGUMENT, "goal is required");
        }
        db.projects.getRequired(req.projectId);
        assertAlignments(req.alignments ?? []);
        const now = new Date().toISOString();
        const kase: Case = {
          id: randomUUID(),
          projectId: req.projectId,
          title: req.title,
          goal: req.goal,
          alignments: req.alignments ?? [],
          creator: { type: CreatorType.CREATOR_TYPE_HUMAN, name: "human", runRef: "" },
          status: CaseStatus.CASE_STATUS_PENDING,
          sourcePrdRef: "",
          version: 1,
          changelog: [
            { version: 1, author: "human", comment: "Created manually", changedAt: now },
          ],
          createdAt: now,
          updatedAt: now,
        };
        callback(null, db.cases.create(kase));
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    updateCase: (
      call: ServerUnaryCall<UpdateCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ): void => {
      try {
        const req = call.request;
        if (!req.title) {
          throw grpcError(status.INVALID_ARGUMENT, "title is required");
        }
        if (!req.goal) {
          throw grpcError(status.INVALID_ARGUMENT, "goal is required");
        }
        // The alignment invariant is enforced inside the repository, after the
        // status check — an APPROVED/DISABLED case reports its editability
        // before the payload is judged.
        callback(
          null,
          db.cases.update(req.caseId, {
            title: req.title,
            goal: req.goal,
            alignments: req.alignments ?? [],
          }),
        );
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    deleteCase: (
      call: ServerUnaryCall<DeleteCaseRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ): void => {
      try {
        db.cases.delete(call.request.caseId);
        callback(null, Empty.create());
      } catch (err) {
        callback(toGrpcError(err));
      }
    },

    reviewCase: (
      call: ServerUnaryCall<ReviewCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ): void => {
      try {
        const req = call.request;
        if (req.action === ReviewAction.REVIEW_ACTION_UNSPECIFIED) {
          throw grpcError(status.INVALID_ARGUMENT, "review action is required");
        }
        callback(
          null,
          db.cases.review(req.caseId, req.action, {
            author: "reviewer",
            comment: req.comment || undefined,
          }),
        );
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
