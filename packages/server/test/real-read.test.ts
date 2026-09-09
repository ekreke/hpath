// Real-mode read path (T3): over actual gRPC, ListProjects/ListEnvs/ListCases/
// GetCase/ReviewCase serve the SQLite seed data. This suite starts the server
// WITHOUT the T8 execution deps (kernel + artifact store), so RunCase/artifact
// serving keep answering UNIMPLEMENTED — proving the wiring boundary stays
// honest when a deployment opts out of the run/analysis path. The run path
// itself is covered by test/run-execution.test.ts, the ParsePRD analysis path
// (wired when the same execution deps are present, T9) by
// test/prd-analysis-grpc.test.ts.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { credentials, makeClientConstructor, status } from "@grpc/grpc-js";
import {
  CaseStatus,
  CreatorType,
  HpathService,
  ReviewAction,
  RunStatus,
  RunTrigger,
} from "@hpath/contract";
import type {
  Case,
  ListCasesResponse,
  ListEnvsResponse,
  ListProjectsResponse,
  ListRunsResponse,
  Project,
} from "@hpath/contract";
import { HpathDb } from "../src/db/index.js";
import { seedDatabase } from "../src/db/seed.js";
import { SettingsStore } from "../src/settings.js";
import { startServer } from "../src/grpc/server.js";
import type { RunningServer } from "../src/grpc/server.js";

// Loose view of the generated client; mirrors scripts/smoke.ts.
interface TestClient {
  close(): void;
}

let running: RunningServer;
let client: TestClient;
let projectId: string;
let pendingCaseId: string;
let approvedCaseId: string;
let runReferencedCaseId: string;

async function callUnary(method: string, request: unknown): Promise<{ err: { code: number; details: string } | null; res: unknown }> {
  return new Promise((resolve, reject) => {
    (client as unknown as Record<string, (req: unknown, cb: (err: { code: number; details: string } | null, res: unknown) => void) => void>)[method](
      request,
      (err, res) => {
        if (err && err.code === undefined) reject(err);
        else resolve({ err, res });
      },
    );
  });
}

function streamError(method: string, request: unknown): Promise<{ code: number; details: string }> {
  return new Promise((resolve, reject) => {
    const call = (client as unknown as Record<string, (req: unknown) => { on(ev: string, cb: (x?: unknown) => void): void }>)[method](request);
    call.on("error", (x?: unknown) => resolve(x as { code: number; details: string }));
    call.on("data", () => reject(new Error("expected no data")));
    call.on("end", () => reject(new Error("expected an error")));
  });
}

before(async () => {
  const db = HpathDb.inMemory();
  const seed = await seedDatabase(db);
  assert.ok(seed, "seed must run before the server starts");
  projectId = seed!.project.id;
  pendingCaseId = seed!.cases.ordersDraft.id;
  approvedCaseId = seed!.cases.transfer.id;
  runReferencedCaseId = seed!.cases.login.id;

  // Real mode now also carries a settings store (Get/UpdateSettings + Chat);
  // load it from a throwaway path so the suite never touches data/.
  const settingsPath = join(tmpdir(), `hpath-test-settings-${process.pid}.json`);
  rmSync(settingsPath, { force: true });
  const settings = SettingsStore.load(settingsPath);

  running = await startServer({ mode: "real", port: 0, host: "127.0.0.1", db, settings });
  client = new (
    makeClientConstructor(HpathService as never, "HpathService") as unknown as {
      new (address: string, credentials: never): TestClient;
    }
  )(`127.0.0.1:${running.port}`, credentials.createInsecure() as never);
});

after(async () => {
  client?.close();
  await running?.shutdown();
});

