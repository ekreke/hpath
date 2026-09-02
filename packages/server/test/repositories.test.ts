// Repository CRUD tests (T5): round trips, list filters, review workflow and
// typed errors for every repository.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@hpath/contract";
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
import { HpathDb } from "../src/db/index.js";
import {
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  NotFoundError,
} from "../src/db/errors.js";
import {
  makeCase,
  makeEnv,
  makeProject,
  makeRun,
  passedVerdict,
} from "./helpers.js";

describe("ProjectRepository", () => {
  it("round-trips a project through create/get", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject({ name: "demo-bank", repoUrl: "https://github.com/example/demo-bank" });
      db.projects.create(project);
      assert.deepEqual(db.projects.getRequired(project.id), project);
    } finally {
      db.close();
    }
  });

  it("rejects duplicate project names with ConflictError", () => {
    const db = HpathDb.inMemory();
    try {
      db.projects.create(makeProject({ name: "same-name" }));
      assert.throws(
        () => db.projects.create(makeProject({ name: "same-name" })),
        ConflictError,
      );
    } finally {
      db.close();
    }
  });

  it("lists all projects and reports unknown ids", () => {
    const db = HpathDb.inMemory();
    try {
      const a = makeProject({ createdAt: "2026-01-01T00:00:00.000Z" });
      const b = makeProject({ createdAt: "2026-01-02T00:00:00.000Z" });
      db.projects.create(b);
      db.projects.create(a);
      assert.deepEqual(db.projects.list().map((p) => p.id), [a.id, b.id]);
      assert.equal(db.projects.get("missing"), undefined);
      assert.throws(() => db.projects.getRequired("missing"), NotFoundError);
    } finally {
      db.close();
    }
  });
});

describe("EnvRepository", () => {
  it("round-trips env including vars and credentials maps", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project, {
        vars: { region: "staging", tier: "qa" },
        credentials: { account: "qa/abcdef" },
      });
      db.envs.create(env);
      assert.deepEqual(db.envs.getRequired(env.id), env);
    } finally {
      db.close();
    }
  });

  it("lists only the project's own envs, sorted by name", () => {
    const db = HpathDb.inMemory();
    try {
      const p1 = makeProject();
      const p2 = makeProject();
      db.projects.create(p1);
      db.projects.create(p2);
      db.envs.create(makeEnv(p1, { name: "staging" }));
      db.envs.create(makeEnv(p1, { name: "dev" }));
      db.envs.create(makeEnv(p2, { name: "dev" }));
      assert.deepEqual(
        db.envs.listByProject(p1.id).map((e) => e.name),
        ["dev", "staging"],
      );
    } finally {
      db.close();
    }
  });

  it("updates an env and rejects unknown ids", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project, { webBaseUrl: "http://old" });
      db.envs.create(env);
      db.envs.update({ ...env, webBaseUrl: "http://new", vars: { region: "x" } });
      const reloaded = db.envs.getRequired(env.id);
      assert.equal(reloaded.webBaseUrl, "http://new");
      assert.deepEqual(reloaded.vars, { region: "x" });
      assert.throws(
        () => db.envs.update({ ...env, id: "missing" }),
        NotFoundError,
      );
    } finally {
      db.close();
    }
  });

  it("deletes an env but refuses while runs reference it", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project);
      db.envs.create(env);
      const kase = makeCase(project);
      db.cases.create(kase);

      assert.throws(
        () => db.envs.delete("missing"),
        NotFoundError,
      );

      db.runs.create(makeRun(project, env, kase));
      assert.throws(() => db.envs.delete(env.id), ConflictError);

      // Only after the run is gone can the env be removed.
      db.database.prepare("DELETE FROM runs").run();
      db.envs.delete(env.id);
      assert.equal(db.envs.get(env.id), undefined);
    } finally {
      db.close();
    }
  });
});

