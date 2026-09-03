// Artifact repository (T5): metadata index for run artifacts. Binary content
// itself lives in the artifact store (T6); this table provides accounting
// (who, what, where, how big) and the id -> key lookup for DownloadArtifact.

import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactKind } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

interface ArtifactRow {
  id: string;
  run_id: string;
  kind: number;
  key: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ArtifactKind,
    key: row.key,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export class ArtifactRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert artifact metadata. Rejected with ForeignKeyError for unknown runs. */
  insert(artifact: Artifact): Artifact {
    try {
      this.db
        .prepare(
          `INSERT INTO artifacts (id, run_id, kind, key, size_bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifact.id,
          artifact.runId,
          artifact.kind,
          artifact.key,
          artifact.sizeBytes,
          artifact.sha256,
          artifact.createdAt,
        );
    } catch (err) {
      throw translateConstraintError(err, `insert artifact ${artifact.id}`);
    }
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    return row ? toArtifact(row as unknown as ArtifactRow) : undefined;
  }

  getRequired(id: string): Artifact {
    const artifact = this.get(id);
    if (!artifact) {
      throw new NotFoundError(`artifact not found: ${id}`);
    }
    return artifact;
  }

  /** All artifacts of a run, ordered by creation time then id. */
  listForRun(runId: string): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id")
      .all(runId);
    return rows.map((row) => toArtifact(row as unknown as ArtifactRow));
  }

  /** Artifact of a run stored under `key`, if any. */
  getByKey(runId: string, key: string): Artifact | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? AND key = ?")
      .get(runId, key);
    return row ? toArtifact(row as unknown as ArtifactRow) : undefined;
  }

  /**
   * Insert-or-update matched on (run_id, key): the store key is the natural
   * identity of a run's evidence file, so re-uploading the same key refreshes
   * kind/size/sha256 and keeps the artifact's id and created_at stable.
   * Rejected with ForeignKeyError for unknown runs.
   */
  upsert(artifact: Artifact): Artifact {
    const existing = this.getByKey(artifact.runId, artifact.key);
    if (!existing) {
      return this.insert(artifact);
    }
    try {
      this.db
        .prepare(
          `UPDATE artifacts SET kind = ?, size_bytes = ?, sha256 = ? WHERE id = ?`,
        )
        .run(artifact.kind, artifact.sizeBytes, artifact.sha256, existing.id);
    } catch (err) {
      throw translateConstraintError(err, `update artifact ${existing.id}`);
    }
    return { ...existing, kind: artifact.kind, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 };
  }
}
