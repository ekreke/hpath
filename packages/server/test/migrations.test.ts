// Migration tests (T5): schema creation and idempotent re-application.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HpathDb, MIGRATIONS } from "../src/db/index.js";

const EXPECTED_TABLES = [
  "projects",
  "envs",
  "cases",
  "case_alignments",
  "case_changelog",
  "runs",
  "events",
  "artifacts",
  "prds",
  "chat_sessions",
  "chat_messages",
];

function tableNames(db: HpathDb): string[] {
  const rows = db.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  return rows.map((row) => String(row.name));
}

describe("migrations", () => {
  it("create every T5 table on a fresh in-memory database", () => {
    const db = HpathDb.inMemory();
    try {
      const tables = tableNames(db);
      for (const expected of EXPECTED_TABLES) {
        assert.ok(tables.includes(expected), `missing table: ${expected}`);
      }
    } finally {
      db.close();
    }
  });

  it("record each applied migration exactly once and re-open cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpath-db-"));
    const path = join(dir, "hpath.db");
    const first = HpathDb.open(path);
    first.close();

    // Second open on the same file: migrations must be a no-op, not a crash.
    const second = HpathDb.open(path);
    try {
      const applied = second.database
        .prepare("SELECT name FROM schema_migrations ORDER BY name")
        .all()
        .map((row) => String(row.name));
      assert.deepEqual(applied, MIGRATIONS.map((migration) => migration.name));
    } finally {
      second.close();
    }
  });

  it("start from an empty data set", () => {
    const db = HpathDb.inMemory();
    try {
      assert.deepEqual(db.projects.list(), []);
      assert.deepEqual(db.envs.listByProject("nope"), []);
      assert.deepEqual(db.cases.listByProject("nope"), []);
      assert.deepEqual(db.runs.list({ projectId: "nope" }), []);
    } finally {
      db.close();
    }
  });

  it("0003 backfills one default env per existing project", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpath-db-"));
    const path = join(dir, "hpath.db");
    // Build a pre-0003 database: apply the first two migrations only, insert
    // projects and envs, then open with the full stack so 0003 runs.
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of MIGRATIONS.slice(0, 2)) {
      raw.exec(migration.sql);
      raw
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(migration.name, "2026-01-01T00:00:00.000Z");
    }
    const insertProject = raw.prepare(
      "INSERT INTO projects (id, name, repo_url, created_at) VALUES (?, ?, ?, ?)",
    );
    insertProject.run("p1", "one", "", "2026-01-01T00:00:00.000Z");
    insertProject.run("p2", "two", "", "2026-01-01T00:00:00.000Z");
    const insertEnv = raw.prepare(
      "INSERT INTO envs (id, project_id, name, web_base_url, grpc_address, vars_json, credentials_json) VALUES (?, ?, ?, '', '', '{}', '{}')",
    );
    insertEnv.run("e1", "p1", "alpha");
    insertEnv.run("e2", "p1", "beta");
    insertEnv.run("e3", "p2", "only");
    raw.close();

    const db = HpathDb.open(path);
    try {
      // The backfill promotes each project's first env by name.
      assert.deepEqual(
        db.envs.listByProject("p1").map((e) => [e.name, e.isDefault]),
        [["alpha", true], ["beta", false]],
      );
      assert.deepEqual(
        db.envs.listByProject("p2").map((e) => [e.name, e.isDefault]),
        [["only", true]],
      );
    } finally {
      db.close();
    }
  });
});

