// Stream plumbing shared by the artifact store backends (T6): a pass-through
// transform that hashes and counts bytes in one pass (single read of the
// source, no buffering), plus small conversion/collection helpers.

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactBody } from "./store.js";

/**
 * Transform that forwards every chunk unchanged while updating a sha256 hash
 * and a byte counter. Use `digest()`/`size` after the pipeline completed.
 */
export class HashCounter extends Transform {
  private readonly hash = createHash("sha256");

  /** Bytes seen so far; final once the pipeline finished. */
  size = 0;

  /** Hex sha256 of the bytes seen so far (safe to call any time). */
  digest(): string {
    return this.hash.copy().digest("hex");
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error: Error | null, data?: Buffer | string) => void,
  ): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.hash.update(bytes);
    this.size += bytes.byteLength;
    callback(null, chunk);
  }
}

/** Normalize a put body to a Readable so every backend streams uniformly. */
export function bodyToReadable(body: ArtifactBody): Readable {
  if (typeof body === "string") {
    return Readable.from([Buffer.from(body, "utf8")]);
  }
  if (body instanceof Uint8Array) {
    // Buffer is a Uint8Array; wrap non-Buffer views so .pipe() is available.
    return Readable.from([Buffer.from(body)]);
  }
  return body;
}

/** Hash + size a put body without storing it. */
export async function hashBody(body: ArtifactBody): Promise<{ sizeBytes: number; sha256: string }> {
  const counter = new HashCounter();
  await pipeline(bodyToReadable(body), counter);
  return { sizeBytes: counter.size, sha256: counter.digest() };
}

/** Drain a stream into one buffer (used by download paths and tests). */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
