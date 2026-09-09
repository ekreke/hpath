// Real-mode asset handlers (T22): the project asset library.
//
//   UploadAsset: validates the request, parses the proto bundle
//   deterministically (parseProtoBundle — no LLM), stores the raw bytes in
//   the artifact store (best-effort, like ParsePRD) and records the asset row
//   (markdown API doc + method manifest) in SQLite. PRD uploads ride ParsePRD
//   and are rejected here.
//   ListAssets / GetAsset: read path (GetAsset carries the parsed api_doc).
//   DeleteAsset: removes the row, then purges the stored bytes best-effort
//   (the database is the source of truth; leftover bytes are harmless
//   orphans), mirroring DeleteProject.

import { randomUUID } from "node:crypto";
import { status } from "@grpc/grpc-js";
import type {
  sendUnaryData,
  ServerUnaryCall,
} from "@grpc/grpc-js";
import {
  AssetType,
  Empty,
  type ApiMethod,
  type Asset,
  type DeleteAssetRequest,
  type GetAssetRequest,
  type ListAssetsRequest,
  type ListAssetsResponse,
  type UploadAssetRequest,
} from "@hpath/contract";
import type { StoredFileRef } from "../db/repositories/assets.js";
import { ProtoBundleError, parseProtoBundle, type ApiMethodDoc } from "../assets/proto-doc.js";
import { ingestPrd, prdFormatFromFilename } from "../agents/prd.js";
import { readAll } from "../artifacts/stream.js";
import type { RunExecutionDeps } from "./run-execution.js";
import { grpcError, toGrpcError } from "./errors.js";

/** proto-doc ApiMethodDoc -> contract ApiMethod (field-identical shapes). */
export function toContractMethods(docs: ApiMethodDoc[]): ApiMethod[] {
  return docs.map((doc) => ({
    service: doc.service,
    method: doc.method,
    request: doc.request,
    response: doc.response,
    comment: doc.comment,
    doc: doc.doc,
  }));
}

/** Storage key of one uploaded bundle file. Assets have no run of their own;
 * the env segment carries the stable "-" placeholder like PRDs do. */
function assetFileKey(projectId: string, assetId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file.proto";
  return `artifacts/${projectId}/-/asset/${assetId}/${safeName}`;
}

