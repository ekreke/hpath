// Real-mode read path (T3): over actual gRPC, ListProjects/ListEnvs/ListCases/
// GetCase serve the SQLite seed data, while RunCase/artifact serving and all
// other unwired methods keep answering UNIMPLEMENTED (wiring boundary).

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
  const seed = seedDatabase(db);
  assert.ok(seed, "seed must run before the server starts");
  projectId = seed!.project.id;
  pendingCaseId = seed!.cases.ordersDraft.id;

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

describe("real mode wiring boundary (UNIMPLEMENTED)", () => {
  it("keeps reviewCase and listRuns UNIMPLEMENTED", async () => {
    for (const [method, request] of [
      // Enum fields must be present: protobufjs fails to serialize undefined
      // int32/enum values client-side (INTERNAL 13 before the server answers).
      ["reviewCase", { caseId: pendingCaseId, action: ReviewAction.REVIEW_ACTION_APPROVE, comment: "" }],
      ["listRuns", { projectId, status: RunStatus.RUN_STATUS_UNSPECIFIED }],
    ] as const) {
      const { err } = await callUnary(method, request);
      assert.equal(err?.code, status.UNIMPLEMENTED, `${method} must stay UNIMPLEMENTED`);
    }
  });

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
