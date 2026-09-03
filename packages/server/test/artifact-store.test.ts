// Artifact store tests (T6).
//
// Acceptance: the local backend round-trip (upload/download with streaming,
// size + sha256 accounting, overwrite, not-found) MUST pass — it runs against
// a temp directory everywhere. The s3 backend round-trip against SeaweedFS is
// best-effort: it runs when the compose `s3` profile service answers on
// 127.0.0.1:8333 (docker compose --profile s3 up) and SKIPS otherwise, so
// `make test` stays green on machines without docker.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ArtifactKind } from "@hpath/contract";
import { HpathDb } from "../src/db/index.js";
import { ConflictError, ForeignKeyError, NotFoundError } from "../src/db/errors.js";
import {
  ArtifactIndex,
  LocalArtifactStore,
  artifactKey,
  createArtifactStore,
  isValidArtifactKey,
  parseArtifactKey,
  readAll,
  resolveBackend,
  storeArtifact,
  type ArtifactStore,
} from "../src/artifacts/index.js";
import { makeCase, makeEnv, makeProject, makeRun } from "./helpers.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "hpath-artifacts-"));
}

/** Run `fn` with selected env vars set (undefined deletes), then restore. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    saved.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Chunked random payload, to exercise real streaming (no single-shot body). */
function chunkedPayload(
  totalBytes: number,
  chunkBytes: number,
): { payload: Buffer; chunks: () => Readable } {
  const payload = randomBytes(totalBytes);
  return {
    payload,
    chunks: () =>
      Readable.from(
        (function* () {
          for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
            yield payload.subarray(offset, offset + chunkBytes);
          }
        })(),
      ),
  };
}

const S3_ENDPOINT = process.env.HPATH_TEST_S3_ENDPOINT ?? "http://127.0.0.1:8333";
const S3_SKIP_REASON = `SeaweedFS not reachable on ${S3_ENDPOINT} — s3 round-trip pending manual verification (docker compose --profile s3 up, see docker/README.md)`;

