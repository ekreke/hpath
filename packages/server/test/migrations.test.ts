// Migration tests (T5): schema creation and idempotent re-application.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
});
