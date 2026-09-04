// SQLite persistence layer for the real server mode (T5: data model +
// migrations + repository layer). T3 wires the read RPCs to HpathDb; T6 adds
// the artifact store alongside it.

export { openDatabase, defaultDbPath, DEFAULT_DB_PATH } from "./database.js";
export { MIGRATIONS, migrate, type Migration } from "./migrations.js";
export {
  RepositoryError,
  NotFoundError,
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  translateConstraintError,
} from "./errors.js";

export { ProjectRepository } from "./repositories/projects.js";
export { EnvRepository } from "./repositories/envs.js";
export { CaseRepository } from "./repositories/cases.js";
export { RunRepository, type RunFilter, type RunFinishPatch } from "./repositories/runs.js";
export { EventRepository } from "./repositories/events.js";
export { ArtifactRepository } from "./repositories/artifacts.js";
export { PrdRepository } from "./repositories/prds.js";
export {
  ChatSessionRepository,
  ChatMessageRepository,
  CHAT_MESSAGE_LIMIT,
} from "./repositories/chat.js";

import type { DatabaseSync } from "node:sqlite";
import { openDatabase, defaultDbPath } from "./database.js";
import { ProjectRepository } from "./repositories/projects.js";
import { EnvRepository } from "./repositories/envs.js";
import { CaseRepository } from "./repositories/cases.js";
import { RunRepository } from "./repositories/runs.js";
import { EventRepository } from "./repositories/events.js";
import { ArtifactRepository } from "./repositories/artifacts.js";
import { PrdRepository } from "./repositories/prds.js";
import { ChatSessionRepository, ChatMessageRepository } from "./repositories/chat.js";

/**
 * Facade bundling the raw connection with one repository per table. Open with
 * `HpathDb.open(path?)`; tests use `HpathDb.inMemory()`.
 */
export class HpathDb {
  readonly projects: ProjectRepository;
  readonly envs: EnvRepository;
  readonly cases: CaseRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly artifacts: ArtifactRepository;
  readonly prds: PrdRepository;
  readonly chatSessions: ChatSessionRepository;
  readonly chatMessages: ChatMessageRepository;

  private constructor(readonly database: DatabaseSync) {
    this.projects = new ProjectRepository(database);
    this.envs = new EnvRepository(database);
    this.cases = new CaseRepository(database);
    this.runs = new RunRepository(database);
    this.events = new EventRepository(database);
    this.artifacts = new ArtifactRepository(database);
    this.prds = new PrdRepository(database);
    this.chatSessions = new ChatSessionRepository(database);
    this.chatMessages = new ChatMessageRepository(database);
  }

  /** Open (and migrate) the database at `path`, defaulting to HPATH_DB_PATH. */
  static open(path: string = defaultDbPath()): HpathDb {
    return new HpathDb(openDatabase(path));
  }

  /** Ephemeral database for tests. */
  static inMemory(): HpathDb {
    return new HpathDb(openDatabase(":memory:"));
  }

  close(): void {
    this.database.close();
  }
}
