// Env repository (T5): CRUD over the envs table.

import type { DatabaseSync } from "node:sqlite";
import type { Env } from "@hpath/contract";
import {
  ConflictError,
  ForeignKeyError,
  NotFoundError,
  translateConstraintError,
} from "../errors.js";

interface EnvRow {
  id: string;
  project_id: string;
  name: string;
  web_base_url: string;
  grpc_address: string;
  vars_json: string;
  credentials_json: string;
}

function toEnv(row: EnvRow): Env {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    webBaseUrl: row.web_base_url,
    grpcAddress: row.grpc_address,
    vars: JSON.parse(row.vars_json) as { [key: string]: string },
    credentials: JSON.parse(row.credentials_json) as { [key: string]: string },
  };
}

export class EnvRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert a fully-formed env. Rejects unknown projects and duplicate names. */
  create(env: Env): Env {
    try {
      this.db
        .prepare(
          `INSERT INTO envs (id, project_id, name, web_base_url, grpc_address, vars_json, credentials_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          env.id,
          env.projectId,
          env.name,
          env.webBaseUrl,
          env.grpcAddress,
          JSON.stringify(env.vars ?? {}),
          JSON.stringify(env.credentials ?? {}),
        );
    } catch (err) {
      throw translateConstraintError(err, `create env "${env.name}"`);
    }
    return env;
  }

  /** Update an existing env. Throws NotFoundError for unknown ids and ConflictError on duplicate names. */
  update(env: Env): Env {
    let info;
    try {
      info = this.db
        .prepare(
          `UPDATE envs
           SET name = ?, web_base_url = ?, grpc_address = ?, vars_json = ?, credentials_json = ?
           WHERE id = ?`,
        )
        .run(
          env.name,
          env.webBaseUrl,
          env.grpcAddress,
          JSON.stringify(env.vars ?? {}),
          JSON.stringify(env.credentials ?? {}),
          env.id,
        );
    } catch (err) {
      throw translateConstraintError(err, `update env "${env.name}"`);
    }
    if (Number(info.changes) === 0) {
      throw new NotFoundError(`env not found: ${env.id}`);
    }
    return env;
  }

  get(id: string): Env | undefined {
    const row = this.db.prepare("SELECT * FROM envs WHERE id = ?").get(id);
    return row ? toEnv(row as unknown as EnvRow) : undefined;
  }

  getRequired(id: string): Env {
    const env = this.get(id);
    if (!env) {
      throw new NotFoundError(`env not found: ${id}`);
    }
    return env;
  }

  listByProject(projectId: string): Env[] {
    const rows = this.db
      .prepare("SELECT * FROM envs WHERE project_id = ? ORDER BY name")
      .all(projectId);
    return rows.map((row) => toEnv(row as unknown as EnvRow));
  }

  /**
   * Delete an env. Throws NotFoundError for unknown ids and ConflictError when
   * runs reference the env: the run history is immutable evidence, so the env
   * stays.
   */
  delete(id: string): void {
    let info;
    try {
      info = this.db.prepare("DELETE FROM envs WHERE id = ?").run(id);
    } catch (err) {
      const translated = translateConstraintError(err, `delete env ${id}`);
      if (translated instanceof ForeignKeyError) {
        throw new ConflictError(`env has runs and cannot be deleted: ${id}`);
      }
      throw translated;
    }
    if (Number(info.changes) === 0) {
      throw new NotFoundError(`env not found: ${id}`);
    }
  }
}
