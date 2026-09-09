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
  Asset,
  AssetFile,
  Case,
  BytesChunk,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatSession,
  CreateCaseRequest,
  HpathServer,
  Event,
  ParseEvent,
  ParsePRDRequest,
  CreateChatSessionRequest,
  DeleteChatSessionRequest,
  DeleteCaseRequest,
  GetAssetRequest,
  GetCaseRequest,
  GetRunRequest,
  ListAssetsRequest,
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
  CreateProjectRequest,
  DeleteAssetRequest,
  DeleteEnvRequest,
  DeleteProjectRequest,
  DownloadArtifactRequest,
  Project,
  Prd,
  RunControlRequest,
  RunDetail,
  UpdateCaseRequest,
  UpdateProjectRequest,
  UploadAssetRequest,
  UpsertEnvRequest,
  ReviewCaseRequest,
  RunCaseRequest,
  RunFrame,
  WatchRunRequest,
  Env,
} from "@hpath/contract";
import {
  ArtifactKind,
  AssetType,
  CaseStatus,
  ChatRole,
  CreatorType,
  Empty,
  PrdFormat,
  ReviewAction,
  RunStatus,
  RunTrigger,
} from "@hpath/contract";
import type { MockStore } from "./store.js";
import { nowIso } from "./store.js";
import { simulateRun, type RunController, type RunOutcome } from "./run-script.js";
import { ProtoBundleError, parseProtoBundle } from "../assets/proto-doc.js";
import type { Run } from "@hpath/contract";

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

