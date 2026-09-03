// Local filesystem ArtifactStore backend (T6). Objects live as plain files
// under a root directory (HPATH_ARTIFACT_DIR, default data/artifacts), one
// path per store key. Uploads stream to a temp file in the destination
// directory and are renamed into place, so a crash mid-upload never leaves a
// truncated object visible under its final key.

import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, access } from "node:fs/promises";
import { dirname, join, resolve, sep, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { NotFoundError } from "../db/errors.js";
import type { ArtifactBody, ArtifactGetObject, ArtifactPutResult, ArtifactStore } from "./store.js";
import { HashCounter, bodyToReadable } from "./stream.js";
import { isValidArtifactKey } from "./keys.js";

/** Default root, relative to the working directory (SPEC artifact note). */
export const DEFAULT_ARTIFACT_DIR = "data/artifacts";

export class LocalArtifactStore implements ArtifactStore {
  readonly backend = "local" as const;

  /** Absolute root directory every key resolves under. */
  readonly root: string;

  constructor(rootDir: string) {
    if (rootDir.trim() === "") {
      throw new Error("LocalArtifactStore requires a non-empty root directory");
    }
    this.root = resolve(rootDir);
  }

  async putObject(key: string, body: ArtifactBody): Promise<ArtifactPutResult> {
    const destination = this.pathFor(key);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    const counter = new HashCounter();
    try {
      await pipeline(bodyToReadable(body), counter, createWriteStream(temporary));
      await rename(temporary, destination);
    } catch (err) {
      // Never leave temp litter behind on a failed upload.
      await rm(temporary, { force: true }).catch(() => {});
      throw err;
    }
    return { key, sizeBytes: counter.size, sha256: counter.digest() };
  }

  async getObject(key: string): Promise<ArtifactGetObject> {
    const path = this.pathFor(key);
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new NotFoundError(`artifact not found in local store: ${key}`);
    }
    if (!info.isFile()) {
      throw new NotFoundError(`artifact not found in local store: ${key}`);
    }
    return { stream: createReadStream(path), sizeBytes: info.size };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Absolute path for a key. Keys are validated (scheme + traversal safety)
   * and the resolved path must stay inside the root directory.
   */
  private pathFor(key: string): string {
    if (!isValidArtifactKey(key)) {
      throw new Error(`invalid artifact key: ${JSON.stringify(key)}`);
    }
    const path = resolve(this.root, key);
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`artifact key escapes the store root: ${JSON.stringify(key)}`);
    }
    return path;
  }
}