describe("real mode read path (SQLite)", () => {
  it("ListProjects serves the seed project", async () => {
    const { err, res } = await callUnary("listProjects", {});
    assert.equal(err, null);
    const projects = (res as ListProjectsResponse).projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.name, "demo-bank");
    assert.equal(projects[0]!.repoUrl, "https://github.com/example/demo-bank");
  });

  it("ListEnvs serves dev + staging from SQLite", async () => {
    const { err, res } = await callUnary("listEnvs", { projectId });
    assert.equal(err, null);
    const envs = (res as ListEnvsResponse).envs;
    assert.deepEqual(
      envs.map((env) => env.name).sort(),
      ["dev", "staging"],
    );
  });

  it("ListEnvs reports NOT_FOUND for an unknown project", async () => {
    const { err } = await callUnary("listEnvs", { projectId: "no-such-project" });
    assert.equal(err?.code, status.NOT_FOUND);
  });

  it("ListCases serves the five seed cases with status filter", async () => {
    const all = await callUnary("listCases", {
      projectId,
      status: CaseStatus.CASE_STATUS_UNSPECIFIED,
    });
    assert.equal(all.err, null);
    assert.equal((all.res as ListCasesResponse).cases.length, 5);

    const approved = await callUnary("listCases", {
      projectId,
      status: CaseStatus.CASE_STATUS_APPROVED,
    });
    assert.equal(approved.err, null);
    const approvedCases = (approved.res as ListCasesResponse).cases;
    assert.equal(approvedCases.length, 4);
    assert.ok(approvedCases.every((kase) => "title" in kase && "changelog" in kase));

    const pending = await callUnary("listCases", {
      projectId,
      status: CaseStatus.CASE_STATUS_PENDING,
    });
    assert.equal(pending.err, null);
    const pendingCases = (pending.res as ListCasesResponse).cases;
    assert.equal(pendingCases.length, 1);
    assert.equal((pendingCases[0] as Case).creator?.type, CreatorType.CREATOR_TYPE_AGENT);
  });

  it("ListCases reports NOT_FOUND for an unknown project", async () => {
    const { err } = await callUnary("listCases", {
      projectId: "nope",
      status: CaseStatus.CASE_STATUS_UNSPECIFIED,
    });
    assert.equal(err?.code, status.NOT_FOUND);
  });

  it("GetCase returns alignments and changelog for a seeded case", async () => {
    const { err, res } = await callUnary("getCase", { caseId: pendingCaseId });
    assert.equal(err, null);
    const kase = res as Case;
    assert.equal(kase.id, pendingCaseId);
    assert.equal(kase.title, "Order list matches the order service");
    assert.equal(kase.alignments.length, 1);
    assert.equal(kase.changelog.length, 1);
  });

  it("GetCase reports NOT_FOUND for an unknown case", async () => {
    const { err } = await callUnary("getCase", { caseId: "missing-case" });
    assert.equal(err?.code, status.NOT_FOUND);
  });

  it("ListRuns serves the seeded history from SQLite", async () => {
    const { err, res } = await callUnary("listRuns", {
      projectId,
      envId: "",
      caseId: "",
      status: RunStatus.RUN_STATUS_UNSPECIFIED,
      from: "",
      to: "",
    });
    assert.equal(err, null);
    const runs = (res as ListRunsResponse).runs;
    assert.equal(runs.length, 2);
    // Most recent first; both runs share a synthetic base, so the id ordering
    // only has to be stable — assert it rather than guessing which side wins.
    assert.ok(runs[0]!.startedAt >= runs[1]!.startedAt);
  });

  it("ListRuns reports NOT_FOUND for an unknown project", async () => {
    const { err } = await callUnary("listRuns", {
      projectId: "ghost",
      envId: "",
      caseId: "",
      status: RunStatus.RUN_STATUS_UNSPECIFIED,
      from: "",
      to: "",
    });
    assert.equal(err?.code, status.NOT_FOUND);
  });
});

describe("real mode CreateProject (T5 repository wiring)", () => {
  it("creates a project and serves it through ListProjects", async () => {
    const { err, res } = await callUnary("createProject", {
      name: "wired-project",
      repoUrl: "https://github.com/example/wired",
    });
    assert.equal(err, null);
    const created = res as Project;
    assert.ok(created.id.length > 0);
    assert.equal(created.name, "wired-project");
    assert.equal(created.repoUrl, "https://github.com/example/wired");
    assert.ok(created.createdAt.length > 0);

    const list = await callUnary("listProjects", {});
    const names = (list.res as ListProjectsResponse).projects.map((p) => p.name);
    assert.deepEqual(names, ["demo-bank", "wired-project"]);
  });

  it("defaults repoUrl to empty when omitted", async () => {
    // Scalar fields must be present: ts-proto's encode only skips the field
    // when it equals "" — a missing field would hit writer.string(undefined)
    // and serialize the literal "undefined" onto the wire (same class of
    // pitfall as the enum note below).
    const { err, res } = await callUnary("createProject", { name: "no-repo", repoUrl: "" });
    assert.equal(err, null);
    assert.equal((res as Project).repoUrl, "");
  });

  it("reports INVALID_ARGUMENT when name is missing", async () => {
    const { err } = await callUnary("createProject", { name: "" });
    assert.equal(err?.code, status.INVALID_ARGUMENT);
  });

  it("reports ALREADY_EXISTS for a duplicate name", async () => {
    const { err } = await callUnary("createProject", { name: "demo-bank" });
    assert.equal(err?.code, status.ALREADY_EXISTS);
  });
});