export function createUploadAssetHandler(deps: RunExecutionDeps) {
  return (
    call: ServerUnaryCall<UploadAssetRequest, Asset>,
    callback: sendUnaryData<Asset>,
  ): void => {
    void (async () => {
      try {
        const req = call.request;
        if (!req.projectId) {
          throw grpcError(status.INVALID_ARGUMENT, "project_id is required");
        }
        deps.db.projects.getRequired(req.projectId); // NOT_FOUND otherwise
        if (req.type === AssetType.ASSET_TYPE_UNSPECIFIED) {
          throw grpcError(status.INVALID_ARGUMENT, "asset type is required (prd | proto)");
        }
        if (req.type === AssetType.ASSET_TYPE_PRD) {
          throw grpcError(status.INVALID_ARGUMENT, "PRD uploads go through ParsePRD (analyze flow)");
        }
        const files = req.files ?? [];
        if (files.length === 0) {
          throw grpcError(status.INVALID_ARGUMENT, "at least one .proto file is required");
        }
        const bundle = (() => {
          try {
            return parseProtoBundle(
              files.map((file) => ({ filename: file.filename, content: Buffer.from(file.content) })),
              req.entryFilename || undefined,
            );
          } catch (err) {
            if (err instanceof ProtoBundleError) {
              throw grpcError(status.INVALID_ARGUMENT, err.message);
            }
            throw err;
          }
        })();

        const assetId = randomUUID();
        const storedFiles: StoredFileRef[] = [];
        const bodyByKey: { key: string; filename: string; body: Buffer }[] = [];
        for (const file of files) {
          const key = assetFileKey(req.projectId, assetId, file.filename);
          bodyByKey.push({ key, filename: file.filename, body: Buffer.from(file.content) });
          storedFiles.push({ filename: file.filename, key });
        }
        // Best-effort byte persistence: the parsed surface (SQLite) is the
        // valuable outcome; lost bytes only forfeit future re-materialization.
        const persisted: { filename: string; key: string }[] = [];
        for (const entry of bodyByKey) {
          try {
            await deps.artifactStore.putObject(entry.key, entry.body);
            persisted.push({ filename: entry.filename, key: entry.key });
          } catch (err) {
            console.error(`[hpath-server] asset file "${entry.filename}" upload failed:`, err);
          }
        }
        const entryKey = storedFiles.find((ref) => ref.filename === bundle.entryFilename)?.key ?? "";
        const totalBytes = files.reduce((sum, file) => sum + file.content.byteLength, 0);

        const asset = deps.db.assets.insert({
          id: assetId,
          projectId: req.projectId,
          type: AssetType.ASSET_TYPE_PROTO,
          filename: bundle.entryFilename,
          sizeBytes: totalBytes,
          createdAt: new Date().toISOString(),
          textContent: "",
          contentRef: entryKey,
          apiDoc: bundle.apiDoc,
          methodsJson: JSON.stringify(bundle.methods),
          methods: toContractMethods(bundle.methods),
          fileCount: 0,
          storedFiles: persisted,
        });
        callback(null, { ...asset, apiDoc: bundle.apiDoc, fileCount: files.length });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  };
}

export function createListAssetsHandler(deps: RunExecutionDeps) {
  return (
    call: ServerUnaryCall<ListAssetsRequest, ListAssetsResponse>,
    callback: sendUnaryData<ListAssetsResponse>,
  ): void => {
    try {
      deps.db.projects.getRequired(call.request.projectId);
      // text_content stays out of list payloads (GetAsset carries it).
      callback(null, {
        assets: deps.db.assets
          .listByProject(call.request.projectId, call.request.type)
          .map((asset) => ({ ...asset, textContent: "" })),
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };
}

export function createGetAssetHandler(deps: RunExecutionDeps) {
  return (call: ServerUnaryCall<GetAssetRequest, Asset>, callback: sendUnaryData<Asset>): void => {
    void (async () => {
      try {
        const asset = deps.db.assets.get(call.request.assetId);
        if (!asset) {
          throw grpcError(status.NOT_FOUND, `asset not found: ${call.request.assetId}`);
        }
        // Lazy PRD text backfill (0008): legacy rows (or uploads that predate
        // the detail preview) carry empty text_content. When the raw bytes are
        // retrievable from the artifact store, ingest once and persist — the
        // preview then works for the asset's lifetime. Unreadable bytes (e.g.
        // the seed's repo-relative pseudo keys) leave it empty; the client
        // shows "no preview" and a re-upload restores it.
        if (asset.type === AssetType.ASSET_TYPE_PRD && !asset.textContent && asset.contentRef) {
          try {
            const object = await deps.artifactStore.getObject(asset.contentRef);
            const body = await readAll(object.stream);
            const format = prdFormatFromFilename(asset.filename);
            if (format) {
              const ingested = await ingestPrd(body, format);
              deps.db.assets.updateTextContent(asset.id, ingested.text);
              asset.textContent = ingested.text;
            }
          } catch (err) {
            // Best-effort: an unreadable asset stays preview-less.
            console.warn(`[hpath-server] asset "${asset.filename}" text backfill failed: ${(err as Error).message}`);
          }
        }
        callback(null, asset);
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  };
}

export function createDeleteAssetHandler(deps: RunExecutionDeps) {
  return (
    call: ServerUnaryCall<DeleteAssetRequest, { [key: string]: never }>,
    callback: sendUnaryData<Record<string, never>>,
  ): void => {
    void (async () => {
      try {
        const manifest = deps.db.assets.remove(call.request.assetId);
        // Best-effort byte purge after the committed row delete.
        await Promise.all(manifest.map((ref) => deps.artifactStore.remove(ref.key).catch(() => {})));
        callback(null, Empty.create() as unknown as Record<string, never>);
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  };
}
