// Repository CRUD tests (T5): round trips, list filters, review workflow and
// typed errors for every repository.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Event } from "@hpath/contract";
import {
  ArtifactKind,
  AssetType,
  CaseStatus,
  CreatorType,
  ReviewAction,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";
import { HpathDb, repairZeroAlignmentCases } from "../src/db/index.js";
import {
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  NotFoundError,
  RepositoryError,
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

  it("updates name and repo_url and rejects duplicate names", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject({ name: "original" });
      db.projects.create(project);
      db.projects.create(makeProject({ name: "taken" }));

      const updated = db.projects.update(project.id, {
        name: "renamed",
        repoUrl: "https://example.com/new",
      });
      assert.equal(updated.name, "renamed");
      assert.equal(updated.repoUrl, "https://example.com/new");
      assert.equal(db.projects.getRequired(project.id).name, "renamed");
      assert.throws(
        () => db.projects.update(project.id, { name: "taken", repoUrl: "x" }),
        ConflictError,
      );
    } finally {
      db.close();
    }
  });

  it("removeCascade deletes children and reports artifact keys", () => {
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
      const artifactKey = `artifacts/${project.id}/${env.id}/${run.id}/session.webm`;
      db.artifacts.insert({
        id: "art-1",
        runId: run.id,
        kind: ArtifactKind.ARTIFACT_KIND_VIDEO,
        key: artifactKey,
        sizeBytes: 10,
        sha256: "cafebabe",
        createdAt: new Date().toISOString(),
      });
      db.assets.insert({
        id: "prd-1",
        projectId: project.id,
        type: AssetType.ASSET_TYPE_PRD,
        filename: "payment.md",
        sizeBytes: 100,
        createdAt: new Date().toISOString(),
        contentRef: "prds/payment.md",
        apiDoc: "",
        textContent: "",
        fileCount: 0,
        storedFiles: [],
      });
      // A sibling project must survive the cascade untouched.
      const sibling = makeProject();
      db.projects.create(sibling);
      const siblingEnv = makeEnv(sibling);
      db.envs.create(siblingEnv);
      const siblingCase = makeCase(sibling);
      db.cases.create(siblingCase);

      const result = db.projects.removeCascade(project.id);

      assert.ok(result.artifactKeys.includes(artifactKey));
      assert.ok(result.artifactKeys.includes("prds/payment.md"));
      assert.deepEqual(result.counts, { runs: 1, cases: 1, envs: 1, assets: 1 });
      assert.equal(db.projects.get(project.id), undefined);
      assert.equal(db.envs.get(env.id), undefined);
      assert.equal(db.cases.get(kase.id), undefined);
      assert.equal(db.runs.get(run.id), undefined);
      assert.equal(db.assets.get("prd-1"), undefined);
      // Cascade rows hang off the run and must be gone too.
      assert.equal(db.artifacts.get("art-1"), undefined);
      assert.ok(db.projects.exists(sibling.id));
      assert.ok(db.envs.get(siblingEnv.id));
      assert.ok(db.cases.get(siblingCase.id));
    } finally {
      db.close();
    }
  });

  it("removeCascade throws NotFoundError for unknown projects", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(() => db.projects.removeCascade("missing"), NotFoundError);
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
        isDefault: true,
        vars: { region: "staging", tier: "qa" },
        credentials: { account: "qa/abcdef" },
      });
      db.envs.create(env);
      assert.deepEqual(db.envs.getRequired(env.id), env);
    } finally {
      db.close();
    }
  });

  it("round-trips agent limits and clears them back to defaults", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const env = makeEnv(project, {
        agentLimits: { maxSteps: 8, tokenBudget: 50_000, timeoutMin: 1 },
      });
      db.envs.create(env);
      assert.deepEqual(db.envs.getRequired(env.id).agentLimits, {
        maxSteps: 8,
        tokenBudget: 50_000,
        timeoutMin: 1,
      });

      // Writing 0 values ("not set") reads back as undefined so the kernel
      // falls back to the agent definition's defaults.
      const env2 = makeEnv(project, { name: "no-limits" });
      db.envs.create(env2);
      assert.equal(db.envs.getRequired(env2.id).agentLimits, undefined);

      db.envs.update({ ...env, agentLimits: { maxSteps: 0, tokenBudget: 0, timeoutMin: 0 } });
      assert.equal(db.envs.getRequired(env.id).agentLimits, undefined);
    } finally {
      db.close();
    }
  });

  it("makes the project's first env the default automatically", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const first = db.envs.create(makeEnv(project, { name: "dev" }));
      const second = db.envs.create(makeEnv(project, { name: "staging" }));
      assert.equal(first.isDefault, true);
      assert.equal(second.isDefault, false);
      assert.deepEqual(
        db.envs.listByProject(project.id).map((e) => e.isDefault),
        [true, false],
      );
    } finally {
      db.close();
    }
  });

  it("keeps at most one default per project when switching via update", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      db.envs.create(makeEnv(project, { name: "dev" }));
      const staging = db.envs.create(makeEnv(project, { name: "staging" }));
      db.envs.update({ ...staging, isDefault: true });
      assert.deepEqual(
        db.envs.listByProject(project.id).map((e) => e.isDefault),
        [false, true],
      );
    } finally {
      db.close();
    }
  });

  it("defaults stay independent across projects", () => {
    const db = HpathDb.inMemory();
    try {
      const p1 = makeProject();
      const p2 = makeProject();
      db.projects.create(p1);
      db.projects.create(p2);
      db.envs.create(makeEnv(p1, { name: "dev" }));
      db.envs.create(makeEnv(p2, { name: "prod" }));
      assert.equal(db.envs.listByProject(p1.id)[0]!.isDefault, true);
      assert.equal(db.envs.listByProject(p2.id)[0]!.isDefault, true);
    } finally {
      db.close();
    }
  });

  it("deleting the default env promotes the next env by name", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      db.envs.create(makeEnv(project, { name: "alpha", isDefault: true }));
      db.envs.create(makeEnv(project, { name: "zeta" }));
      db.envs.create(makeEnv(project, { name: "mid" }));
      const alpha = db.envs.listByProject(project.id).find((e) => e.name === "alpha")!;
      db.envs.delete(alpha.id);
      assert.deepEqual(
        db.envs.listByProject(project.id).map((e) => [e.name, e.isDefault]),
        [["mid", true], ["zeta", false]],
      );
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

  it("update rejects renaming onto a duplicate name with ConflictError", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      db.envs.create(makeEnv(project, { name: "dev" }));
      db.envs.create(makeEnv(project, { name: "staging" }));
      const dev = db.envs.listByProject(project.id).find((env) => env.name === "dev")!;
      assert.throws(
        () => db.envs.update({ ...dev, name: "staging" }),
        ConflictError,
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

  it("refuses zero-alignment and empty-rule cases (run-path invariant)", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      assert.throws(
        () => db.cases.create(makeCase(project, { alignments: [] })),
        RepositoryError,
      );
      assert.throws(
        () => db.cases.create(makeCase(project, { alignments: [{ apiPath: "", uiAnchor: "", rule: "  " }] })),
        RepositoryError,
      );
      // update() enforces the same invariant.
      const kase = makeCase(project);
      db.cases.create(kase);
      assert.throws(
        () => db.cases.update(kase.id, { title: "t", goal: "g", alignments: [] }),
        RepositoryError,
      );
    } finally {
      db.close();
    }
  });

  it("repairZeroAlignmentCases gives unrunnable cases a placeholder alignment", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      // Raw insert bypasses the repository on purpose: this fixture is the
      // pre-invariant data the startup repair exists for.
      const broken = makeCase(project, { title: "broken" });
      db.database
        .prepare(
          `INSERT INTO cases (id, project_id, title, goal, creator_type, creator_name,
                              creator_run_ref, status, source_prd_ref, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          broken.id,
          broken.projectId,
          broken.title,
          broken.goal,
          broken.creator?.type ?? 0,
          broken.creator?.name ?? "",
          broken.creator?.runRef ?? "",
          broken.status,
          broken.sourcePrdRef,
          broken.version,
          broken.createdAt,
          broken.updatedAt,
        );
      const healthy = makeCase(project, { title: "healthy" });
      db.cases.create(healthy);

      const repaired = repairZeroAlignmentCases(
        db.database,
        "The PRD logic must hold across frontend display and backend output.",
      );
      assert.equal(repaired, 1);
      const fixed = db.cases.getRequired(broken.id);
      assert.equal(fixed.alignments.length, 1);
      assert.ok(fixed.alignments[0]!.rule.includes("PRD logic"));
      // Idempotent: the healthy case is untouched and a second pass is a no-op.
      assert.equal(db.cases.getRequired(healthy.id).alignments.length, 1);
      assert.equal(repairZeroAlignmentCases(db.database, "x"), 0);
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

  it("update: replaces title/goal/alignments with version bump and changelog entry", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const kase = makeCase(project, { status: CaseStatus.CASE_STATUS_PENDING, version: 3 });
      db.cases.create(kase);

      const updated = db.cases.update(
        kase.id,
        {
          title: "renamed case",
          goal: "New goal.",
          alignments: [
            { apiPath: "/api/a", uiAnchor: "Anchor A", rule: "Rule A." },
            { apiPath: "/api/b", uiAnchor: "Anchor B", rule: "Rule B." },
          ],
        },
        { author: "alice", comment: "Tightened the rule" },
      );
      assert.equal(updated.title, "renamed case");
      assert.equal(updated.goal, "New goal.");
      assert.equal(updated.alignments.length, 2);
      assert.deepEqual(updated.alignments.map((a) => a.apiPath), ["/api/a", "/api/b"]);
      assert.equal(updated.status, CaseStatus.CASE_STATUS_PENDING);
      assert.equal(updated.version, 4);
      const last = updated.changelog[updated.changelog.length - 1]!;
      assert.equal(last.version, 4);
      assert.equal(last.author, "alice");
      assert.equal(last.comment, "Tightened the rule");
      // Stored state matches the returned round trip (alignments replaced).
      assert.deepEqual(db.cases.getRequired(kase.id), updated);
    } finally {
      db.close();
    }
  });

  it("update defaults the changelog author/comment and refuses APPROVED cases", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const approved = makeCase(project);
      db.cases.create(approved);
      assert.throws(
        () =>
          db.cases.update(approved.id, {
            title: "x",
            goal: "y",
            alignments: [{ apiPath: "", uiAnchor: "", rule: "keep" }],
          }),
        InvalidTransitionError,
      );
      assert.throws(
        () =>
          db.cases.update("missing", {
            title: "x",
            goal: "y",
            alignments: [{ apiPath: "", uiAnchor: "", rule: "keep" }],
          }),
        NotFoundError,
      );

      // DISABLED cases are editable again (fix, then re-approve).
      db.cases.review(approved.id, ReviewAction.REVIEW_ACTION_DISABLE);
      const updated = db.cases.update(approved.id, {
        title: "fixed title",
        goal: "fixed goal",
        alignments: [{ apiPath: "/api/x", uiAnchor: "Card", rule: "Values agree." }],
      });
      assert.equal(updated.status, CaseStatus.CASE_STATUS_DISABLED);
      const last = updated.changelog[updated.changelog.length - 1]!;
      assert.equal(last.author, "editor");
      assert.equal(last.comment, "Updated manually");
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

describe("AssetRepository", () => {
  it("round-trips a PRD asset and lists per project", () => {
    const db = HpathDb.inMemory();
    try {
      const p1 = makeProject();
      const p2 = makeProject();
      db.projects.create(p1);
      db.projects.create(p2);
      const prd = {
        id: "prd-1",
        projectId: p1.id,
        type: AssetType.ASSET_TYPE_PRD,
        filename: "payment.md",
        sizeBytes: 2048,
        createdAt: "2026-01-01T00:00:00.000Z",
        contentRef: "artifacts/p/prds/payment.md",
        apiDoc: "",
        textContent: "",
        fileCount: 0,
        storedFiles: [{ filename: "payment.md", key: "artifacts/p/prds/payment.md" }],
      };
      db.assets.insert(prd);
      db.assets.insert({ ...prd, id: "prd-2", projectId: p2.id });

      assert.equal(db.assets.getRequired("prd-1").filename, prd.filename);
      assert.equal(db.assets.listByProject(p1.id).length, 1);
      assert.deepEqual(db.assets.listByProject(p2.id).map((p) => p.id), ["prd-2"]);
      assert.throws(() => db.assets.getRequired("missing"), NotFoundError);

      // Manifest round-trip + delete returns the stored-file refs for purge.
      const full = db.assets.getFull("prd-1");
      assert.deepEqual(full?.storedFiles, prd.storedFiles);
      assert.deepEqual(db.assets.remove("prd-1"), prd.storedFiles);
      assert.equal(db.assets.get("prd-1"), undefined);
    } finally {
      db.close();
    }
  });

  it("round-trips a proto asset with its parsed API surface", () => {
    const db = HpathDb.inMemory();
    try {
      const project = makeProject();
      db.projects.create(project);
      const methods = [
        {
          service: "demo.v1.BalanceService",
          method: "GetBalance",
          request: "demo.v1.GetBalanceRequest",
          response: "demo.v1.GetBalanceResponse",
          comment: "Get the balance.",
          doc: "### demo.v1.BalanceService/GetBalance",
        },
      ];
      const proto = {
        id: "proto-1",
        projectId: project.id,
        type: AssetType.ASSET_TYPE_PROTO,
        filename: "balance.proto",
        sizeBytes: 500,
        createdAt: "2026-01-01T00:00:00.000Z",
        contentRef: "artifacts/p/-/asset/proto-1/balance.proto",
        apiDoc: "# API surface",
        textContent: "",
        fileCount: 0,
        methodsJson: JSON.stringify(methods),
        storedFiles: [{ filename: "balance.proto", key: "artifacts/p/-/asset/proto-1/balance.proto" }],
      };
      db.assets.insert(proto);

      // Type filter: only the proto asset matches.
      assert.deepEqual(db.assets.listByProject(project.id, AssetType.ASSET_TYPE_PROTO).map((a) => a.id), ["proto-1"]);
      assert.deepEqual(db.assets.listByProject(project.id, AssetType.ASSET_TYPE_PRD).map((a) => a.id), []);

      const full = db.assets.getFull("proto-1");
      assert.equal(full?.apiDoc, "# API surface");
      assert.equal(full?.methodsJson, proto.methodsJson);
      assert.equal(db.assets.get("proto-1")?.fileCount, 1);
    } finally {
      db.close();
    }
  });

  it("rejects assets for unknown projects with ForeignKeyError", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () =>
          db.assets.insert({
            id: "asset-x",
            projectId: "no-such-project",
            type: AssetType.ASSET_TYPE_PRD,
            filename: "payment.md",
            sizeBytes: 1,
            createdAt: new Date().toISOString(),
            contentRef: "",
            apiDoc: "",
            textContent: "",
            fileCount: 0,
            storedFiles: [],
          }),
        ForeignKeyError,
      );
    } finally {
      db.close();
    }
  });
});