async function s3Reachable(): Promise<boolean> {
  try {
    // Any HTTP response (even 4xx/5xx) means something is listening; only
    // connection failures count as "not running".
    await fetch(`${S3_ENDPOINT}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

describe("artifact keys", () => {
  it("builds the shared artifacts/{project}/{env}/{run}/{name} scheme", () => {
    const key = artifactKey({ projectId: "p1", envId: "e1", runId: "r1", name: "01-login.png" });
    assert.equal(key, "artifacts/p1/e1/r1/01-login.png");
  });

  it("allows subdirectories in the name segment and parses back", () => {
    const key = artifactKey({ projectId: "p1", envId: "e1", runId: "r1", name: "steps/03-form.png" });
    assert.equal(key, "artifacts/p1/e1/r1/steps/03-form.png");
    assert.deepEqual(parseArtifactKey(key), {
      projectId: "p1",
      envId: "e1",
      runId: "r1",
      name: "steps/03-form.png",
    });
  });

  it("rejects traversal and malformed keys", () => {
    assert.throws(() => artifactKey({ projectId: "../evil", envId: "e", runId: "r", name: "x" }));
    assert.throws(() => artifactKey({ projectId: "p", envId: "", runId: "r", name: "x" }));
    assert.throws(() => artifactKey({ projectId: "p", envId: "e", runId: "r", name: "a\\b" }));
    assert.equal(isValidArtifactKey("artifacts/p/e/r/trace.zip"), true);
    assert.equal(isValidArtifactKey("artifacts/p/e/r/steps/s.png"), true);
    // Wrong prefix, too few segments, leading/trailing/double slashes, dots.
    assert.equal(isValidArtifactKey("not-artifacts/p/e/r/x"), false);
    assert.equal(isValidArtifactKey("artifacts/p/e/r"), false);
    assert.equal(isValidArtifactKey("/artifacts/p/e/r/x"), false);
    assert.equal(isValidArtifactKey("artifacts/p/e/r/x/"), false);
    assert.equal(isValidArtifactKey("artifacts/p//r/x"), false);
    assert.equal(isValidArtifactKey("artifacts/p/../r/x"), false);
  });
});

describe("local backend round-trip", () => {
  const root = tempRoot();
  const store = new LocalArtifactStore(root);
  const key = "artifacts/proj-x/dev/run-1/01-login.png";

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a Buffer upload with size + sha256 accounting", async () => {
    const payload = randomBytes(4096);
    const put = await store.putObject(key, payload);
    assert.equal(put.key, key);
    assert.equal(put.sizeBytes, payload.length);
    assert.equal(put.sha256, sha256(payload));

    const gotten = await store.getObject(key);
    const downloaded = await readAll(gotten.stream);
    assert.deepEqual(downloaded, payload);
    assert.equal(gotten.sizeBytes, payload.length);
    assert.equal(await store.exists(key), true);
  });

  it("streams a chunked upload without requiring the whole body up front", async () => {
    const { payload, chunks } = chunkedPayload(1024 * 1024, 64 * 1024);
    const put = await store.putObject("artifacts/p/e/r/session.webm", chunks());
    assert.equal(put.sizeBytes, payload.length);
    assert.equal(put.sha256, sha256(payload));

    const gotten = await store.getObject("artifacts/p/e/r/session.webm");
    assert.deepEqual(await readAll(gotten.stream), payload);
  });

  it("overwrites an existing object under the same key", async () => {
    const first = randomBytes(256);
    const second = randomBytes(512);
    await store.putObject("artifacts/p/e/r/report.json", first);
    const put = await store.putObject("artifacts/p/e/r/report.json", second);
    assert.equal(put.sha256, sha256(second));
    const gotten = await store.getObject("artifacts/p/e/r/report.json");
    assert.deepEqual(await readAll(gotten.stream), second);
  });

  it("accepts string bodies (utf8)", async () => {
    const bytes = Buffer.from("héllo store", "utf8");
    const put = await store.putObject("artifacts/p/e/r/notes.txt", "héllo store");
    assert.equal(put.sizeBytes, bytes.length);
    assert.equal(put.sha256, sha256(bytes));
  });

  it("materializes the key as nested directories under the root", () => {
    assert.ok(existsSync(join(root, "artifacts", "proj-x", "dev", "run-1", "01-login.png")));
  });

  it("reports missing objects as NotFoundError and exists()=false", async () => {
    assert.equal(await store.exists("artifacts/p/e/r/nope.png"), false);
    await assert.rejects(
      () => store.getObject("artifacts/p/e/r/nope.png"),
      (err: unknown) => err instanceof NotFoundError,
    );
  });

  it("refuses invalid or traversal keys", async () => {
    await assert.rejects(() => store.putObject("artifacts/../escape.png", "x"));
    await assert.rejects(() => store.getObject("not-a-scheme/x"));
    await assert.rejects(() => store.putObject("artifacts//double.png", "x"));
  });
});

describe("artifact index accounting", () => {
  it("records uploads in the artifacts table via storeArtifact", async () => {
    const db = HpathDb.inMemory();
    const root = tempRoot();
    try {
      const ids = seedRunChain(db);
      const store = new LocalArtifactStore(root);
      const index = new ArtifactIndex(db.artifacts);

      const bytes = Buffer.from("png-bytes");
      const artifact = await storeArtifact(store, index, {
        projectId: ids.projectId,
        envId: ids.envId,
        runId: ids.runId,
        name: "01-login.png",
        kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
        body: bytes,
      });

      const expectedKey = `artifacts/${ids.projectId}/${ids.envId}/${ids.runId}/01-login.png`;
      assert.equal(artifact.key, expectedKey);
      assert.equal(artifact.sizeBytes, bytes.length);
      assert.equal(artifact.sha256, sha256(bytes));
      assert.deepEqual(index.find(ids.runId, artifact.key), artifact);
      assert.equal(index.forRun(ids.runId).length, 1);
      assert.deepEqual(index.get(artifact.id), artifact);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upserts on re-upload keeping id and created_at stable", async () => {
    const db = HpathDb.inMemory();
    const root = tempRoot();
    try {
      const ids = seedRunChain(db);
      const store = new LocalArtifactStore(root);
      const index = new ArtifactIndex(db.artifacts);
      const base = {
        projectId: ids.projectId,
        envId: ids.envId,
        runId: ids.runId,
        name: "trace.zip",
        kind: ArtifactKind.ARTIFACT_KIND_TRACE,
      };

      const first = await storeArtifact(store, index, { ...base, body: Buffer.from("v1") });
      const second = await storeArtifact(store, index, {
        ...base,
        body: Buffer.from("v2-longer"),
      });

      assert.equal(second.id, first.id);
      assert.equal(second.createdAt, first.createdAt);
      assert.equal(second.sizeBytes, Buffer.byteLength("v2-longer"));
      assert.equal(second.sha256, sha256(Buffer.from("v2-longer")));
      const listed = index.forRun(ids.runId);
      assert.equal(listed.length, 1);
      assert.deepEqual(listed[0], second);
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps separate rows per key and rejects unknown runs", async () => {
    const db = HpathDb.inMemory();
    const root = tempRoot();
    try {
      const ids = seedRunChain(db);
      const store = new LocalArtifactStore(root);
      const index = new ArtifactIndex(db.artifacts);
      const base = {
        projectId: ids.projectId,
        envId: ids.envId,
        runId: ids.runId,
      };
      await storeArtifact(store, index, {
        ...base,
        name: "shot.png",
        kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
        body: "a",
      });
      await storeArtifact(store, index, {
        ...base,
        name: "steps/shot.png",
        kind: ArtifactKind.ARTIFACT_KIND_SCREENSHOT,
        body: "b",
      });
      assert.equal(index.forRun(ids.runId).length, 2);

      assert.throws(
        () =>
          index.upsert({
            runId: "missing-run",
            kind: ArtifactKind.ARTIFACT_KIND_VIDEO,
            key: "artifacts/p/e/r/v.webm",
            sizeBytes: 1,
            sha256: "x",
          }),
        ForeignKeyError,
      );
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces one row per (run_id, key) at the database level", async () => {
    const db = HpathDb.inMemory();
    const root = tempRoot();
    try {
      const ids = seedRunChain(db);
      const store = new LocalArtifactStore(root);
      const index = new ArtifactIndex(db.artifacts);
      const artifact = await storeArtifact(store, index, {
        projectId: ids.projectId,
        envId: ids.envId,
        runId: ids.runId,
        name: "trace.zip",
        kind: ArtifactKind.ARTIFACT_KIND_TRACE,
        body: "v1",
      });
      // A second row for the same (run_id, key) is impossible even when the
      // upsert is bypassed: the UNIQUE index rejects the raw insert.
      assert.throws(
        () =>
          db.artifacts.insert({
            id: randomUUID(),
            runId: ids.runId,
            kind: artifact.kind,
            key: artifact.key,
            sizeBytes: 1,
            sha256: "x",
            createdAt: new Date().toISOString(),
          }),
        ConflictError,
      );
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("backend factory", () => {
  it("defaults to the local store rooted at data/artifacts", async () => {
    await withEnv({ HPATH_ARTIFACT_STORE: undefined, HPATH_ARTIFACT_DIR: undefined }, async () => {
      const store = await createArtifactStore();
      assert.equal(store.backend, "local");
      assert.equal((store as LocalArtifactStore).root, resolve("data/artifacts"));
    });
  });

  it("honors HPATH_ARTIFACT_DIR for the local backend", async () => {
    await withEnv({ HPATH_ARTIFACT_STORE: "local", HPATH_ARTIFACT_DIR: "/tmp/hpath-custom" }, async () => {
      const store = await createArtifactStore();
      assert.equal(store.backend, "local");
      assert.equal((store as LocalArtifactStore).root, resolve("/tmp/hpath-custom"));
    });
  });

  it("selects the s3 backend for both s3 and seaweedfs values", async (t) => {
    if (!(await s3Reachable())) {
      // The factory verifies the bucket on creation (fail-fast on a missing
      // backend), which needs a live SeaweedFS; see docker/README.md. The
      // env-value mapping itself is covered by resolveBackend below.
      return t.skip(S3_SKIP_REASON);
    }
    const bucket = `hpath-test-${randomUUID().slice(0, 8)}`;
    await withEnv({ HPATH_ARTIFACT_STORE: "s3" }, () =>
      createArtifactStore({ s3: { endpoint: S3_ENDPOINT, bucket } }),
    ).then((store) => assert.equal(store.backend, "s3"));
    await withEnv({ HPATH_ARTIFACT_STORE: "seaweedfs" }, () =>
      createArtifactStore({ s3: { endpoint: S3_ENDPOINT, bucket: `${bucket}-2` } }),
    ).then((store) => assert.equal(store.backend, "s3"));
  });

  it("explicit options override the environment", async () => {
    await withEnv({ HPATH_ARTIFACT_STORE: "s3" }, async () => {
      const store = await createArtifactStore({ backend: "local", localDir: "/tmp/override" });
      assert.equal(store.backend, "local");
      assert.equal((store as LocalArtifactStore).root, resolve("/tmp/override"));
    });
  });

  it("rejects unknown backend values", () => {
    assert.throws(() => resolveBackend("gdrive"), /HPATH_ARTIFACT_STORE/);
    assert.equal(resolveBackend(undefined), undefined);
    assert.equal(resolveBackend(""), undefined);
    assert.equal(resolveBackend("local"), "local");
    assert.equal(resolveBackend("s3"), "s3");
    assert.equal(resolveBackend("seaweedfs"), "s3");
  });
});

describe("s3 backend round-trip against SeaweedFS", () => {
  let reachable = false;
  let store: ArtifactStore;

  before(async () => {
    reachable = await s3Reachable();
    if (!reachable) {
      return;
    }
    // The factory ensures the bucket exists, so no explicit ensureBucket call.
    store = await createArtifactStore({
      backend: "s3",
      s3: {
        endpoint: S3_ENDPOINT,
        bucket: `hpath-test-${randomUUID().slice(0, 8)}`,
      },
    });
  });

  it("round-trips an in-memory upload with accounting", async (t) => {
    if (!reachable) {
      return t.skip(S3_SKIP_REASON);
    }
    const payload = randomBytes(8192);
    const key = "artifacts/proj-s3/dev/run-s3/01-login.png";
    const put = await store.putObject(key, payload);
    assert.equal(put.key, key);
    assert.equal(put.sizeBytes, payload.length);
    assert.equal(put.sha256, sha256(payload));

    const gotten = await store.getObject(key);
    assert.equal(gotten.sizeBytes, payload.length);
    assert.deepEqual(await readAll(gotten.stream), payload);
    assert.equal(await store.exists(key), true);
  });

  it("round-trips a streamed upload", async (t) => {
    if (!reachable) {
      return t.skip(S3_SKIP_REASON);
    }
    const { payload, chunks } = chunkedPayload(1024 * 1024, 64 * 1024);
    const key = "artifacts/proj-s3/dev/run-s3/session.webm";
    const put = await store.putObject(key, chunks());
    assert.equal(put.sizeBytes, payload.length);
    assert.equal(put.sha256, sha256(payload));
    assert.deepEqual(await readAll((await store.getObject(key)).stream), payload);
  });

  it("multipart-uploads a body above the 5 MiB part size", async (t) => {
    if (!reachable) {
      return t.skip(S3_SKIP_REASON);
    }
    // Above the 5 MiB partSize, @aws-sdk/lib-storage switches to multipart
    // upload, which is a different SeaweedFS code path than single PUT.
    const { payload, chunks } = chunkedPayload(6 * 1024 * 1024, 512 * 1024);
    const key = "artifacts/proj-s3/dev/run-s3/session-big.webm";
    const put = await store.putObject(key, chunks());
    assert.equal(put.sizeBytes, payload.length);
    assert.equal(put.sha256, sha256(payload));
    assert.deepEqual(await readAll((await store.getObject(key)).stream), payload);
  });

  it("overwrites, and reports missing keys", async (t) => {
    if (!reachable) {
      return t.skip(S3_SKIP_REASON);
    }
    const key = "artifacts/proj-s3/dev/run-s3/report.json";
    await store.putObject(key, Buffer.from("v1"));
    const overwrite = Buffer.from("v2-longer-content");
    const put = await store.putObject(key, overwrite);
    assert.equal(put.sha256, sha256(overwrite));
    assert.deepEqual(await readAll((await store.getObject(key)).stream), overwrite);

    assert.equal(await store.exists("artifacts/proj-s3/dev/run-s3/nope.png"), false);
    await assert.rejects(
      () => store.getObject("artifacts/proj-s3/dev/run-s3/nope.png"),
      (err: unknown) => err instanceof NotFoundError,
    );
  });
});

/** Seed the project -> env -> case -> run FK chain; returns the key ids. */
function seedRunChain(db: HpathDb): { projectId: string; envId: string; runId: string } {
  const project = makeProject();
  const env = makeEnv(project);
  const kase = makeCase(project);
  const run = makeRun(project, env, kase);
  db.projects.create(project);
  db.envs.create(env);
  db.cases.create(kase);
  db.runs.create(run);
  return { projectId: project.id, envId: env.id, runId: run.id };
}