describe("real mode manual case management (CreateCase/UpdateCase/DeleteCase)", () => {
  let createdCaseId = "";

  it("CreateCase lands a PENDING human case that ListCases serves", async () => {
    const { err, res } = await callUnary("createCase", {
      projectId,
      title: "manual probe",
      goal: "UI and backend agree on the balance.",
      alignments: [{ apiPath: "/api/balance", uiAnchor: "Balance card", rule: "Equal values." }],
    });
    assert.equal(err, null);
    const created = res as Case;
    createdCaseId = created.id;
    assert.ok(created.id.length > 0);
    assert.equal(created.title, "manual probe");
    assert.equal(created.creator?.type, CreatorType.CREATOR_TYPE_HUMAN);
    assert.equal(created.status, CaseStatus.CASE_STATUS_PENDING);
    assert.equal(created.sourcePrdRef, "");
    assert.equal(created.version, 1);
    assert.equal(created.changelog.length, 1);
    assert.equal(created.changelog[0]!.comment, "Created manually");

    const pending = await callUnary("listCases", {
      projectId,
      status: CaseStatus.CASE_STATUS_PENDING,
    });
    const ids = (pending.res as ListCasesResponse).cases.map((c) => c.id);
    assert.ok(ids.includes(createdCaseId));
  });

  it("CreateCase validates title, goal and project existence", async () => {
    // Repeated fields must be present: protobufjs fails to serialize a
    // missing repeated field client-side (INTERNAL 13 before the server
    // answers) — same class of pitfall as the scalar/enum notes above.
    const missingTitle = await callUnary("createCase", { projectId, title: "", goal: "g", alignments: [] });
    assert.equal(missingTitle.err?.code, status.INVALID_ARGUMENT);
    const missingGoal = await callUnary("createCase", { projectId, title: "t", goal: "", alignments: [] });
    assert.equal(missingGoal.err?.code, status.INVALID_ARGUMENT);
    const unknownProject = await callUnary("createCase", {
      projectId: "no-such-project",
      title: "t",
      goal: "g",
      alignments: [],
    });
    assert.equal(unknownProject.err?.code, status.NOT_FOUND);
  });

  it("UpdateCase replaces title/goal/alignments with version bump and changelog", async () => {
    const { err, res } = await callUnary("updateCase", {
      caseId: createdCaseId,
      title: "manual probe (revised)",
      goal: "Revised goal.",
      alignments: [
        { apiPath: "/api/a", uiAnchor: "Anchor A", rule: "Rule A." },
        { apiPath: "/api/b", uiAnchor: "Anchor B", rule: "Rule B." },
      ],
    });
    assert.equal(err, null);
    const updated = res as Case;
    assert.equal(updated.title, "manual probe (revised)");
    assert.equal(updated.goal, "Revised goal.");
    assert.deepEqual(updated.alignments.map((a) => a.apiPath), ["/api/a", "/api/b"]);
    assert.equal(updated.version, 2);
    const last = updated.changelog[updated.changelog.length - 1]!;
    assert.equal(last.author, "editor");
    assert.equal(last.comment, "Updated manually");

    const fetched = await callUnary("getCase", { caseId: createdCaseId });
    assert.equal((fetched.res as Case).alignments.length, 2);
  });

  it("UpdateCase refuses APPROVED cases and unknown ids", async () => {
    const approved = await callUnary("updateCase", {
      caseId: approvedCaseId,
      title: "t",
      goal: "g",
      alignments: [],
    });
    assert.equal(approved.err?.code, status.FAILED_PRECONDITION);
    const missing = await callUnary("updateCase", {
      caseId: "missing-case",
      title: "t",
      goal: "g",
      alignments: [],
    });
    assert.equal(missing.err?.code, status.NOT_FOUND);
    const missingTitle = await callUnary("updateCase", {
      caseId: createdCaseId,
      title: "",
      goal: "g",
      alignments: [],
    });
    assert.equal(missingTitle.err?.code, status.INVALID_ARGUMENT);
  });

  it("DeleteCase removes a case without runs and reports NOT_FOUND afterwards", async () => {
    const { err } = await callUnary("deleteCase", { caseId: createdCaseId });
    assert.equal(err, null);
    const fetched = await callUnary("getCase", { caseId: createdCaseId });
    assert.equal(fetched.err?.code, status.NOT_FOUND);
  });

  it("DeleteCase refuses cases referenced by runs and unknown ids", async () => {
    const referenced = await callUnary("deleteCase", { caseId: runReferencedCaseId });
    assert.equal(referenced.err?.code, status.ALREADY_EXISTS);
    const missing = await callUnary("deleteCase", { caseId: "missing-case" });
    assert.equal(missing.err?.code, status.NOT_FOUND);
  });
});