describe("CaseRepository", () => {
  it("round-trips a case with alignments, changelog and creator", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const kase = makeCase(project, {
        alignments: [
          { apiPath: "/api/balance", uiAnchor: "Balance card", rule: "Equal values." },
          { apiPath: "/api/transfer", uiAnchor: "Toast", rule: "Amount confirmed." },
        ],
        changelog: [
          { version: 1, author: "john", comment: "Initial", changedAt: "2026-01-01T00:00:00.000Z" },
          { version: 2, author: "alice", comment: "Edit", changedAt: "2026-01-02T00:00:00.000Z" },
        ],
        creator: { type: CreatorType.CREATOR_TYPE_AGENT, name: "analyze-agent", runRef: "run#1" },
        sourcePrdRef: "prds/payment.md#transfer",
        version: 2,
      });
      db.cases.create(kase);
      assert.deepEqual(db.cases.getRequired(kase.id), kase);
    } finally {
      db.close();
    }
  });

  it("filters by project and status", () => {
    const db = HpathDb.inMemory();
    try {
      const p1 = makeProject();
      const p2 = makeProject();
      db.projects.create(p1);
      db.projects.create(p2);
      const pending = makeCase(p1, { status: CaseStatus.CASE_STATUS_PENDING });
      const approved = makeCase(p1, { status: CaseStatus.CASE_STATUS_APPROVED });
      const other = makeCase(p2);
      db.cases.create(pending);
      db.cases.create(approved);
      db.cases.create(other);

      assert.deepEqual(
        db.cases.listByProject(p1.id).map((c) => c.id).sort(),
        [pending.id, approved.id].sort(),
      );
      assert.deepEqual(
        db.cases.listByProject(p1.id, CaseStatus.CASE_STATUS_PENDING).map((c) => c.id),
        [pending.id],
      );
      assert.equal(db.cases.listByProject(p2.id).length, 1);
    } finally {
      db.close();
    }
  });

  it("approve: pending -> approved with version bump and changelog entry", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const kase = makeCase(project, { status: CaseStatus.CASE_STATUS_PENDING, version: 3 });
      db.cases.create(kase);

      const reviewed = db.cases.review(kase.id, ReviewAction.REVIEW_ACTION_APPROVE, {
        author: "alice",
        comment: "Looks good",
      });
      assert.equal(reviewed.status, CaseStatus.CASE_STATUS_APPROVED);
      assert.equal(reviewed.version, 4);
      const last = reviewed.changelog[reviewed.changelog.length - 1];
      assert.equal(last.version, 4);
      assert.equal(last.author, "alice");
      assert.equal(last.comment, "Looks good");
    } finally {
      db.close();
    }
  });

  it("rejects illegal transitions and unknown cases", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const approved = makeCase(project, { status: CaseStatus.CASE_STATUS_APPROVED });
      db.cases.create(approved);

      // REJECT only applies to PENDING cases.
      assert.throws(
        () => db.cases.review(approved.id, ReviewAction.REVIEW_ACTION_REJECT),
        InvalidTransitionError,
      );
      assert.throws(
        () => db.cases.review("missing", ReviewAction.REVIEW_ACTION_APPROVE),
        NotFoundError,
      );
    } finally {
      db.close();
    }
  });

  it("disable: approved -> disabled, then re-approve works", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const kase = makeCase(project);
      db.cases.create(kase);

      const disabled = db.cases.review(kase.id, ReviewAction.REVIEW_ACTION_DISABLE);
      assert.equal(disabled.status, CaseStatus.CASE_STATUS_DISABLED);
      const reapproved = db.cases.review(kase.id, ReviewAction.REVIEW_ACTION_APPROVE);
      assert.equal(reapproved.status, CaseStatus.CASE_STATUS_APPROVED);
    } finally {
      db.close();
    }
  });
});

describe("RunRepository", () => {
  it("round-trips a run including its verdict", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project);
      db.envs.create(env);
      const kase = makeCase(project);
      db.cases.create(kase);
      const run = makeRun(project, env, kase, { verdict: passedVerdict() });
      db.runs.create(run);
      assert.deepEqual(db.runs.getRequired(run.id), run);
    } finally {
      db.close();
    }
  });

  it("finish moves a run to a terminal state", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project);
      db.envs.create(env);
      const kase = makeCase(project);
      db.cases.create(kase);
      const run = makeRun(project, env, kase);
      db.runs.create(run);

      const verdict = passedVerdict();
      const finishedAt = "2026-01-01T10:00:05.000Z";
      const done = db.runs.finish(run.id, {
        status: RunStatus.RUN_STATUS_PASSED,
        verdict,
        finishedAt,
        durationMs: 8400,
        tokenCost: 720,
        failReason: "",
      });
      assert.equal(done.status, RunStatus.RUN_STATUS_PASSED);
      assert.deepEqual(done.verdict, verdict);
      assert.equal(done.finishedAt, finishedAt);
      assert.equal(done.durationMs, 8400);
      assert.equal(done.tokenCost, 720);

      assert.throws(() => db.runs.finish("missing", {
        status: RunStatus.RUN_STATUS_FAILED,
        finishedAt,
        durationMs: 0,
        tokenCost: 0,
      }), NotFoundError);
    } finally {
      db.close();
    }
  });

  it("lists runs with filters, most recent first", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const dev = makeEnv(project, { name: "dev" });
      const staging = makeEnv(project, { name: "staging" });
      db.envs.create(dev);
      db.envs.create(staging);
      const kase = makeCase(project);
      const other = makeCase(project);
      db.cases.create(kase);
      db.cases.create(other);

      const base = Date.parse("2026-01-01T00:00:00.000Z");
      const at = (i: number): string => new Date(base + i * 1000).toISOString();
      const r1 = makeRun(project, dev, kase, { startedAt: at(1) });
      const r2 = makeRun(project, staging, kase, {
        startedAt: at(2),
        status: RunStatus.RUN_STATUS_FAILED,
        trigger: RunTrigger.RUN_TRIGGER_AGENT,
      });
      const r3 = makeRun(project, dev, other, { startedAt: at(3) });
      for (const run of [r1, r2, r3]) db.runs.create(run);

      assert.deepEqual(db.runs.list({ projectId: project.id }).map((r) => r.id), [r3.id, r2.id, r1.id]);
      assert.deepEqual(db.runs.list({ projectId: project.id, envId: dev.id }).map((r) => r.id), [r3.id, r1.id]);
      assert.deepEqual(db.runs.list({ projectId: project.id, caseId: kase.id }).map((r) => r.id), [r2.id, r1.id]);
      assert.deepEqual(db.runs.list({ projectId: project.id, status: RunStatus.RUN_STATUS_FAILED }).map((r) => r.id), [r2.id]);
      assert.deepEqual(db.runs.list({ projectId: project.id, from: at(2) }).map((r) => r.id), [r3.id, r2.id]);
      assert.deepEqual(db.runs.list({ projectId: project.id, to: at(1) }).map((r) => r.id), [r1.id]);
    } finally {
      db.close();
    }
  });
});

