// Asset repository (T22): uploaded project assets — PRD documents and proto
// bundles (parsed into the project's API surface). Replaces the write-only
// prds table (migration 0007 migrates its rows with type 'prd'). Content
// bytes live in the artifact store; content_ref carries the entry file's
// storage key and content_refs_json the full manifest of the upload.

import type { DatabaseSync } from "node:sqlite";
import type { Asset } from "@hpath/contract";
import { AssetType } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

export type AssetRowType = "prd" | "proto";

export interface StoredFileRef {
  filename: string;
  key: string;
}

interface AssetRow {
  id: string;
  project_id: string;
  type: string;
  filename: string;
  size_bytes: number;
  created_at: string;
  content_ref: string;
  content_refs_json: string;
  api_doc: string;
  methods_json: string;
}

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    projectId: row.project_id,
    type: (row.type === "proto" ? AssetType.ASSET_TYPE_PROTO : AssetType.ASSET_TYPE_PRD),
    filename: row.filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    contentRef: row.content_ref,
    apiDoc: row.api_doc,
    fileCount: 0, // computed column; never read back from SQLite directly
  };
}

/** Decode the stored manifest; an empty/garbage column degrades to []. */
export function parseStoredFiles(asset: Asset, refsJson: string): StoredFileRef[] {
  if (!refsJson) return [];
  try {
    const parsed: unknown = JSON.parse(refsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { filename: string; key: string } =>
        typeof entry === "object" && entry !== null
        && typeof (entry as { filename?: unknown }).filename === "string"
        && typeof (entry as { key?: unknown }).key === "string")
      .map((entry) => ({ filename: entry.filename, key: entry.key }));
  } catch {
    return [];
  }
}

/** Parsed proto bundle payload persisted alongside the asset row. */
export interface ProtoSurface {
  apiDoc: string;
  /** Structured method list consumed by the agent wiring (see proto-surface). */
  methodsJson: string;
}

export type AssetInsert = Asset & {
  type: AssetType;
  storedFiles: StoredFileRef[];
} & Partial<ProtoSurface>;

export class AssetRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert an asset record. Rejected with ForeignKeyError for unknown projects. */
  insert(asset: AssetInsert): Asset {
    const refs = asset.storedFiles ?? [];
    try {
      this.db
        .prepare(
          `INSERT INTO assets (id, project_id, type, filename, size_bytes, created_at, content_ref, content_refs_json, api_doc, methods_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          asset.id,
          asset.projectId,
          asset.type === AssetType.ASSET_TYPE_PROTO ? "proto" : "prd",
          asset.filename,
          asset.sizeBytes,
          asset.createdAt,
          asset.contentRef,
          JSON.stringify(refs),
          asset.apiDoc ?? "",
          asset.methodsJson ?? "",
        );
    } catch (err) {
      throw translateConstraintError(err, `insert asset "${asset.filename}"`);
    }
    return { ...asset, fileCount: refs.length };
  }

  get(id: string): Asset | undefined {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
    if (!row) return undefined;
    const asset = toAsset(row as unknown as AssetRow);
    asset.fileCount = parseStoredFiles(asset, (row as unknown as AssetRow).content_refs_json).length;
    return asset;
  }

  getRequired(id: string): Asset {
    const asset = this.get(id);
    if (!asset) {
      throw new NotFoundError(`asset not found: ${id}`);
    }
    return asset;
  }

  /** Like getRequired but also returns the raw row (manifest + method list). */
  getFull(id: string): (Asset & { storedFiles: StoredFileRef[] } & Partial<ProtoSurface>) | undefined {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id);
    if (!row) return undefined;
    const typed = row as unknown as AssetRow;
    const asset = toAsset(typed);
    const storedFiles = parseStoredFiles(asset, typed.content_refs_json);
    return {
      ...asset,
      fileCount: storedFiles.length,
      storedFiles,
      methodsJson: typed.methods_json,
      apiDoc: typed.api_doc,
    };
  }

  listByProject(projectId: string, type?: AssetType): Asset[] {
    const rows = (
      type === AssetType.ASSET_TYPE_PRD || type === AssetType.ASSET_TYPE_PROTO
        ? this.db
          .prepare("SELECT * FROM assets WHERE project_id = ? AND type = ? ORDER BY created_at, id")
          .all(projectId, type === AssetType.ASSET_TYPE_PROTO ? "proto" : "prd")
        : this.db
          .prepare("SELECT * FROM assets WHERE project_id = ? ORDER BY created_at, id")
          .all(projectId)
    ) as unknown as AssetRow[];
    return rows.map((row) => {
      const asset = toAsset(row);
      asset.fileCount = parseStoredFiles(asset, row.content_refs_json).length;
      return asset;
    });
  }

  /** Delete a row; returns the manifest so callers can purge stored bytes. */
  remove(id: string): StoredFileRef[] {
    const existing = this.getFull(id);
    if (!existing) {
      throw new NotFoundError(`asset not found: ${id}`);
    }
    this.db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    return existing.storedFiles;
  }
}
