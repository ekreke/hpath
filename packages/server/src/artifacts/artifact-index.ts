// Artifact index accounting (T6): the upsert/find layer over the T5 artifacts
// table, paired with the ArtifactStore backends. The store holds the bytes;
// this index records who/what/where/how-big so DownloadArtifact (T8) can map
// an artifact id -> store key. `storeArtifact` is the one-call entry point
// the run pipeline uses: put bytes, then upsert the metadata row.

import { randomUUID } from "node:crypto";
import type { Artifact, ArtifactKind } from "@hpath/contract";
import type { ArtifactRepository } from "../db/repositories/artifacts.js";
import { artifactKey } from "./keys.js";
import type { ArtifactBody, ArtifactStore } from "./store.js";

export interface ArtifactIndexEntry {
  runId: string;
  kind: ArtifactKind;
  /** Store key, normally built with artifactKey(). */
  key: string;
  sizeBytes: number;
  sha256: string;
}

export class ArtifactIndex {
  constructor(private readonly artifacts: ArtifactRepository) {}

  /**
   * Insert or refresh the metadata row for (runId, key). Re-uploads keep the
   * artifact id and created_at stable. Rejected with ForeignKeyError for
   * unknown runs.
   */
  upsert(entry: ArtifactIndexEntry): Artifact {
    return this.artifacts.upsert({
      id: randomUUID(),
      runId: entry.runId,
      kind: entry.kind,
      key: entry.key,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      createdAt: new Date().toISOString(),
    });
  }

  /** Metadata for one artifact id. */
  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  /** Metadata for `runId`'s object stored under `key`, if uploaded. */
  find(runId: string, key: string): Artifact | undefined {
    return this.artifacts.getByKey(runId, key);
  }

  /** All recorded artifacts of a run, oldest first. */
  forRun(runId: string): Artifact[] {
    return this.artifacts.listForRun(runId);
  }
}

export interface StoreArtifactInput {
  /** Key namespace: artifacts/{project}/{env}/{run}/{name}. */
  projectId: string;
  envId: string;
  runId: string;
  /** Object name under the run directory; may contain subdirectories. */
  name: string;
  kind: ArtifactKind;
  body: ArtifactBody;
}

/**
 * One-call upload for the T8 run pipeline: streams `body` into the store
 * under the shared key scheme, then upserts the artifacts-table row with the
 * size/sha256 computed during the upload. Returns the stored record.
 */
export async function storeArtifact(
  store: ArtifactStore,
  index: ArtifactIndex,
  input: StoreArtifactInput,
): Promise<Artifact> {
  const key = artifactKey({
    projectId: input.projectId,
    envId: input.envId,
    runId: input.runId,
    name: input.name,
  });
  const put = await store.putObject(key, input.body);
  return index.upsert({
    runId: input.runId,
    kind: input.kind,
    key,
    sizeBytes: put.sizeBytes,
    sha256: put.sha256,
  });
}
