// SQLite schema migrations (T5).
//
// Migrations run in order on every open; applied ones are tracked in the
// schema_migrations table, so each migration executes exactly once. New
// migrations are appended to MIGRATIONS — never edit an applied migration.

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_init",
    sql: `
      -- Top-level grouping; holds envs, cases, PRDs and runs.
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        repo_url    TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );

      -- Named target of a project (dev / staging / ...). Map fields are stored
      -- as JSON documents. UNIQUE(project_id, name) forbids duplicate env names
      -- inside one project; UNIQUE(id, project_id) lets runs reference an env
      -- together with its project so the namespace is enforced by the FK.
      CREATE TABLE envs (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id),
        name           TEXT NOT NULL,
        web_base_url   TEXT NOT NULL DEFAULT '',
        grpc_address   TEXT NOT NULL DEFAULT '',
        vars_json      TEXT NOT NULL DEFAULT '{}',
        credentials_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (project_id, name),
        UNIQUE (id, project_id)
      );

      -- Test case definition (not a step script). Creator, review status
      -- workflow and version/changelog live here; alignments and changelog
      -- entries are child tables. UNIQUE(id, project_id) supports the
      -- composite run FK namespace check.
      CREATE TABLE cases (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id),
        title           TEXT NOT NULL,
        goal            TEXT NOT NULL DEFAULT '',
        creator_type    INTEGER NOT NULL DEFAULT 0,
        creator_name    TEXT NOT NULL DEFAULT '',
        creator_run_ref TEXT NOT NULL DEFAULT '',
        status          INTEGER NOT NULL DEFAULT 1, -- CASE_STATUS_DRAFT
        source_prd_ref  TEXT NOT NULL DEFAULT '',
        version         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (id, project_id)
      );

      -- Ordered three-way alignment declarations of a case.
      CREATE TABLE case_alignments (
        case_id    TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        idx        INTEGER NOT NULL,
        api_path   TEXT NOT NULL DEFAULT '',
        ui_anchor  TEXT NOT NULL DEFAULT '',
        rule       TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (case_id, idx)
      );

      -- One entry per case version bump (create/review/edit).
      CREATE TABLE case_changelog (
        case_id     TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        author      TEXT NOT NULL DEFAULT '',
        comment     TEXT NOT NULL DEFAULT '',
        changed_at  TEXT NOT NULL,
        PRIMARY KEY (case_id, version)
      );

      -- One execution of a case against one env. The composite foreign keys
      -- pin env and case to the run's project: a run whose env or case belongs
      -- to a different project is rejected at the database level.
      CREATE TABLE runs (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        env_id       TEXT NOT NULL,
        case_id      TEXT NOT NULL,
        status       INTEGER NOT NULL DEFAULT 1, -- RUN_STATUS_PENDING
        trigger_kind INTEGER NOT NULL DEFAULT 0, -- RUN_TRIGGER_UNSPECIFIED
        verdict_json TEXT,
        started_at   TEXT NOT NULL,
        finished_at  TEXT NOT NULL DEFAULT '',
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        token_cost   INTEGER NOT NULL DEFAULT 0,
        fail_reason  TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (env_id, project_id) REFERENCES envs(id, project_id),
        FOREIGN KEY (case_id, project_id) REFERENCES cases(id, project_id)
      );

      -- Ordered streamed events of a run. The oneof payload is stored as a
      -- JSON document in payload_json.
      CREATE TABLE events (
        run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq          INTEGER NOT NULL,
        timestamp    TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      -- Binary evidence metadata; bytes live in the artifact store (T6).
      CREATE TABLE artifacts (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind       INTEGER NOT NULL DEFAULT 0,
        key        TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      -- Uploaded PRD documents.
      CREATE TABLE prds (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        filename    TEXT NOT NULL,
        format      INTEGER NOT NULL DEFAULT 0,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        content_ref TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX idx_envs_project ON envs(project_id);
      CREATE INDEX idx_cases_project_status ON cases(project_id, status);
      CREATE INDEX idx_runs_project ON runs(project_id);
      CREATE INDEX idx_runs_env ON runs(env_id);
      CREATE INDEX idx_runs_case ON runs(case_id);
      CREATE INDEX idx_artifacts_run ON artifacts(run_id);
      CREATE INDEX idx_prds_project ON prds(project_id);
    `,
  },
  {
    name: "0002_artifact_run_key_unique",
    sql: `
      -- Re-uploading a run's store key must refresh one row, never duplicate:
      -- the run pipeline upserts artifacts on (run_id, key), and this index
      -- makes that conflict target enforceable at the database level.
      CREATE UNIQUE INDEX idx_artifacts_run_key ON artifacts(run_id, key);
    `,
  },
];

function nowIso(): string {
  return new Date().toISOString();
}

/** Applies all pending migrations. Safe to call on every open. */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare("SELECT name FROM schema_migrations").all();
  const applied = new Set(appliedRows.map((row) => String(row.name)));
  const insert = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) {
      continue;
    }
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      insert.run(migration.name, nowIso());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
