// Typed errors for the SQLite repository layer (T5). The gRPC handler layer
// (T3+) maps these onto status codes:
//   NotFoundError         -> NOT_FOUND
//   ConflictError         -> ALREADY_EXISTS
//   ForeignKeyError       -> ALREADY_EXISTS (e.g. env still has runs) or
//                            INVALID_ARGUMENT, depending on context
//   InvalidTransitionError-> FAILED_PRECONDITION
//   RepositoryError       -> INTERNAL (fallback)

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

/** Row or entity does not exist. */
export class NotFoundError extends RepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Uniqueness conflict (duplicate project name, duplicate env name, ...). */
export class ConflictError extends RepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A foreign-key constraint rejected the write (missing or cross-project parent). */
export class ForeignKeyError extends RepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "ForeignKeyError";
  }
}

/** Case review action not valid for the case's current status. */
export class InvalidTransitionError extends RepositoryError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

// node:sqlite reports SQLite failures as plain Error objects carrying the
// numeric extended result code in `errcode`. Every CONSTRAINT family code has
// the base code 19 in its low byte (e.g. 787 = CONSTRAINT_FOREIGNKEY,
// 2067 = CONSTRAINT_UNIQUE, 1555 = CONSTRAINT_PRIMARYKEY).
const SQLITE_CONSTRAINT = 19;

interface SqliteErrorShape {
  errcode?: unknown;
  message?: unknown;
}

function isSqliteConstraintError(err: unknown): err is Required<SqliteErrorShape> {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as SqliteErrorShape).errcode === "number" &&
    ((err as { errcode: number }).errcode % 256) === SQLITE_CONSTRAINT
  );
}

/**
 * Translate a raw SQLite constraint failure into a typed repository error.
 * `context` names the operation, e.g. "create env". Non-constraint errors are
 * returned untouched so unexpected failures stay loud.
 */
export function translateConstraintError(err: unknown, context: string): unknown {
  if (!isSqliteConstraintError(err)) {
    return err;
  }
  const message = String(err.message ?? "constraint failed");
  if (message.includes("FOREIGN KEY")) {
    return new ForeignKeyError(
      `${context}: referenced entity does not exist or belongs to another namespace`,
    );
  }
  if (message.includes("UNIQUE")) {
    return new ConflictError(`${context}: a unique field value already exists`);
  }
  return new RepositoryError(`${context}: ${message}`);
}
