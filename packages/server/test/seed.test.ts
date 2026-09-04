// Seed tests (T3): a first boot fills SQLite with the same demo content the
// mock mode serves, seeding is idempotent across reboots, and the bundled PRD
// fixtures exist in all three formats (md/docx/pdf).

import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Env } from "@hpath/contract";
import {
  CaseStatus,
  CreatorType,
  PrdFormat,
  RunStatus,
  RunTrigger,
  VerdictStatus,
} from "@hpath/contract";
import { HpathDb } from "../src/db/index.js";
import { withTransaction } from "../src/db/database.js";
import { prdFixturesDir, seedDatabase } from "../src/db/seed.js";

describe("seedDatabase", () => {
  it("seeds a fresh database with the demo project, envs, cases, runs and PRDs", () => {
    const db = HpathDb.inMemory();
    try {
      const seed = seedDatabase(db);
      assert.ok(seed, "fresh database must be seeded");

      // Project: demo-bank with metadata repo_url.
      const projects = db.projects.list();
      assert.equal(projects.length, 1);
      assert.equal(projects[0]!.name, "demo-bank");
      assert.equal(projects[0]!.repoUrl, "https://github.com/example/demo-bank");

      // Envs: dev + staging with the mock's connection data.
      const envs = db.envs.listByProject(seed.project.id);
      assert.deepEqual(
        envs.map((env) => env.name),
        ["dev", "staging"],
      );
      const dev = envs.find((env) => env.name === "dev")!;
      assert.equal(dev.webBaseUrl, "http://localhost:8081");
      assert.deepEqual(dev.credentials, { username: "demo", password: "demo1234" });

      // Cases: 4 approved (incl. the two scripted probes) + 1 pending agent draft.
      const cases = db.cases.listByProject(seed.project.id);
      assert.equal(cases.length, 5);
      assert.equal(cases.filter((kase) => kase.status === CaseStatus.CASE_STATUS_APPROVED).length, 4);
      const titles = cases.map((kase) => kase.title);
      assert.ok(titles.includes("Limit probe hits the hard step budget"), "hard-limit probe seeded");
      assert.ok(titles.includes("Balance drift fails the alignment check"), "alignment-drift probe seeded");
      const pending = cases.find((kase) => kase.status === CaseStatus.CASE_STATUS_PENDING)!;
      assert.equal(pending.creator?.type, CreatorType.CREATOR_TYPE_AGENT);
      assert.equal(pending.creator?.name, "analyze-agent");

      // Case round-trip: alignments and changelog survive the repository.
      const login = db.cases.getRequired(seed.cases.login.id);
      assert.deepEqual(login, seed.cases.login);
      assert.ok(login.alignments.length >= 1);
      assert.ok(login.changelog.length >= 1);

      // Runs: 2 finished (1 passed on dev/manual, 1 failed on staging/agent).
      const runs = db.runs.list({ projectId: seed.project.id });
      assert.equal(runs.length, 2);
      const passed = runs.find((run) => run.id === seed.runs.passed.id)!;
      assert.equal(passed.status, RunStatus.RUN_STATUS_PASSED);
      assert.equal(passed.trigger, RunTrigger.RUN_TRIGGER_MANUAL);
      assert.equal(passed.envId, seed.envs.dev.id);
      assert.equal(passed.verdict?.status, VerdictStatus.VERDICT_STATUS_PASSED);
      assert.notEqual(passed.finishedAt, "");
      const failed = runs.find((run) => run.id === seed.runs.failed.id)!;
      assert.equal(failed.status, RunStatus.RUN_STATUS_FAILED);
      assert.equal(failed.trigger, RunTrigger.RUN_TRIGGER_AGENT);
      assert.equal(failed.envId, seed.envs.staging.id);
      assert.equal(failed.verdict?.status, VerdictStatus.VERDICT_STATUS_FAILED);
      assert.equal(failed.failReason, "alignment mismatch");
      assert.ok(failed.durationMs > 0);
      assert.ok(failed.tokenCost > 0);
      assert.notEqual(failed.finishedAt, "");

      // Event transcripts: ordered, terminal status last.
      const events = db.events.listForRun(seed.runs.passed.id);
      assert.ok(events.length >= 10, `passed run has ${events.length} events`);
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, i) => i + 1),
      );
      assert.equal(events[0]!.runStatus?.status, RunStatus.RUN_STATUS_RUNNING);
      assert.equal(events.at(-1)!.runStatus?.status, RunStatus.RUN_STATUS_PASSED);
      const verdictEvent = events.find((event) => event.verdict);
      assert.equal(verdictEvent?.verdict?.status, VerdictStatus.VERDICT_STATUS_PASSED);

      // PRDs: the three bundled fixtures (md/docx/pdf), sizes from disk.
      const prds = db.prds.listByProject(seed.project.id);
      assert.deepEqual(
        prds.map((prd) => prd.format),
        [PrdFormat.PRD_FORMAT_MD, PrdFormat.PRD_FORMAT_DOCX, PrdFormat.PRD_FORMAT_PDF],
      );
      for (const prd of prds) {
        const file = join(prdFixturesDir(), prd.filename);
        assert.ok(existsSync(file), `fixture exists: ${prd.filename}`);
        assert.equal(prd.sizeBytes, statSync(file).size);
        assert.ok(prd.contentRef.startsWith("fixtures/prds/"));
      }
    } finally {
      db.close();
    }
  });

  it("is a no-op when the database already contains projects", () => {
    const db = HpathDb.inMemory();
    try {
      const first = seedDatabase(db);
      assert.ok(first);
      const again = seedDatabase(db);
      assert.equal(again, undefined);
      assert.equal(db.projects.list().length, 1);
      assert.equal(db.cases.listByProject(first!.project.id).length, 5);
      assert.equal(db.runs.list({ projectId: first!.project.id }).length, 2);
      assert.equal(db.prds.listByProject(first!.project.id).length, 3);
    } finally {
      db.close();
    }
  });

  it("persists across a close/reopen cycle without re-seeding (fresh boot)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpath-seed-"));
    const path = join(dir, "hpath.db");
    let projectId: string;
    {
      const db = HpathDb.open(path);
      try {
        const seed = seedDatabase(db);
        assert.ok(seed);
        projectId = seed!.project.id;
      } finally {
        db.close();
      }
    }
    const reopened = HpathDb.open(path);
    try {
      assert.equal(seedDatabase(reopened), undefined, "reboot must not duplicate the seed");
      assert.equal(reopened.projects.getRequired(projectId).name, "demo-bank");
    } finally {
      reopened.close();
    }
  });

  it("rolls the whole seed back when any step fails, so the next boot re-seeds cleanly", () => {
    const db = HpathDb.inMemory();
    try {
      const originalCreate = db.envs.create.bind(db.envs);
      let envCalls = 0;
      // Fail on the second env insert (staging) to abort the seed mid-way.
      db.envs.create = ((env: Env) => {
        envCalls += 1;
        if (envCalls === 2) {
          throw new Error("injected seed failure");
        }
        return originalCreate(env);
      }) as typeof db.envs.create;

      assert.throws(() => seedDatabase(db), /injected seed failure/);
      // No residue: the project inserted before the failure was rolled back.
      assert.equal(db.projects.list().length, 0);

      db.envs.create = originalCreate;
      const seed = seedDatabase(db);
      assert.ok(seed, "a fresh boot after the failure re-seeds fully");
      assert.equal(db.projects.list().length, 1);
      assert.equal(db.cases.listByProject(seed!.project.id).length, 5);
      assert.equal(db.runs.list({ projectId: seed!.project.id }).length, 2);
      assert.equal(db.prds.listByProject(seed!.project.id).length, 3);
    } finally {
      db.close();
    }
  });
});

