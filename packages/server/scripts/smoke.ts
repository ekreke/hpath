// End-to-end smoke client for the mock server.
// Usage: pnpm --filter @hpath/server smoke   (server must be running on 50051)

import { credentials, makeClientConstructor } from "@grpc/grpc-js";
import {
  HpathService,
  ArtifactKind,
  CaseStatus,
  CreatorType,
  PrdFormat,
  ReviewAction,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";
import type {
  Case,
  Event,
  HpathServer,
  ListCasesResponse,
  ListEnvsResponse,
  ListProjectsResponse,
  ParseEvent,
  Project,
  RunDetail,
  ReviewCaseRequest,
  RunCaseRequest,
  UpsertEnvRequest,
  Env,
} from "@hpath/contract";

type HpathClient = makeClientConstructor.ClientConstructor<HpathServer>;

const address = process.env.HPATH_ADDR ?? "127.0.0.1:50051";
const client = new (makeClientConstructor(HpathService as never, "HpathService") as unknown as {
  new (address: string, credentials: never): HpathClient;
})(address, credentials.createInsecure()) as HpathClient;

function unary<Req, Res>(method: keyof HpathServer, request: Req): Promise<Res> {
  return new Promise((resolve, reject) => {
    (client as unknown as Record<string, (req: Req, cb: (err: unknown, res: Res) => void) => void>)[
      method as string
    ](request, (err: unknown, res: Res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

function stream<Req, Res>(method: keyof HpathServer, request: Req): Promise<Res[]> {
  return new Promise((resolve, reject) => {
    const chunks: Res[] = [];
    const call = (
      client as unknown as Record<string, (req: Req) => { on(ev: string, cb: (x?: unknown) => void): void }>
    )[method as string](request);
    call.on("data", (chunk: Res) => chunks.push(chunk));
    call.on("end", () => resolve(chunks));
    call.on("error", (err: unknown) => reject(err));
  });
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`SMOKE FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ok: ${message}`);
}

async function main(): Promise<void> {
  // 1. Projects
  const projects = await unary<Record<string, never>, ListProjectsResponse>("listProjects", {});
  assert(projects.projects.length === 1, `one seed project (${projects.projects[0]?.name})`);
  const project: Project = projects.projects[0]!;
  assert(project.name === "demo-bank", "project is demo-bank");

  // 2. Envs
  const envs = await unary<{ projectId: string }, ListEnvsResponse>("listEnvs", { projectId: project.id });
  assert(envs.envs.length === 2, "two seed envs (dev, staging)");
  const dev = envs.envs.find((env: Env) => env.name === "dev")!;

  // 3. Cases
  const cases = await unary<{ projectId: string; status: CaseStatus }, ListCasesResponse>("listCases", {
    projectId: project.id,
    status: CaseStatus.CASE_STATUS_UNSPECIFIED,
  });
  assert(cases.cases.length >= 3, `at least three cases (${cases.cases.length})`);
  const pendingDraft = cases.cases.find((kase: Case) => kase.status === CaseStatus.CASE_STATUS_PENDING)!;
  assert(pendingDraft.creator.type === CreatorType.CREATOR_TYPE_AGENT, "pending draft created by agent");

  // 4. ParsePRD streams progress and creates a pending draft
  const md = "# PRD\n\nUsers see their balance after login.\n";
  const parseEvents = await stream<
    { projectId: string; filename: string; format: PrdFormat; content: Uint8Array },
    ParseEvent
  >("parsePrd", {
    projectId: project.id,
    filename: "smoke-prd.md",
    format: PrdFormat.PRD_FORMAT_MD,
    content: Buffer.from(md, "utf8"),
  });
  const drafts = parseEvents.find((event) => event.draftsCreated)?.draftsCreated;
  assert(drafts !== undefined && drafts.cases.length === 1, "parsePrd produced one draft");
  const newDraft = drafts!.cases[0]!;
  assert(newDraft.status === CaseStatus.CASE_STATUS_PENDING, "parsePrd draft is pending");

  // 5. Review workflow: approve the new draft
  const reviewReq: ReviewCaseRequest = {
    caseId: newDraft.id,
    action: ReviewAction.REVIEW_ACTION_APPROVE,
    comment: "smoke approve",
  };
  const approved = await unary<ReviewCaseRequest, Case>("reviewCase", reviewReq);
  assert(approved.status === CaseStatus.CASE_STATUS_APPROVED, "draft approved via reviewCase");

  // 6. UpsertEnv create + delete guard
  const createdEnv = await unary<UpsertEnvRequest, Env>("upsertEnv", {
    env: {
      id: "",
      projectId: project.id,
      name: "qa",
      webBaseUrl: "http://localhost:8083",
      grpcAddress: "localhost:9093",
      vars: {},
      credentials: {},
    },
  });
  assert(createdEnv.name === "qa", "upsertEnv created env qa");
  await unary<{ envId: string }, Record<string, never>>("deleteEnv", { envId: createdEnv.id });
  console.log("ok: env create/delete round-trip");

  // 7. RunCase streams events and passes
  const approvedCase = cases.cases.find(
    (kase: Case) => kase.status === CaseStatus.CASE_STATUS_APPROVED && kase.title.includes("Login"),
  )!;
  const runReq: RunCaseRequest = {
    projectId: project.id,
    envId: dev.id,
    caseId: approvedCase.id,
    trigger: RunTrigger.RUN_TRIGGER_MANUAL,
  };
  const events = await stream<RunCaseRequest, Event>("runCase", runReq);
  assert(events.length >= 10, `runCase streamed ${events.length} events`);
  const verdictEvent = events.find((event) => event.verdict);
  assert(verdictEvent?.verdict?.status === VerdictStatus.VERDICT_STATUS_PASSED, "run verdict PASSED");
  const lastStatus = events.filter((event) => event.runStatus).at(-1)?.runStatus?.status;
  assert(lastStatus === RunStatus.RUN_STATUS_PASSED, "final run status PASSED");

  // 8. GetRun returns full transcript + artifacts
  const runId = events[0]!.runId;
  const detail = await unary<{ runId: string }, RunDetail>("getRun", { runId });
  assert(detail.events.length === events.length, "getRun events match streamed events");
  assert(detail.artifacts.length >= 4, `run has ${detail.artifacts.length} artifacts`);
  assert(detail.run.tokenCost > 0, "token cost recorded");

  // 9. DownloadArtifact streams bytes
  const video = detail.artifacts.find((artifact) => artifact.kind === ArtifactKind.ARTIFACT_KIND_VIDEO)!;
  const chunks = await stream<{ artifactId: string }, { data: Uint8Array }>("downloadArtifact", {
    artifactId: video.id,
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  assert(total === video.sizeBytes, `downloadArtifact delivered ${total} bytes`);

  // 10. History reflects all runs
  const runs = await unary<
    { projectId: string; envId: string; caseId: string; status: RunStatus; from: string; to: string },
    { runs: RunDetail["run"][] }
  >("listRuns", {
    projectId: project.id,
    envId: "",
    caseId: "",
    status: RunStatus.RUN_STATUS_UNSPECIFIED,
    from: "",
    to: "",
  });
  assert(runs.runs.length >= 3, `history has ${runs.runs.length} runs (2 seed + 1 new)`);

  console.log("\nSMOKE PASS: all checks green");
  process.exit(0);
}

void main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
