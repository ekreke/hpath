// PRD repository (T5): uploaded PRD document metadata. Content bytes land in
// the artifact store (T6); content_ref carries the storage key (empty while
// content is transient, mirroring the mock).

import type { DatabaseSync } from "node:sqlite";
import type { Prd, PrdFormat } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

interface PrdRow {
  id: string;
  project_id: string;
  filename: string;
  format: number;
  size_bytes: number;
  created_at: string;
  content_ref: string;
}

function toPrd(row: PrdRow): Prd {
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    format: row.format as PrdFormat,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    contentRef: row.content_ref,
  };
}

export class PrdRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert a PRD record. Rejected with ForeignKeyError for unknown projects. */
  insert(prd: Prd): Prd {
    try {
      this.db
        .prepare(
          `INSERT INTO prds (id, project_id, filename, format, size_bytes, created_at, content_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          prd.id,
          prd.projectId,
          prd.filename,
          prd.format,
          prd.sizeBytes,
          prd.createdAt,
          prd.contentRef,
        );
    } catch (err) {
      throw translateConstraintError(err, `insert PRD "${prd.filename}"`);
    }
    return prd;
  }

  get(id: string): Prd | undefined {
    const row = this.db.prepare("SELECT * FROM prds WHERE id = ?").get(id);
    return row ? toPrd(row as unknown as PrdRow) : undefined;
  }

  getRequired(id: string): Prd {
    const prd = this.get(id);
    if (!prd) {
      throw new NotFoundError(`PRD not found: ${id}`);
    }
    return prd;
  }

  listByProject(projectId: string): Prd[] {
    const rows = this.db
      .prepare("SELECT * FROM prds WHERE project_id = ? ORDER BY created_at, id")
      .all(projectId);
    return rows.map((row) => toPrd(row as unknown as PrdRow));
  }
}
