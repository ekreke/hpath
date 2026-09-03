// ArtifactStore interface + backend factory (T6).
//
// Binary run evidence (video / screenshots / traces / request logs) goes
// through one interface; the backend is selected by HPATH_ARTIFACT_STORE:
//   local      (default) filesystem directory rooted at HPATH_ARTIFACT_DIR
//   s3         S3 API against SeaweedFS ("seaweedfs" is accepted as an alias,
//              matching the SPEC's backend naming)
// Both backends share the key scheme artifacts/{project}/{env}/{run}/...
// (see keys.ts). This module is consumed by T8's run pipeline; mock mode is
// untouched.

import type { Readable } from "node:stream";
import { DEFAULT_ARTIFACT_DIR, LocalArtifactStore } from "./local.js";
import {
  DEFAULT_S3_BUCKET,
  DEFAULT_S3_ENDPOINT,
  DEFAULT_S3_REGION,
  S3ArtifactStore,
  type S3StoreOptions,
} from "./s3.js";

export { ARTIFACT_KEY_PREFIX, artifactKey, isValidArtifactKey, parseArtifactKey } from "./keys.js";
export type { ArtifactKeyParts } from "./keys.js";
export { HashCounter, bodyToReadable, hashBody, readAll } from "./stream.js";
export { LocalArtifactStore, DEFAULT_ARTIFACT_DIR } from "./local.js";
export { S3ArtifactStore, DEFAULT_S3_BUCKET, DEFAULT_S3_ENDPOINT, DEFAULT_S3_REGION } from "./s3.js";

/** Which storage backend a store talks to. */
export type ArtifactBackend = "local" | "s3";

/** Payload accepted by putObject: a stream (preferred) or in-memory bytes. */
export type ArtifactBody = Readable | Uint8Array | string;

export interface ArtifactPutResult {
  /** Store key the bytes were written under. */
  key: string;
  /** Exact byte count, computed while streaming. */
  sizeBytes: number;
  /** Hex sha256 of the payload, computed while streaming. */
  sha256: string;
}

export interface ArtifactGetObject {
  /** Byte stream of the stored object. */
  stream: Readable;
  /** Total size when the backend knows it up front (local stat / S3 header). */
  sizeBytes?: number;
}

export interface ArtifactStore {
  readonly backend: ArtifactBackend;
  /**
   * Store `body` under `key`, overwriting any previous object. Returns the
   * size and sha256 computed while streaming the bytes in.
   */
  putObject(key: string, body: ArtifactBody): Promise<ArtifactPutResult>;
  /** Read an object back as a stream. NotFoundError when the key is absent. */
  getObject(key: string): Promise<ArtifactGetObject>;
  /** Cheap existence check (no body transfer). */
  exists(key: string): Promise<boolean>;
}

export interface CreateStoreOptions {
  /** Overrides HPATH_ARTIFACT_STORE ("local" | "s3" | "seaweedfs"). */
  backend?: ArtifactBackend;
  /** Overrides HPATH_ARTIFACT_DIR (local backend). */
  localDir?: string;
  /** Overrides the HPATH_S3_* / SEAWEED_S3_ENDPOINT settings (s3 backend). */
  s3?: Partial<S3StoreOptions>;
}

/**
 * Resolve the HPATH_ARTIFACT_STORE value to a backend. Undefined/blank means
 * "no preference" (the caller applies the local default); anything outside
 * local|s3|seaweedfs throws a configuration error.
 */
export function resolveBackend(value: string | undefined): ArtifactBackend | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "local") {
    return "local";
  }
  if (normalized === "s3" || normalized === "seaweedfs") {
    return "s3";
  }
  throw new Error(
    `HPATH_ARTIFACT_STORE must be "local", "s3" or "seaweedfs", got ${JSON.stringify(value)}`,
  );
}

/**
 * Build an artifact store from explicit options, filling every gap from the
 * environment (HPATH_ARTIFACT_STORE / HPATH_ARTIFACT_DIR / HPATH_S3_* /
 * SEAWEED_S3_ENDPOINT). Defaults to the local filesystem backend.
 */
export async function createArtifactStore(options: CreateStoreOptions = {}): Promise<ArtifactStore> {
  const backend = options.backend ?? resolveBackend(process.env.HPATH_ARTIFACT_STORE) ?? "local";
  if (backend === "local") {
    const dir = options.localDir ?? process.env.HPATH_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIR;
    return new LocalArtifactStore(dir);
  }
  const endpoint =
    options.s3?.endpoint ??
    process.env.HPATH_S3_ENDPOINT ??
    process.env.SEAWEED_S3_ENDPOINT ??
    DEFAULT_S3_ENDPOINT;
  const store = await S3ArtifactStore.create({
    endpoint,
    bucket: options.s3?.bucket ?? process.env.HPATH_S3_BUCKET ?? DEFAULT_S3_BUCKET,
    region: options.s3?.region ?? process.env.HPATH_S3_REGION ?? DEFAULT_S3_REGION,
    // SeaweedFS runs without auth by default; it accepts any credentials.
    // Real deployments set HPATH_S3_ACCESS_KEY_ID / HPATH_S3_SECRET_ACCESS_KEY.
    accessKeyId: options.s3?.accessKeyId ?? process.env.HPATH_S3_ACCESS_KEY_ID ?? "hpath",
    secretAccessKey:
      options.s3?.secretAccessKey ?? process.env.HPATH_S3_SECRET_ACCESS_KEY ?? "hpath",
  });
  // Fail fast on a missing/misconfigured backend: creating the bucket up front
  // surfaces setup problems at startup instead of deep inside the run pipeline.
  await store.ensureBucket();
  return store;
}