/**
 * Same invariant as the real repository: the execute-agent's input schema
 * requires at least one alignment with a non-empty rule, so a case without
 * one could never be run.
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

/** Clear the default flag on every env of a project (keepId stays default). */
function clearProjectDefault(store: MockStore, projectId: string, keepId?: string): void {
  for (const env of store.envs.values()) {
    if (env.projectId === projectId && env.isDefault && env.id !== keepId) {
      store.envs.set(env.id, { ...env, isDefault: false });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalRunStatus(value: RunStatus): boolean {
  return (
    value === RunStatus.RUN_STATUS_PASSED ||
    value === RunStatus.RUN_STATUS_FAILED ||
    value === RunStatus.RUN_STATUS_CANCELLED
  );
}

/** Placeholder live-view frame (T21): a tiny valid jpeg so the desktop live
 * pane has real image bytes to render; the UI overlays the frame counter. */
const MOCK_LIVE_FRAME_JPEG =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
  + "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
  + "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

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

/** Shared implementation of PauseRun/ResumeRun/CancelRun for mock mode:
 * same state-machine semantics as the real handler — NOT_FOUND for unknown
 * runs, FAILED_PRECONDITION for runs that are not in flight or for invalid
 * transitions, and the refreshed Run as the response. */
function mockRunControl(
  store: MockStore,
  controllers: Map<string, RunController>,
  call: ServerUnaryCall<RunControlRequest, Run>,
  callback: sendUnaryData<Run>,
  action: "pause" | "resume" | "cancel",
): void {
  try {
    const runId = call.request.runId;
    const run = store.runs.get(runId);
    if (!run) {
      throw grpcError(status.NOT_FOUND, `run not found: ${runId}`);
    }
    const controller = controllers.get(runId);
    if (!controller) {
      throw grpcError(status.FAILED_PRECONDITION, `run is not active: ${runId}`);
    }
    try {
      controller[action]();
    } catch (err) {
      throw grpcError(status.FAILED_PRECONDITION, (err as Error).message);
    }
    callback(null, store.runs.get(runId) ?? run);
  } catch (err) {
    callback(err as ServiceError);
  }
}

export function createMockHandlers(store: MockStore): HpathServer {
  // run id -> controller of a live scripted run (PauseRun/ResumeRun/CancelRun).
  const runControllers = new Map<string, RunController>();
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

    updateProject: (
      call: ServerUnaryCall<UpdateProjectRequest, Project>,
      callback: sendUnaryData<Project>,
    ) => {
      try {
        const { projectId, name } = call.request;
        if (!name) {
          throw grpcError(status.INVALID_ARGUMENT, "name is required");
        }
        const existing = store.projects.get(projectId);
        if (!existing) {
          throw grpcError(status.NOT_FOUND, `project not found: ${projectId}`);
        }
        const nameTaken = [...store.projects.values()].some((p) => p.id !== projectId && p.name === name);
        if (nameTaken) {
          throw grpcError(status.ALREADY_EXISTS, `project name already exists: ${name}`);
        }
        const updated: Project = { ...existing, name, repoUrl: call.request.repoUrl ?? "" };
        store.projects.set(updated.id, updated);
        callback(null, updated);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    deleteProject: (
      call: ServerUnaryCall<DeleteProjectRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ) => {
      try {
        const { projectId } = call.request;
        if (!store.projects.has(projectId)) {
          throw grpcError(status.NOT_FOUND, `project not found: ${projectId}`);
        }
        // Cascade mirrors the SQLite foreign-key graph: runs carry their
        // events + artifacts, cases carry alignments + changelog.
        const runIds = [...store.runs.values()]
          .filter((run) => run.projectId === projectId)
          .map((run) => run.id);
        for (const runId of runIds) {
          store.events.delete(runId);
          for (const artifact of [...store.artifacts.values()]) {
            if (artifact.runId === runId) {
              store.artifacts.delete(artifact.id);
              store.artifactData.delete(artifact.id);
            }
          }
        }
        for (const [id, env] of [...store.envs.entries()]) {
          if (env.projectId === projectId) store.envs.delete(id);
        }
        for (const [id, kase] of [...store.cases.entries()]) {
          if (kase.projectId === projectId) store.cases.delete(id);
        }
        for (const [id, run] of [...store.runs.entries()]) {
          if (run.projectId === projectId) store.runs.delete(id);
        }
        for (const [id, asset] of [...store.assets.entries()]) {
          if (asset.projectId === projectId) store.assets.delete(id);
        }
        store.projects.delete(projectId);
        callback(null, Empty.create());
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
          // The first env of a project becomes the default automatically.
          const wantsDefault =
            env.isDefault || ![...store.envs.values()].some((e) => e.projectId === env.projectId && e.isDefault);
          if (wantsDefault) {
            clearProjectDefault(store, env.projectId);
          }
          const created: Env = { ...env, id: randomUUID(), isDefault: wantsDefault };
          store.envs.set(created.id, created);
          callback(null, created);
          return;
        }
        const existing = store.envs.get(env.id);
        if (!existing) {
          throw grpcError(status.NOT_FOUND, `env not found: ${env.id}`);
        }
        if (env.isDefault) {
          clearProjectDefault(store, env.projectId, env.id);
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
        // Deleting the default env promotes the project's next env by name,
        // mirroring the SQLite repository.
        if (env.isDefault) {
          const next = [...store.envs.values()]
            .filter((e) => e.projectId === env.projectId)
            .sort((a, b) => a.name.localeCompare(b.name))[0];
          if (next) {
            store.envs.set(next.id, { ...next, isDefault: true });
          }
        }
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
          // The asset library (T22) is the single storage shape; the stream
          // keeps carrying the Prd message (contract parity). The md bytes
          // double as the detail preview text.
          store.assets.set(prd.id, {
            id: prd.id,
            projectId: prd.projectId,
            type: AssetType.ASSET_TYPE_PRD,
            filename: prd.filename,
            sizeBytes: prd.sizeBytes,
            createdAt: prd.createdAt,
            contentRef: "",
            apiDoc: "",
            fileCount: 1,
            textContent: Buffer.from(req.content).toString("utf8"),
          });
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
    // Asset library (T22): proto uploads parsed with the same deterministic
    // parser the real mode uses; PRD uploads ride ParsePRD (rejected here).
    // ------------------------------------------------------------------
    uploadAsset: (
      call: ServerUnaryCall<UploadAssetRequest, Asset>,
      callback: sendUnaryData<Asset>,
    ) => {
      try {
        const req = call.request;
        requireProject(store, req.projectId);
        if (req.type === AssetType.ASSET_TYPE_UNSPECIFIED) {
          throw grpcError(status.INVALID_ARGUMENT, "asset type is required (prd | proto)");
        }
        if (req.type === AssetType.ASSET_TYPE_PRD) {
          throw grpcError(status.INVALID_ARGUMENT, "PRD uploads go through ParsePRD (analyze flow)");
        }
        const files: AssetFile[] = req.files ?? [];
        if (files.length === 0) {
          throw grpcError(status.INVALID_ARGUMENT, "at least one .proto file is required");
        }
        let bundle;
        try {
          bundle = parseProtoBundle(
            files.map((file) => ({ filename: file.filename, content: Buffer.from(file.content) })),
            req.entryFilename || undefined,
          );
        } catch (err) {
          if (err instanceof ProtoBundleError) {
            throw grpcError(status.INVALID_ARGUMENT, err.message);
          }
          throw err;
        }
        const totalBytes = files.reduce((sum, file) => sum + file.content.byteLength, 0);
        const asset: Asset = {
          id: randomUUID(),
          projectId: req.projectId,
          type: AssetType.ASSET_TYPE_PROTO,
          filename: bundle.entryFilename,
          sizeBytes: totalBytes,
          createdAt: nowIso(),
          contentRef: "",
          apiDoc: bundle.apiDoc,
          fileCount: bundle.fileCount,
          textContent: "",
        };
        store.assets.set(asset.id, asset);
        callback(null, asset);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    listAssets: (
      call: ServerUnaryCall<ListAssetsRequest, { assets: Asset[] }>,
      callback: sendUnaryData<{ assets: Asset[] }>,
    ) => {
      try {
        requireProject(store, call.request.projectId);
        const typeFilter = call.request.type;
        const assets = [...store.assets.values()].filter(
          (asset) =>
            asset.projectId === call.request.projectId &&
            (typeFilter === AssetType.ASSET_TYPE_UNSPECIFIED || asset.type === typeFilter),
        );
        callback(null, { assets });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    getAsset: (
      call: ServerUnaryCall<GetAssetRequest, Asset>,
      callback: sendUnaryData<Asset>,
    ) => {
      try {
        const asset = store.assets.get(call.request.assetId);
        if (!asset) {
          throw grpcError(status.NOT_FOUND, `asset not found: ${call.request.assetId}`);
        }
        callback(null, asset);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    deleteAsset: (
      call: ServerUnaryCall<DeleteAssetRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ) => {
      try {
        const { assetId } = call.request;
        if (!store.assets.has(assetId)) {
          throw grpcError(status.NOT_FOUND, `asset not found: ${assetId}`);
        }
        store.assets.delete(assetId);
        callback(null, Empty.create());
      } catch (err) {
        callback(err as ServiceError);
      }
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

    // Manual case management. Mirrors the real-mode handlers and the
    // repository semantics: create lands in PENDING with a human creator,
    // update replaces title/goal/alignments of unapproved cases only (version
    // bump + changelog), delete refuses cases referenced by runs.
    createCase: (
      call: ServerUnaryCall<CreateCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ) => {
      try {
        const req = call.request;
        if (!req.title) {
          throw grpcError(status.INVALID_ARGUMENT, "title is required");
        }
        if (!req.goal) {
          throw grpcError(status.INVALID_ARGUMENT, "goal is required");
        }
        requireProject(store, req.projectId);
        assertAlignments(req.alignments ?? []);
        const now = nowIso();
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
        store.cases.set(kase.id, kase);
        callback(null, kase);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    updateCase: (
      call: ServerUnaryCall<UpdateCaseRequest, Case>,
      callback: sendUnaryData<Case>,
    ) => {
      try {
        const req = call.request;
        if (!req.title) {
          throw grpcError(status.INVALID_ARGUMENT, "title is required");
        }
        if (!req.goal) {
          throw grpcError(status.INVALID_ARGUMENT, "goal is required");
        }
        const kase = store.cases.get(req.caseId);
        if (!kase) {
          throw grpcError(status.NOT_FOUND, `case not found: ${req.caseId}`);
        }
        const editable = [
          CaseStatus.CASE_STATUS_DRAFT,
          CaseStatus.CASE_STATUS_PENDING,
          CaseStatus.CASE_STATUS_DISABLED,
        ];
        if (!editable.includes(kase.status)) {
          throw grpcError(
            status.FAILED_PRECONDITION,
            `cannot edit a case in status ${CaseStatus[kase.status]} (disable it first)`,
          );
        }
        assertAlignments(req.alignments ?? []);
        kase.title = req.title;
        kase.goal = req.goal;
        kase.alignments = req.alignments ?? [];
        kase.version += 1;
        kase.updatedAt = nowIso();
        kase.changelog.push({
          version: kase.version,
          author: "editor",
          comment: "Updated manually",
          changedAt: nowIso(),
        });
        callback(null, kase);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    deleteCase: (
      call: ServerUnaryCall<DeleteCaseRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ) => {
      try {
        const { caseId } = call.request;
        if (!store.cases.has(caseId)) {
          throw grpcError(status.NOT_FOUND, `case not found: ${caseId}`);
        }
        const hasRuns = [...store.runs.values()].some((run) => run.caseId === caseId);
        if (hasRuns) {
          throw grpcError(status.ALREADY_EXISTS, `case has runs and cannot be deleted: ${caseId}`);
        }
        store.cases.delete(caseId);
        callback(null, Empty.create());
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
            control: { registry: runControllers },
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

    pauseRun: (
      call: ServerUnaryCall<RunControlRequest, Run>,
      callback: sendUnaryData<Run>,
    ) => {
      mockRunControl(store, runControllers, call, callback, "pause");
    },

    resumeRun: (
      call: ServerUnaryCall<RunControlRequest, Run>,
      callback: sendUnaryData<Run>,
    ) => {
      mockRunControl(store, runControllers, call, callback, "resume");
    },

    cancelRun: (
      call: ServerUnaryCall<RunControlRequest, Run>,
      callback: sendUnaryData<Run>,
    ) => {
      mockRunControl(store, runControllers, call, callback, "cancel");
    },

    // Live view (T21): synthetic frames on the same 400ms cadence as the
    // scripted run, until the run reaches a terminal status. Frames are
    // ephemeral — nothing is written to the store.
    watchRun: (call: ServerWritableStream<WatchRunRequest, RunFrame>) => {
      void (async () => {
        try {
          const runId = call.request.runId;
          if (!runId) {
            throw grpcError(status.INVALID_ARGUMENT, "run_id is required");
          }
          if (!store.runs.get(runId)) {
            throw grpcError(status.NOT_FOUND, `run not found: ${runId}`);
          }
          let seq = 1;
          for (;;) {
            const current = store.runs.get(runId);
            if (!current || isTerminalRunStatus(current.status) || call.cancelled) break;
            // A paused run freezes the page (no repaints -> no frames in the
            // real CDP path), so the synthetic stream freezes with it.
            if (current.status !== RunStatus.RUN_STATUS_PAUSED) {
              call.write({
                runId,
                seq: seq++,
                mime: "image/jpeg",
                data: Buffer.from(MOCK_LIVE_FRAME_JPEG, "base64"),
                timestampMs: Date.now(),
              });
            }
            await sleep(400);
          }
          if (!call.cancelled) call.end();
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
      callback(null, { browserPoolSize: 0, ...store.settings });
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
        // T23: mock parity for the browser pool size (no live pool to resize —
        // mock mode never launches chromium; the value round-trips only).
        store.settings = {
          providerConfigJson: next.providerConfigJson,
          defaultModel: next.defaultModel,
          browserPoolSize: next.browserPoolSize,
        };
        callback(null, { browserPoolSize: 0, ...store.settings });
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    // ------------------------------------------------------------------
    // Chat sessions (mock mirrors the real mode's persistence in memory)
    // ------------------------------------------------------------------
    createChatSession: (
      call: ServerUnaryCall<CreateChatSessionRequest, ChatSession>,
      callback: sendUnaryData<ChatSession>,
    ) => {
      try {
        const now = nowIso();
        const session: ChatSession = {
          id: randomUUID(),
          title: call.request.title?.trim() ?? "",
          createdAt: now,
          updatedAt: now,
        };
        store.chatSessions.set(session.id, session);
        callback(null, session);
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    listChatSessions: (
      _call: ServerUnaryCall<Empty, ListChatSessionsResponse>,
      callback: sendUnaryData<ListChatSessionsResponse>,
    ) => {
      const sessions = [...store.chatSessions.values()].sort((a, b) =>
        a.updatedAt === b.updatedAt ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt),
      );
      callback(null, { sessions });
    },

    deleteChatSession: (
      call: ServerUnaryCall<DeleteChatSessionRequest, { [key: string]: never }>,
      callback: sendUnaryData<Empty>,
    ) => {
      try {
        const { sessionId } = call.request;
        if (!store.chatSessions.has(sessionId)) {
          throw grpcError(status.NOT_FOUND, `chat session not found: ${sessionId}`);
        }
        store.chatSessions.delete(sessionId);
        for (const [id, message] of store.chatMessages) {
          if (message.sessionId === sessionId) {
            store.chatMessages.delete(id);
          }
        }
        callback(null, Empty.create());
      } catch (err) {
        callback(err as ServiceError);
      }
    },

    listChatMessages: (
      call: ServerUnaryCall<ListChatMessagesRequest, ListChatMessagesResponse>,
      callback: sendUnaryData<ListChatMessagesResponse>,
    ) => {
      try {
        const { sessionId } = call.request;
        if (!store.chatSessions.has(sessionId)) {
          throw grpcError(status.NOT_FOUND, `chat session not found: ${sessionId}`);
        }
        const messages = [...store.chatMessages.values()]
          .filter((m) => m.sessionId === sessionId)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(-200);
        callback(null, { messages });
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
          const sessionId = call.request.sessionId;
          if (!sessionId || !store.chatSessions.has(sessionId)) {
            throw grpcError(status.NOT_FOUND, `chat session not found: ${sessionId || "(empty)"}`);
          }
          const now = nowIso();
          const userMessage: ChatMessage = {
            id: randomUUID(),
            sessionId,
            role: ChatRole.CHAT_ROLE_USER,
            content: question,
            model: "",
            inputTokens: 0,
            outputTokens: 0,
            costTotal: 0,
            createdAt: now,
          };
          store.chatMessages.set(userMessage.id, userMessage);
          // Derive the session title from the first user question.
          const session = store.chatSessions.get(sessionId)!;
          if (!session.title) {
            session.title = question.length > 40 ? `${question.slice(0, 40)}…` : question;
          }
          session.updatedAt = now;

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
          let answer = "";
          for (const delta of deltas) {
            if (call.cancelled) return;
            answered += delta.length;
            answer += delta;
            call.write({ textDelta: delta });
            await sleep(120);
          }
          const usage = {
            inputTokens: Math.ceil(question.length / 4) + 96,
            outputTokens: Math.ceil(answered / 4),
            costTotal: 0,
          };
          const answerMessage: ChatMessage = {
            id: randomUUID(),
            sessionId,
            role: ChatRole.CHAT_ROLE_ASSISTANT,
            content: answer,
            model: "mock-model",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costTotal: usage.costTotal,
            createdAt: nowIso(),
          };
          store.chatMessages.set(answerMessage.id, answerMessage);
          store.chatSessions.get(sessionId)!.updatedAt = nowIso();
          call.write({ usage });
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
