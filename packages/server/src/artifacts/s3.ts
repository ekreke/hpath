// S3 ArtifactStore backend (T6): talks the S3 API to SeaweedFS, the
// compose `s3` profile service (docker compose --profile s3 up). The endpoint
// is configurable so the same code targets a local SeaweedFS container during
// development (HPATH_S3_ENDPOINT / SEAWEED_S3_ENDPOINT, default
// http://127.0.0.1:8333) or a production deployment.
//
// The AWS SDK is loaded with a dynamic import so the default local backend
// never pays the SDK's module graph at startup.

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { NotFoundError } from "../db/errors.js";
import type { ArtifactBody, ArtifactGetObject, ArtifactPutResult, ArtifactStore } from "./store.js";
import { HashCounter, bodyToReadable } from "./stream.js";
import { isValidArtifactKey } from "./keys.js";

export const DEFAULT_S3_ENDPOINT = "http://127.0.0.1:8333";
export const DEFAULT_S3_BUCKET = "hpath-artifacts";
export const DEFAULT_S3_REGION = "us-east-1";

export interface S3StoreOptions {
  /** S3 API base URL, e.g. http://seaweedfs:8333 for the compose service. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** True for the error shapes S3-compatible stores use for missing objects. */
function isNotFoundShape(err: unknown): boolean {
  const shaped = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = shaped?.$metadata?.httpStatusCode;
  return shaped?.name === "NotFound" || shaped?.name === "NoSuchKey" || status === 404;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly backend = "s3" as const;

  private constructor(
    private readonly client: import("@aws-sdk/client-s3").S3Client,
    private readonly commands: typeof import("@aws-sdk/client-s3"),
    private readonly storage: typeof import("@aws-sdk/lib-storage"),
    private readonly options: S3StoreOptions,
  ) {}

  /**
   * Construct the store, loading the AWS SDK modules lazily. Throws a clear
   * error when the packages are unavailable.
   */
  static async create(options: S3StoreOptions): Promise<S3ArtifactStore> {
    let commands: typeof import("@aws-sdk/client-s3");
    let storage: typeof import("@aws-sdk/lib-storage");
    try {
      commands = await import("@aws-sdk/client-s3");
      storage = await import("@aws-sdk/lib-storage");
    } catch (err) {
      throw new Error(
        "The s3 artifact backend requires @aws-sdk/client-s3 + @aws-sdk/lib-storage "
          + "(installed with @hpath/server)",
        { cause: err },
      );
    }
    const client = new commands.S3Client({
      endpoint: options.endpoint,
      region: options.region,
      // SeaweedFS serves bucket-scoped paths (no virtual-host DNS).
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // Only compute/validate the SDK CRC32 checksums when the target
      // requires it: S3-compatible stores vary in their support for the
      // streaming checksum trailers the default adds.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    return new S3ArtifactStore(client, commands, storage, options);
  }

  async putObject(key: string, body: ArtifactBody): Promise<ArtifactPutResult> {
    if (!isValidArtifactKey(key)) {
      throw new Error(`invalid artifact key: ${JSON.stringify(key)}`);
    }
    if (typeof body === "string" || body instanceof Uint8Array) {
      // In-memory fast path: single PUT with a known content length.
      const bytes =
        typeof body === "string" ? Buffer.from(body, "utf8") : (Buffer.isBuffer(body) ? body : Buffer.from(body));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await this.client.send(
        new this.commands.PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: bytes,
        }),
      );
      return { key, sizeBytes: bytes.byteLength, sha256 };
    }
    // Streaming path. The S3 API requires a known length or aws-chunked
    // framing, which raw unknown-length Readables cannot provide (the SDK
    // would send an empty or mis-framed body); @aws-sdk/lib-storage's Upload
    // handles it properly (single PUT below partSize, multipart above), so
    // bytes flow from the source to SeaweedFS without full buffering.
    const counter = new HashCounter();
    const upload = new this.storage.Upload({
      client: this.client,
      params: {
        Bucket: this.options.bucket,
        Key: key,
        Body: bodyToReadable(body).pipe(counter),
      },
    });
    await upload.done();
    return { key, sizeBytes: counter.size, sha256: counter.digest() };
  }

  async getObject(key: string): Promise<ArtifactGetObject> {
    if (!isValidArtifactKey(key)) {
      throw new Error(`invalid artifact key: ${JSON.stringify(key)}`);
    }
    try {
      const response = await this.client.send(
        new this.commands.GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!response.Body) {
        throw new NotFoundError(`artifact not found in s3 store: ${key}`);
      }
      // The SDK wraps the response body in a Readable-backed stream mixin.
      const stream = response.Body as unknown as Readable;
      return { stream, sizeBytes: response.ContentLength };
    } catch (err) {
      if (isNotFoundShape(err)) {
        throw new NotFoundError(`artifact not found in s3 store: ${key}`);
      }
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    if (!isValidArtifactKey(key)) {
      throw new Error(`invalid artifact key: ${JSON.stringify(key)}`);
    }
    try {
      await this.client.send(
        new this.commands.HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFoundShape(err)) {
        return false;
      }
      throw err;
    }
  }

  /** Create the bucket if it does not exist yet (idempotent setup helper). */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(
        new this.commands.CreateBucketCommand({ Bucket: this.options.bucket }),
      );
    } catch (err) {
      const shaped = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const conflict =
        shaped?.name === "BucketAlreadyOwnedByYou" ||
        shaped?.name === "BucketAlreadyExists" ||
        shaped?.$metadata?.httpStatusCode === 409;
      if (!conflict) {
        throw err;
      }
    }
  }
}
