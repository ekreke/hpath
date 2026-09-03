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

// Nesting depth of withTransaction per open connection. Top-level calls use
// BEGIN/COMMIT; nested calls (a repository method invoked from inside an
// outer transaction) use SAVEPOINT so SQLite's "cannot start a transaction
// within a transaction" never fires and a nested failure rolls back only its
// own work.
const transactionDepth = new WeakMap<DatabaseSync, number>();

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * error. Safe to nest: the innermost active scope uses a SAVEPOINT instead of
 * BEGIN, so callers like `seedDatabase` can wrap multi-repository work while
 * the repositories themselves stay transactional.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const depth = transactionDepth.get(db) ?? 0;
  const savepoint = depth > 0 ? `tx_${depth}` : null;
  try {
    if (savepoint) {
      db.exec(`SAVEPOINT ${savepoint}`);
    } else {
      db.exec("BEGIN");
    }
  } catch (err) {
    throw err;
  }
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    if (savepoint) {
      db.exec(`RELEASE ${savepoint}`);
    } else {
      db.exec("COMMIT");
    }
    transactionDepth.set(db, depth);
    return result;
  } catch (err) {
    try {
      if (savepoint) {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } else {
        db.exec("ROLLBACK");
      }
    } catch {
      // A failed rollback must not mask the original error.
    }
    transactionDepth.set(db, depth);
    throw err;
  }
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