describe("EventRepository", () => {
  function seedRun(db: HpathDb): { runId: string } {
    const project = makeProject();
    db.projects.create(project);
    const env = makeEnv(project);
    db.envs.create(env);
    const kase = makeCase(project);
    db.cases.create(kase);
    const run = makeRun(project, env, kase);
    db.runs.create(run);
    return { runId: run.id };
  }

  it("appends and reads back ordered events with their oneof payload", () => {
    const db = HpathDb.inMemory();
    try {
      const { runId } = seedRun(db);
      const screenshot: Event = {
        runId,
        seq: 1,
        timestamp: "2026-01-01T00:00:01.000Z",
        screenshot: { artifactId: "art-1", caption: "Login page" },
      };
      const verdict: Event = {
        runId,
        seq: 2,
        timestamp: "2026-01-01T00:00:02.000Z",
        verdict: passedVerdict(),
      };
      db.events.append(screenshot);
      db.events.append(verdict);

      const events = db.events.listForRun(runId);
      assert.equal(events.length, 2);
      assert.deepEqual(events[0], screenshot);
      assert.deepEqual(events[1], verdict);
      assert.equal(events[1].verdict?.status, VerdictStatus.VERDICT_STATUS_PASSED);
    } finally {
      db.close();
    }
  });

  it("rejects events for unknown runs", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () => db.events.append({
          runId: "missing-run",
          seq: 1,
          timestamp: new Date().toISOString(),
          agentText: { text: "hi" },
        }),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });
});

describe("ArtifactRepository", () => {
  it("round-trips artifact metadata and lists per run", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project);
      db.envs.create(env);
      const kase = makeCase(project);
      db.cases.create(kase);
      const run = makeRun(project, env, kase);
      const other = makeRun(project, env, kase);
      db.runs.create(run);
      db.runs.create(other);

      const shot = {
        id: "art-shot",
        runId: run.id,
        kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
        key: `artifacts/${project.id}/${env.id}/${run.id}/01-login.png`,
        sizeBytes: 1234,
        sha256: "deadbeef",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const video = {
        id: "art-video",
        runId: other.id,
        kind: ArtifactKind.ARTIFACT_KIND_VIDEO,
        key: `artifacts/${project.id}/${env.id}/${other.id}/session.webm`,
        sizeBytes: 42,
        sha256: "cafebabe",
        createdAt: "2026-01-01T00:00:01.000Z",
      };
      db.artifacts.insert(shot);
      db.artifacts.insert(video);

      assert.deepEqual(db.artifacts.getRequired(shot.id), shot);
      assert.deepEqual(db.artifacts.listForRun(run.id), [shot]);
      assert.equal(db.artifacts.get("missing"), undefined);
      assert.throws(() => db.artifacts.getRequired("missing"), NotFoundError);
    } finally {
      db.close();
    }
  });

  it("rejects artifacts for unknown runs", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () => db.artifacts.insert({
          id: "art-x",
          runId: "missing-run",
          kind: ArtifactKind.ARTIFACT_KIND_TRACE,
          key: "artifacts/p/e/r/trace.zip",
          sizeBytes: 1,
          sha256: "",
          createdAt: new Date().toISOString(),
        }),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });
});

describe("PrdRepository", () => {
  it("round-trips a PRD and lists per project", () => {
    const db = HpathDb.inMemory();
    try {
      const p1 = makeProject();
      const p2 = makeProject();
      db.projects.create(p1);
      db.projects.create(p2);
      const prd = {
        id: "prd-1",
        projectId: p1.id,
        filename: "payment.md",
        format: PrdFormat.PRD_FORMAT_MD,
        sizeBytes: 2048,
        createdAt: "2026-01-01T00:00:00.000Z",
        contentRef: "artifacts/p/prds/payment.md",
      };
      db.prds.insert(prd);
      db.prds.insert({ ...prd, id: "prd-2", projectId: p2.id });

      assert.deepEqual(db.prds.getRequired("prd-1"), prd);
      assert.deepEqual(db.prds.listByProject(p1.id), [prd]);
      assert.deepEqual(db.prds.listByProject(p2.id).map((p) => p.id), ["prd-2"]);
      assert.throws(() => db.prds.getRequired("missing"), NotFoundError);
    } finally {
      db.close();
    }
  });
});