describe("withTransaction", () => {
  it("nests: an inner rollback leaves the outer scope intact (SAVEPOINT)", () => {
    const db = HpathDb.inMemory();
    try {
      withTransaction(db.database, () => {
        db.database.exec(
          "INSERT INTO projects (id, name, created_at) VALUES ('p1', 'n1', '2026-01-01T00:00:00.000Z')",
        );
        assert.throws(
          () =>
            withTransaction(db.database, () => {
              db.database.exec(
                "INSERT INTO projects (id, name, created_at) VALUES ('p2', 'n2', '2026-01-01T00:00:00.000Z')",
              );
              throw new Error("inner boom");
            }),
          /inner boom/,
        );
        // Inner work rolled back; outer work still pending, then commits.
      });
      assert.equal(db.projects.get("p1")?.name, "n1");
      assert.equal(db.projects.get("p2"), undefined);
    } finally {
      db.close();
    }
  });

  it("rolls back the whole transaction when the top-level scope fails", () => {
    const db = HpathDb.inMemory();
    try {
      assert.throws(
        () =>
          withTransaction(db.database, () => {
            db.database.exec(
              "INSERT INTO projects (id, name, created_at) VALUES ('p1', 'n1', '2026-01-01T00:00:00.000Z')",
            );
            throw new Error("outer boom");
          }),
        /outer boom/,
      );
      assert.equal(db.projects.get("p1"), undefined);
      // The transaction is fully released: a later write works normally.
      db.database.exec(
        "INSERT INTO projects (id, name, created_at) VALUES ('p2', 'n2', '2026-01-01T00:00:00.000Z')",
      );
      assert.equal(db.projects.get("p2")?.name, "n2");
    } finally {
      db.close();
    }
  });
});
