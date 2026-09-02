// Database open/bootstrap for the real (non-mock) server mode (T5).
//
// Uses the built-in node:sqlite driver: zero extra dependencies, synchronous
// API (fine for the spike's request rates). Every opened connection gets
// foreign keys enabled and pending migrations applied.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

/** Default database file location, relative to the working directory. */
export const DEFAULT_DB_PATH = "data/hpath.db";

/** Database path from HPATH_DB_PATH, falling back to data/hpath.db. */
export function defaultDbPath(): string {
  return process.env.HPATH_DB_PATH ?? DEFAULT_DB_PATH;
}

/**
 * Open (creating if needed) the SQLite database at `path`, enable the pragmas
 * HPath relies on, and apply pending migrations.
 *
 * `:memory:` keeps everything in RAM (used by tests).
 */
export function openDatabase(path: string = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // Write-ahead logging: readers do not block the writer during runs.
  db.exec("PRAGMA journal_mode = WAL;");
  // Required: SQLite ships with FK enforcement OFF by default.
  db.exec("PRAGMA foreign_keys = ON;");
  // Fail fast instead of throwing SQLITE_BUSY immediately on lock contention.
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}