describe("real mode review workflow (ReviewCase)", () => {
  it("rejects an unspecified action with INVALID_ARGUMENT", async () => {
    const { err } = await callUnary("reviewCase", {
      caseId: pendingCaseId,
      action: ReviewAction.REVIEW_ACTION_UNSPECIFIED,
      comment: "",
    });
    assert.equal(err?.code, status.INVALID_ARGUMENT);
  });

  it("rejects an unknown case with NOT_FOUND", async () => {
    const { err } = await callUnary("reviewCase", {
      caseId: "missing-case",
      action: ReviewAction.REVIEW_ACTION_APPROVE,
      comment: "",
    });
    assert.equal(err?.code, status.NOT_FOUND);
  });

  it("approves the pending draft: status transition, version bump and changelog", async () => {
    const { err, res } = await callUnary("reviewCase", {
      caseId: pendingCaseId,
      action: ReviewAction.REVIEW_ACTION_APPROVE,
      comment: "looks aligned",
    });
    assert.equal(err, null);
    const kase = res as Case;
    assert.equal(kase.status, CaseStatus.CASE_STATUS_APPROVED);
    assert.equal(kase.version, 2);
    const entry = kase.changelog[kase.changelog.length - 1]!;
    assert.equal(entry.author, "reviewer");
    assert.equal(entry.comment, "looks aligned");
  });

  it("rejects an approved case with FAILED_PRECONDITION (illegal transition)", async () => {
    const { err } = await callUnary("reviewCase", {
      caseId: approvedCaseId,
      action: ReviewAction.REVIEW_ACTION_REJECT,
      comment: "",
    });
    assert.equal(err?.code, status.FAILED_PRECONDITION);
  });

  it("reject -> draft and approve -> approved round-trip on a throwaway case", async () => {
    const created = await callUnary("createCase", {
      projectId,
      title: "review round-trip probe",
      goal: "g",
      alignments: [{ apiPath: "/api/x", uiAnchor: "Card", rule: "Values agree." }],
    });
    assert.equal(created.err, null);
    const id = (created.res as Case).id;

    const rejected = await callUnary("reviewCase", {
      caseId: id,
      action: ReviewAction.REVIEW_ACTION_REJECT,
      comment: "",
    });
    assert.equal(rejected.err, null);
    assert.equal((rejected.res as Case).status, CaseStatus.CASE_STATUS_DRAFT);
    // Empty comment falls back to the "<ACTION> via review" convention.
    assert.equal(
      (rejected.res as Case).changelog.at(-1)!.comment,
      "REVIEW_ACTION_REJECT via review",
    );

    const approved = await callUnary("reviewCase", {
      caseId: id,
      action: ReviewAction.REVIEW_ACTION_APPROVE,
      comment: "",
    });
    assert.equal(approved.err, null);
    assert.equal((approved.res as Case).status, CaseStatus.CASE_STATUS_APPROVED);

    const cleanup = await callUnary("deleteCase", { caseId: id });
    assert.equal(cleanup.err, null);
  });
});

describe("real mode wiring boundary (UNIMPLEMENTED)", () => {
  it("keeps RunCase and artifact serving UNIMPLEMENTED", async () => {
    const runErr = await streamError("runCase", {
      projectId,
      envId: "env",
      caseId: "case",
      trigger: RunTrigger.RUN_TRIGGER_MANUAL,
    });
    assert.equal(runErr.code, status.UNIMPLEMENTED);
    const artifactErr = await streamError("downloadArtifact", { artifactId: "artifact" });
    assert.equal(artifactErr.code, status.UNIMPLEMENTED);
  });
});
