// Mock implementations of the Hpath service against the in-memory store.
// Method names/signatures follow the generated `HpathServer` interface.

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
  BytesChunk,
  ChatRequest,
  ChatResponse,
  HpathServer,
  Event,
  ParseEvent,
  ParsePRDRequest,
  GetCaseRequest,
  GetRunRequest,
  ListCasesRequest,
  ListCasesResponse,
  ListEnvsRequest,
  ListEnvsResponse,
  ListProjectsResponse,
  ListRunsRequest,
  ListRunsResponse,
  CreateProjectRequest,
  DeleteEnvRequest,
  DownloadArtifactRequest,
  Project,
  Prd,
  RunDetail,
  UpsertEnvRequest,
  ReviewCaseRequest,
  RunCaseRequest,
  Env,
} from "@hpath/contract";
import {
  ArtifactKind,
  CaseStatus,
  CreatorType,
  Empty,
  PrdFormat,
  ReviewAction,
  RunTrigger,
} from "@hpath/contract";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";
import { simulateRun, type RunOutcome } from "./run-script.js";

function grpcError(code: status, message: string): ServiceError {
  return { code, details: message, message, name: "ServiceError" } as ServiceError;
}

function requireProject(store: MockStore, projectId: string): Project {
  const project = store.projects.get(projectId);
  if (!project) {
    throw grpcError(status.NOT_FOUND, `project not found: ${projectId}`);
  }
  return project;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Title-keyword convention for live mock runs (T12): seeded probe cases opt
// into scripted outcomes by title so every panel path is demoable — "limit"
// hits the step budget, "fail"/"drift" break alignment; everything else
// (incl. the smoke suite's Login case) passes on any env.
function outcomeForTitle(title: string): RunOutcome {
  const t = title.toLowerCase();
  if (t.includes("limit")) return "limit";
  if (t.includes("fail") || t.includes("drift")) return "fail";
  return "pass";
}

const CHUNK_SIZE = 64 * 1024;

export function createMockHandlers(store: MockStore): HpathServer {
  return {
    // ------------------------------------------------------------------
    // Projects
    // ------------------------------------------------------------------
    listProjects: (
      _call: ServerUnaryCall<Empty, ListProjectsResponse>,
      callback: sendUnaryData<ListProjectsResponse>,
    ) => {
      callback(null, { projects: [...store.projects.values()] });
    },

    createProject: (
      call: ServerUnaryCall<CreateProjectRequest, Project>,
      callback: sendUnaryData<Project>,
    ) => {
      try {
        const { name, repoUrl } = call.request;
        if (!name) {
          throw grpcError(status.INVALID_ARGUMENT, "name is required");
        }
        const project: Project = { id: randomUUID(), name, repoUrl, createdAt: nowIso() };
        store.projects.set(project.id, project);
        callback(null, project);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    // ------------------------------------------------------------------
    // Envs
    // ------------------------------------------------------------------
    listEnvs: (
      call: ServerUnaryCall<ListEnvsRequest, ListEnvsResponse>,
      callback: sendUnaryData<ListEnvsResponse>,
    ) => {
      try {
        requireProject(store, call.request.projectId);
        const envs = [...store.envs.values()].filter((env) => env.projectId === call.request.projectId);
        callback(null, { envs });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    upsertEnv: (
      call: ServerUnaryCall<UpsertEnvRequest, Env>,
      callback: sendUnaryData<Env>,
    ) => {
      try {
        const env = call.request.env;
        if (!env) {
          throw grpcError(status.INVALID_ARGUMENT, "env is required");
        }
        requireProject(store, env.projectId);
        if (env.id === "") {
          const created: Env = { ...env, id: randomUUID() };
          store.envs.set(created.id, created);
          callback(null, created);
          return;
        }
        const existing = store.envs.get(env.id);
        if (!existing) {
          throw grpcError(status.NOT_FOUND, `env not found: ${env.id}`);
        }
        const updated: Env = { ...env };
        store.envs.set(updated.id, updated);
        callback(null, updated);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    deleteEnv: (
      call: ServerUnaryCall<DeleteEnvRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ) => {
      try {
        const { envId } = call.request;
        const env = store.envs.get(envId);
        if (!env) {
          throw grpcError(status.NOT_FOUND, `env not found: ${envId}`);
        }
        const hasRuns = [...store.runs.values()].some((run) => run.envId === envId);
        if (hasRuns) {
          throw grpcError(status.ALREADY_EXISTS, "env has runs and cannot be deleted");
        }
        store.envs.delete(envId);
        callback(null, Empty.create());
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    // ------------------------------------------------------------------
    // PRD parse (analyze agent, mocked)
    // ------------------------------------------------------------------
    parsePrd: (call: ServerWritableStream<ParsePRDRequest, ParseEvent>) => {
      void (async () => {
        try {
          const req = call.request;
          requireProject(store, req.projectId);
          if (req.content.byteLength === 0) {
            throw grpcError(status.INVALID_ARGUMENT, "content is required");
          }
          const prd: Prd = {
            id: randomUUID(),
            projectId: req.projectId,
            filename: req.filename,
            format: req.format === PrdFormat.PRD_FORMAT_UNSPECIFIED ? PrdFormat.PRD_FORMAT_MD : req.format,
            sizeBytes: req.content.byteLength,
            createdAt: nowIso(),
            contentRef: "",
          };
          store.prds.set(prd.id, prd);
          call.write({ prdRegistered: { prd } });
          await sleep(150);
          call.write({ thinking: { text: `Reading ${req.filename} and identifying testable behaviors.` } });
          await sleep(150);
          call.write({ progress: { pct: 30, message: "Extracting requirements" } });
          await sleep(150);
          call.write({ progress: { pct: 70, message: "Drafting cases" } });
          await sleep(150);

          const draft: Case = {
            id: randomUUID(),
            projectId: req.projectId,
            title: `Auto-draft: ${req.filename}`,
            goal: `Verify the behaviors described in ${req.filename} through three-way alignment of PRD, UI and backend.`,
            alignments: [
              {
                apiPath: "/api/example",
                uiAnchor: "Primary result card",
                rule: "UI display equals the API response and satisfies the PRD rule.",
              },
            ],
            creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent", runRef: `analyze-run#${prd.id.slice(0, 8)}` },
            status: CaseStatus.CASE_STATUS_PENDING,
            sourcePrdRef: `${req.filename}#auto`,
            version: 1,
            changelog: [
              { version: 1, author: "analyze-agent", comment: "Drafted from PRD by mock analyze agent", changedAt: nowIso() },
            ],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          store.cases.set(draft.id, draft);
          call.write({ draftsCreated: { caseIds: [draft.id], cases: [draft] } });
          call.end();
        } catch (err) {
          call.emit("error", err as ServiceError);
        }
      })();
    },

    // ------------------------------------------------------------------
    // Cases
    // ------------------------------------------------------------------
    listCases: (
      call: ServerUnaryCall<ListCasesRequest, ListCasesResponse>,
      callback: sendUnaryData<ListCasesResponse>,
    ) => {
      try {
        requireProject(store, call.request.projectId);
        const statusFilter = call.request.status;
        const cases = [...store.cases.values()].filter(
          (kase) =>
            kase.projectId === call.request.projectId &&
            (statusFilter === CaseStatus.CASE_STATUS_UNSPECIFIED || kase.status === statusFilter),
        );
        callback(null, { cases });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    getCase: (
      call: ServerUnaryCall<GetCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ) => {
      try {
        const kase = store.cases.get(call.request.caseId);
        if (!kase) {
          throw grpcError(status.NOT_FOUND, `case not found: ${call.request.caseId}`);
        }
        callback(null, kase);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    reviewCase: (
      call: ServerUnaryCall<ReviewCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ) => {
      try {
        const kase = store.cases.get(call.request.caseId);
        if (!kase) {
          throw grpcError(status.NOT_FOUND, `case not found: ${call.request.caseId}`);
        }
        const action = call.request.action;
        const transitions: Partial<Record<ReviewAction, { from: CaseStatus[]; to: CaseStatus }>> = {
          [ReviewAction.REVIEW_ACTION_APPROVE]: {
            from: [CaseStatus.CASE_STATUS_DRAFT, CaseStatus.CASE_STATUS_PENDING, CaseStatus.CASE_STATUS_DISABLED],
            to: CaseStatus.CASE_STATUS_APPROVED,
          },
          [ReviewAction.REVIEW_ACTION_REJECT]: { from: [CaseStatus.CASE_STATUS_PENDING], to: CaseStatus.CASE_STATUS_DRAFT },
          [ReviewAction.REVIEW_ACTION_DISABLE]: { from: [CaseStatus.CASE_STATUS_APPROVED], to: CaseStatus.CASE_STATUS_DISABLED },
        };
        const transition = transitions[action];
        if (!transition) {
          throw grpcError(status.INVALID_ARGUMENT, "review action is required");
        }
        if (!transition.from.includes(kase.status)) {
          throw grpcError(
            status.FAILED_PRECONDITION,
            `cannot ${ReviewAction[action].toLowerCase()} a case in status ${CaseStatus[kase.status]}`,
          );
        }
        kase.status = transition.to;
        kase.version += 1;
        kase.updatedAt = nowIso();
        kase.changelog.push({
          version: kase.version,
          author: "reviewer",
          comment: call.request.comment || `${ReviewAction[action]} via review`,
          changedAt: nowIso(),
        });
        callback(null, kase);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------
    runCase: (call: ServerWritableStream<RunCaseRequest, Event>) => {
      void (async () => {
        try {
          const req = call.request;
          const project = requireProject(store, req.projectId);
          const env = store.envs.get(req.envId);
          if (!env || env.projectId !== req.projectId) {
            throw grpcError(status.NOT_FOUND, `env not found in project: ${req.envId}`);
          }
          const kase = store.cases.get(req.caseId);
          if (!kase || kase.projectId !== req.projectId) {
            throw grpcError(status.NOT_FOUND, `case not found in project: ${req.caseId}`);
          }
          if (kase.status !== CaseStatus.CASE_STATUS_APPROVED) {
            throw grpcError(status.FAILED_PRECONDITION, "only APPROVED cases can run");
          }
          await simulateRun({
            store,
            project,
            env,
            kase,
            trigger: req.trigger === RunTrigger.RUN_TRIGGER_UNSPECIFIED ? RunTrigger.RUN_TRIGGER_MANUAL : req.trigger,
            // Title-keyword convention so the desktop run panel (T12) can
            // demo every scripted outcome; see outcomeForTitle.
            outcome: outcomeForTitle(kase.title),
            delayMs: 400,
            onEvent: (event) => {
              if (!call.cancelled) {
                call.write(event);
              }
            },
          });
          call.end();
        } catch (err) {
          call.emit("error", err as ServiceError);
        }
      })();
    },

    listRuns: (
      call: ServerUnaryCall<ListRunsRequest, ListRunsResponse>,
      callback: sendUnaryData<ListRunsResponse>,
    ) => {
      try {
        requireProject(store, call.request.projectId);
        const req = call.request;
        const runs = [...store.runs.values()].filter((run) => {
          if (run.projectId !== req.projectId) return false;
          if (req.envId !== "" && run.envId !== req.envId) return false;
          if (req.caseId !== "" && run.caseId !== req.caseId) return false;
          if (req.status !== 0 && run.status !== req.status) return false;
          if (req.from !== "" && run.startedAt < req.from) return false;
          if (req.to !== "" && run.startedAt > req.to) return false;
          return true;
        });
        callback(null, { runs });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    getRun: (
      call: ServerUnaryCall<GetRunRequest, RunDetail>,
      callback: sendUnaryData<RunDetail>,
    ) => {
      try {
        const run = store.runs.get(call.request.runId);
        if (!run) {
          throw grpcError(status.NOT_FOUND, `run not found: ${call.request.runId}`);
        }
        const artifacts = [...store.artifacts.values()].filter((artifact) => artifact.runId === run.id);
        callback(null, { run, events: store.events.get(run.id) ?? [], artifacts });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    downloadArtifact: (call: ServerWritableStream<DownloadArtifactRequest, BytesChunk>) => {
      const artifact = store.artifacts.get(call.request.artifactId);
      if (!artifact) {
        call.emit("error", grpcError(status.NOT_FOUND, `artifact not found: ${call.request.artifactId}`));
        return;
      }
      const data = store.artifactData.get(artifact.id);
      if (!data) {
        call.emit("error", grpcError(status.NOT_FOUND, "artifact data missing"));
        return;
      }
      for (let offset = 0; offset < data.byteLength; offset += CHUNK_SIZE) {
        if (call.cancelled) return;
        const length = Math.min(CHUNK_SIZE, data.byteLength - offset);
        call.write({ data: Buffer.from(data.buffer, data.byteOffset + offset, length) });
      }
      call.end();
    },

    // ------------------------------------------------------------------
    // Settings & chat (mock: in-memory settings, scripted chat answer)
    // ------------------------------------------------------------------
    getSettings: (
      _call: ServerUnaryCall<Empty, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ) => {
      callback(null, { ...store.settings });
    },

    updateSettings: (
      call: ServerUnaryCall<AppSettings, AppSettings>,
      callback: sendUnaryData<AppSettings>,
    ) => {
      try {
        const next = call.request;
        // Shape checks only (real mode validates against the full schema):
        // the JSON must parse and defaultModel must not be empty. Mock mode
        // has no provider runtime, so multimodal enforcement is a no-op.
        try {
          const parsed = JSON.parse(next.providerConfigJson || "{}") as { defaultModel?: unknown };
          if (!next.defaultModel && typeof parsed.defaultModel !== "string") {
            throw new Error("defaultModel is required");
          }
        } catch (err) {
          throw grpcError(
            status.INVALID_ARGUMENT,
            `invalid settings: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        store.settings = { providerConfigJson: next.providerConfigJson, defaultModel: next.defaultModel };
        callback(null, { ...store.settings });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    chat: (call: ServerWritableStream<ChatRequest, ChatResponse>) => {
      void (async () => {
        try {
          const question = call.request.message?.trim();
          if (!question) {
            throw grpcError(status.INVALID_ARGUMENT, "message is required");
          }
          call.write({
            status: { model: "mock-model", promptTokensEst: Math.ceil(question.length / 4) + 96 },
          });
          const deltas = [
            `[mock] You asked: “${question}”. `,
            "In mock mode the chat answers with this canned reply — ",
            "start the server in real mode with a configured provider key to get live answers. ",
            "Snapshot: 1 demo project (dev + staging), 5 cases (4 approved, 1 pending), 2 finished sample runs.",
          ];
          let answered = 0;
          for (const delta of deltas) {
            if (call.cancelled) return;
            answered += delta.length;
            call.write({ textDelta: delta });
            await sleep(120);
          }
          call.write({
            usage: {
              inputTokens: Math.ceil(question.length / 4) + 96,
              outputTokens: Math.ceil(answered / 4),
              costTotal: 0,
            },
          });
          call.end();
        } catch (err) {
          call.emit("error", err as ServiceError);
        }
      })();
    },
  };
}

// Re-exported so dispatch module can share the helper.
export { grpcError };
export type { ServerUnaryCall, ServerWritableStream, sendUnaryData };
