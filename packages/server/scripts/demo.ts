// Guided end-to-end demo (SPEC T15) against the compose stack's mock server.
// Usage: make demo   (starts the stack, then runs this script), or:
//        pnpm --filter @hpath/server demo   (server must be running on 50051)
//
// Walks the user story: parse a PRD -> review the draft -> run the case on
// dev vs staging -> watch a failure verdict -> pause/resume/cancel a live run
// -> replay a run (transcript + artifacts) -> browse history. Mock mode is
// deterministic: run outcomes follow the case title ("limit" -> step budget,
// "fail"/"drift" -> alignment drift, everything else passes), so every step
// asserts exact expectations.

import { readFile } from "node:fs";
import { join } from "node:path";
import {
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
  Env,
  Event,
  ListCasesResponse,
  ListEnvsResponse,
  ListProjectsResponse,
  ParseEvent,
  Project,
  Run,
  RunDetail,
} from "@hpath/contract";
import { assert, client, status, stream, unary, unaryError } from "./client.js";

const PRD_PATH = join(import.meta.dirname ?? ".", "..", "..", "..", "fixtures", "prds", "payment.md");

function step(n: number, title: string): void {
  console.log(`\n[${n}/9] ${title}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens a live RunCase stream: the collected events grow while the run
 * executes; `done` resolves when the server closes the stream. */
function openRun(request: {
  projectId: string;
  envId: string;
  caseId: string;
  trigger: RunTrigger;
}): { events: Event[]; done: Promise<void> } {
  const events: Event[] = [];
  const call = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).runCase(request) as {
      on(ev: "data", cb: (chunk: Event) => void): void;
      on(ev: "end" | "error", cb: (err?: unknown) => void): void;
    }
  );
  const done = new Promise<void>((resolve, reject) => {
    call.on("data", (chunk: Event) => events.push(chunk));
    call.on("end", () => resolve());
    call.on("error", (err: unknown) => reject(err));
  });
  return { events, done };
}

function lastRunStatus(events: Event[]): RunStatus | undefined {
  return events.filter((event) => event.runStatus).at(-1)?.runStatus?.status;
}

async function main(): Promise<void> {
  console.log("HPath guided demo — mock compose stack (deterministic)");
  console.log(`server: ${process.env.HPATH_ADDR ?? "127.0.0.1:50051"}`);

  // 1. Connect: one seed project, two envs.
  step(1, "Connect — list the seeded project and its envs");
  const projects = await unary<Record<string, never>, ListProjectsResponse>("listProjects", {});
  assert(projects.projects.length === 1, `one seed project (${projects.projects[0]?.name})`);
  const project: Project = projects.projects[0]!;
  assert(project.name === "demo-bank", "project is demo-bank");
  const envs = await unary<{ projectId: string }, ListEnvsResponse>("listEnvs", { projectId: project.id });
  assert(envs.envs.length === 2, `two envs (${envs.envs.map((env) => env.name).join(", ")})`);
  const dev = envs.envs.find((env: Env) => env.name === "dev")!;
  const staging = envs.envs.find((env: Env) => env.name === "staging")!;

  // 2. ParsePRD: upload the bundled sample PRD, get a pending draft.
  step(2, "ParsePRD — upload fixtures/prds/payment.md to the analyze agent");
  const content = await new Promise<Buffer>((resolve, reject) =>
    readFile(PRD_PATH, (err, data) => (err ? reject(err) : resolve(data))),
  );
  const parseEvents = await stream<
    { projectId: string; filename: string; format: PrdFormat; content: Uint8Array },
    ParseEvent
  >("parsePrd", {
    projectId: project.id,
    filename: "payment.md",
    format: PrdFormat.PRD_FORMAT_MD,
    content,
  });
  assert(parseEvents.some((event) => event.prdRegistered), "PRD registered");
  assert(parseEvents.some((event) => event.thinking || event.progress), "thinking/progress events streamed");
  const drafts = parseEvents.find((event) => event.draftsCreated)?.draftsCreated;
  assert(drafts !== undefined && drafts.cases.length === 1, "one draft created");
  const draft: Case = drafts!.cases[0]!;
  assert(draft.status === CaseStatus.CASE_STATUS_PENDING, "draft is PENDING (human review required)");
  assert(draft.creator?.type === CreatorType.CREATOR_TYPE_AGENT, "draft created by the analyze agent");

  // 3. Review: approve the draft.
  step(3, "ReviewCase — approve the draft so it can run");
  const approved = await unary<{ caseId: string; action: ReviewAction; comment: string }, Case>("reviewCase", {
    caseId: draft.id,
    action: ReviewAction.REVIEW_ACTION_APPROVE,
    comment: "demo approve",
  });
  assert(approved.status === CaseStatus.CASE_STATUS_APPROVED, "draft approved");
  assert(approved.version === 2, `version bumped to ${approved.version} with a changelog entry`);

  // 4. RunCase on dev: the login case passes (three-way alignment holds).
  step(4, "RunCase on dev — the login case passes");
  const cases = await unary<{ projectId: string; status: CaseStatus }, ListCasesResponse>("listCases", {
    projectId: project.id,
    status: CaseStatus.CASE_STATUS_UNSPECIFIED,
  });
  const loginCase = cases.cases.find((kase: Case) => kase.title.includes("Login"))!;
  const driftCase = cases.cases.find((kase: Case) => kase.title.includes("drift"))!;
  const passCase = approved;
  const devRun = await stream<
    { projectId: string; envId: string; caseId: string; trigger: RunTrigger },
    Event
  >("runCase", { projectId: project.id, envId: dev.id, caseId: loginCase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL });
  assert(devRun.length >= 10, `streamed ${devRun.length} events`);
  assert(devRun.find((event) => event.verdict)?.verdict?.status === VerdictStatus.VERDICT_STATUS_PASSED, "verdict PASSED");
  assert(lastRunStatus(devRun) === RunStatus.RUN_STATUS_PASSED, "final status PASSED");

  // 5. The same case against staging.
  step(5, "RunCase on staging — same case, second env");
  const stagingRun = await stream<
    { projectId: string; envId: string; caseId: string; trigger: RunTrigger },
    Event
  >("runCase", { projectId: project.id, envId: staging.id, caseId: loginCase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL });
  assert(lastRunStatus(stagingRun) === RunStatus.RUN_STATUS_PASSED, "staging run PASSED");

  // 6. The failure path: the drift case breaks three-way alignment.
  step(6, "RunCase — the drift case fails with alignment evidence");
  const driftRun = await stream<
    { projectId: string; envId: string; caseId: string; trigger: RunTrigger },
    Event
  >("runCase", { projectId: project.id, envId: dev.id, caseId: driftCase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL });
  const driftVerdict = driftRun.find((event) => event.verdict)?.verdict;
  assert(lastRunStatus(driftRun) === RunStatus.RUN_STATUS_FAILED, "final status FAILED");
  assert(driftVerdict?.status === VerdictStatus.VERDICT_STATUS_FAILED, "verdict FAILED");
  assert(
    (driftVerdict?.evidence ?? []).some((entry) => entry.match === false && entry.apiObserved !== "" && entry.uiObserved !== ""),
    "verdict evidence records the three-way mismatch",
  );

  // 7. Runtime control of a live run: pause -> resume -> cancel.
  step(7, "Run control — pause, resume, cancel a live run");
  const pausable = openRun({ projectId: project.id, envId: dev.id, caseId: passCase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL });
  await sleep(1_200); // a few events in
  const runId = pausable.events[0]!.runId;
  const paused = await unary<{ runId: string }, Run>("pauseRun", { runId });
  assert(paused.status === RunStatus.RUN_STATUS_PAUSED, "PauseRun -> PAUSED");
  const frozenCount = pausable.events.length;
  await sleep(1_000);
  assert(pausable.events.length === frozenCount, "the event stream freezes while paused");
  await unary<{ runId: string }, Run>("resumeRun", { runId });
  await pausable.done;
  assert(lastRunStatus(pausable.events) === RunStatus.RUN_STATUS_PASSED, "ResumeRun completes the run PASSED");

  const cancellable = openRun({ projectId: project.id, envId: dev.id, caseId: passCase.id, trigger: RunTrigger.RUN_TRIGGER_MANUAL });
  await sleep(1_200);
  const cancelId = cancellable.events[0]!.runId;
  await unary<{ runId: string }, Run>("cancelRun", { runId: cancelId });
  await cancellable.done;
  assert(lastRunStatus(cancellable.events) === RunStatus.RUN_STATUS_CANCELLED, "CancelRun settles CANCELLED");
  const settled = await unaryError<{ runId: string }>("pauseRun", { runId: cancelId });
  assert(
    settled.code === status.FAILED_PRECONDITION,
    "controlling a settled run is rejected (FAILED_PRECONDITION)",
  );

  // 8. Replay: full transcript + artifacts, then download the video bytes.
  step(8, "Replay — GetRun transcript + DownloadArtifact video");
  const detail = await unary<{ runId: string }, RunDetail>("getRun", { runId });
  assert(detail.run?.id === runId, "GetRun returns the replayed run");
  assert(detail.events.length === pausable.events.length, "recorded transcript matches the streamed events");
  assert((detail.artifacts?.length ?? 0) >= 4, `run has ${detail.artifacts?.length} artifacts (video, trace, screenshots, request log)`);
  const video = detail.artifacts!.find((artifact) => artifact.kind === ArtifactKind.ARTIFACT_KIND_VIDEO)!;
  const chunks = await stream<{ artifactId: string }, { data: Uint8Array }>("downloadArtifact", {
    artifactId: video.id,
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.data.byteLength, 0);
  assert(total === video.sizeBytes, `video streamed intact (${total} bytes)`);

  // 9. History: filter by env and status.
  step(9, "History — ListRuns with filters");
  const all = await unary<{ projectId: string; envId: string; caseId: string; status: RunStatus; from: string; to: string }, { runs: Run[] }>("listRuns", {
    projectId: project.id,
    envId: "",
    caseId: "",
    status: RunStatus.RUN_STATUS_UNSPECIFIED,
    from: "",
    to: "",
  });
  assert(all.runs.length >= 6, `history holds ${all.runs.length} runs`);
  const stagingOnly = await unary<{ projectId: string; envId: string; caseId: string; status: RunStatus; from: string; to: string }, { runs: Run[] }>("listRuns", {
    projectId: project.id,
    envId: staging.id,
    caseId: "",
    status: RunStatus.RUN_STATUS_UNSPECIFIED,
    from: "",
    to: "",
  });
  assert(stagingOnly.runs.length >= 1, "env filter isolates the staging run");
  const cancelledOnly = await unary<{ projectId: string; envId: string; caseId: string; status: RunStatus; from: string; to: string }, { runs: Run[] }>("listRuns", {
    projectId: project.id,
    envId: "",
    caseId: "",
    status: RunStatus.RUN_STATUS_CANCELLED,
    from: "",
    to: "",
  });
  assert(cancelledOnly.runs.length >= 1, "status filter finds the cancelled run");

  console.log("\nDEMO PASS — the full user story ran green against the compose stack.");
  console.log("Open the desktop app to see the replay UI: `make dist` or `pnpm --filter @hpath/desktop dev`.");
  console.log("Stop the stack when done: `make down`.");
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error("DEMO FAIL:", err);
  process.exit(1);
});
