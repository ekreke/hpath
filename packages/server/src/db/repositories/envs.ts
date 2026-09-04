// Env repository (T5): CRUD over the envs table. The project-scoped default
// env invariant (at most one is_default per project) is enforced by the
// partial unique index idx_envs_default_per_project; the repository keeps
// the flag consistent on create/update/delete using clear-then-set writes.

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
  is_default: number;
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
    isDefault: row.is_default === 1,
  };
}

export class EnvRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert a fully-formed env. Rejects unknown projects and duplicate names. */
  create(env: Env): Env {
    // The first env of a project becomes the default automatically, so a
    // fresh project always has a selected env out of the box.
    const wantsDefault = env.isDefault || !this.hasDefault(env.projectId);
    try {
      if (wantsDefault) {
        this.clearDefault(env.projectId);
      }
      this.db
        .prepare(
          `INSERT INTO envs (id, project_id, name, web_base_url, grpc_address, vars_json, credentials_json, is_default)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          env.id,
          env.projectId,
          env.name,
          env.webBaseUrl,
          env.grpcAddress,
          JSON.stringify(env.vars ?? {}),
          JSON.stringify(env.credentials ?? {}),
          wantsDefault ? 1 : 0,
        );
    } catch (err) {
      throw translateConstraintError(err, `create env "${env.name}"`);
    }
    return { ...env, isDefault: wantsDefault };
  }

  /** Update an existing env. Throws NotFoundError for unknown ids and ConflictError on duplicate names. */
  update(env: Env): Env {
    let info;
    try {
      if (env.isDefault) {
        this.clearDefault(env.projectId);
      }
      info = this.db
        .prepare(
          `UPDATE envs
           SET name = ?, web_base_url = ?, grpc_address = ?, vars_json = ?, credentials_json = ?, is_default = ?
           WHERE id = ?`,
        )
        .run(
          env.name,
          env.webBaseUrl,
          env.grpcAddress,
          JSON.stringify(env.vars ?? {}),
          JSON.stringify(env.credentials ?? {}),
          env.isDefault ? 1 : 0,
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
   * stays. Deleting the default env promotes the project's next env by name,
   * so a project never loses its default while envs remain.
   */
  delete(id: string): void {
    let info;
    try {
      const existing = this.get(id);
      if (existing && existing.isDefault) {
        this.clearDefault(existing.projectId);
        this.promoteNextDefault(existing.projectId, id);
      }
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

  private hasDefault(projectId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM envs WHERE project_id = ? AND is_default = 1")
      .get(projectId);
    return row !== undefined;
  }

  private clearDefault(projectId: string): void {
    this.db
      .prepare("UPDATE envs SET is_default = 0 WHERE project_id = ? AND is_default = 1")
      .run(projectId);
  }

  private promoteNextDefault(projectId: string, excludeId: string): void {
    this.db
      .prepare(
        `UPDATE envs SET is_default = 1
         WHERE id = (
           SELECT id FROM envs
           WHERE project_id = ? AND id != ?
           ORDER BY name
           LIMIT 1
         )`,
      )
      .run(projectId, excludeId);
  }
}
