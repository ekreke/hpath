// T22 tests: the project asset library and the agent-side API surface.
//
//   - parseProtoBundle (pure parser): single/multi-file bundles, import
//     resolution, entry inference, duplicate/missing errors, docs content.
//   - grpc_call hard validation: an undefined method is rejected BEFORE any
//     network I/O (unreachable target proves no call happened); a defined
//     method still executes.
//   - api-docs provider: no tools without a surface; list/describe with one.
//   - Migration 0007: legacy prds rows become prd-type assets.
//   - Real UploadAsset/ListAssets/GetAsset/DeleteAsset handlers.
//   - Mock handler parity for the same four RPCs + ParsePRD asset rows.

import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { AssetType, type Asset } from "@hpath/contract";
import { HpathDb, MIGRATIONS } from "../src/db/index.js";
import {
  ProtoBundleError,
  materializeProtoFiles,
  methodKey,
  parseProtoBundle,
  summarizeMethods,
} from "../src/assets/proto-doc.js";
import { createGrpcCallTool } from "../src/agents/providers/grpc.js";
import { createApiDocsToolProvider } from "../src/agents/providers/api-docs.js";
import type { ToolContext } from "../src/agents/tools.js";
import {
  InMemoryEventSink,
  RunEvidence,
  VerdictChannel,
  type AgentEventSink,
} from "../src/agents/index.js";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import type { RunExecutionDeps } from "../src/grpc/run-execution.js";
import {
  createDeleteAssetHandler,
  createGetAssetHandler,
  createListAssetsHandler,
  createUploadAssetHandler,
} from "../src/grpc/assets.js";
import { createMockHandlers } from "../src/mock/handlers.js";
import { createMockStore } from "../src/mock/store.js";
import { seedMockStore } from "../src/mock/seed.js";
import { DEMO_APP_PROTO } from "./helpers/demo-app.js";

/** Invoke a unary handler with a bare request, promise-style. */
function callUnary<Res>(handler: unknown, request: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    (handler as (call: never, cb: never) => void)(
      { request } as never,
      ((err: unknown, response?: Res) => (err ? reject(err) : resolve(response as Res))) as never,
    );
  });
}

const BALANCE_PROTO = `
syntax = "proto3";
package demo.v1;
import "common.proto";
// Balance service.
service BalanceService {
  // Get the balance.
  rpc GetBalance(GetBalanceRequest) returns (GetBalanceResponse);
}
message GetBalanceRequest {
  // The account.
  string account_id = 1;
}
`;

const COMMON_PROTO = `
syntax = "proto3";
package demo.v1;
// A response.
message GetBalanceResponse {
  // Decimal string balance.
  string balance = 1;
}
`;

/** Self-contained variant for the provider/validation tests (no imports:
 * the surface + materialization must not depend on a second file). */
const BALANCE_STANDALONE = `syntax = "proto3";
package demo.v1;
// Balance service.
service BalanceService {
  // Get the balance.
  rpc GetBalance(GetBalanceRequest) returns (GetBalanceResponse);
}
message GetBalanceRequest {
  // The account.
  string account_id = 1;
}
message GetBalanceResponse {
  // Field numbers mirror the demo-app proto so the in-process server's
  // replies decode identically.
  string env = 1;
  string currency = 2;
  string balance = 3;
  int64 balance_cents = 4;
}
`;

// ── parseProtoBundle ─────────────────────────────────────────────────────────

describe("parseProtoBundle", () => {
  it("parses a single file into methods, docs and a summary", () => {
    const bundle = parseProtoBundle([{ filename: "balance.proto", content: BALANCE_STANDALONE }]);
    assert.equal(bundle.entryFilename, "balance.proto");
    assert.equal(bundle.fileCount, 1);
    assert.equal(bundle.methods.length, 1);
    const method = bundle.methods[0]!;
    assert.equal(methodKey(method), "demo.v1.BalanceService/GetBalance");
    assert.equal(method.request, "demo.v1.GetBalanceRequest");
    assert.equal(method.response, "demo.v1.GetBalanceResponse");
    assert.equal(method.comment, "Get the balance.");
    assert.ok(method.doc.includes("account_id"), "request schema in doc");
    assert.ok(method.doc.includes("The account."), "field comment in doc");
    assert.ok(bundle.apiDoc.includes("demo.v1.BalanceService/GetBalance"));
    assert.ok(bundle.apiDoc.includes("balance.proto"));
    assert.ok(bundle.summary.includes("demo.v1.BalanceService/GetBalance("));
  });

  it("resolves multi-file imports and infers the entry file", () => {
    const bundle = parseProtoBundle([
      { filename: "balance.proto", content: BALANCE_PROTO },
      { filename: "common.proto", content: COMMON_PROTO },
    ]);
    assert.equal(bundle.entryFilename, "balance.proto");
    assert.equal(bundle.fileCount, 2);
    const method = bundle.methods[0]!;
    assert.ok(method.doc.includes("demo.v1.GetBalanceResponse"), "response schema (from the imported file) in doc");
    assert.ok(method.doc.includes("Decimal string balance."), "imported file comments in doc");
  });

  it("resolves imports by base name when the import path differs from the upload name", () => {
    const bundle = parseProtoBundle([
      { filename: "balance.proto", content: BALANCE_PROTO },
      // The upload is flat while the import says "sub/common.proto".
      { filename: "common.proto", content: COMMON_PROTO },
    ].map((file) => file.filename === "balance.proto"
      ? { ...file, content: file.content.replace('import "common.proto";', 'import "sub/common.proto";') }
      : file));
    assert.equal(bundle.entryFilename, "balance.proto");
    assert.equal(bundle.methods[0]!.response, "demo.v1.GetBalanceResponse");
  });

  it("rejects a bundle with an import that is not uploaded", () => {
    assert.throws(
      () => parseProtoBundle([{ filename: "balance.proto", content: BALANCE_PROTO }]),
      (err: unknown) => err instanceof ProtoBundleError
        && /imports "common\.proto" which is not part of the upload/.test(err.message),
    );
  });

  it("rejects an ambiguous bundle unless entry_filename names the entry", () => {
    const files = [
      { filename: "a.proto", content: 'syntax = "proto3"; package p; message A { string x = 1; }' },
      { filename: "b.proto", content: 'syntax = "proto3"; package p; message B { string y = 1; }' },
    ];
    assert.throws(
      () => parseProtoBundle(files),
      (err: unknown) => err instanceof ProtoBundleError && /ambiguous bundle/.test(err.message),
    );
    const bundle = parseProtoBundle(files, "b.proto");
    assert.equal(bundle.entryFilename, "b.proto");
    assert.equal(bundle.methods.length, 0, "no services, only messages");
  });

  it("rejects duplicate type definitions across files and unknown entry files", () => {
    assert.throws(
      () =>
        parseProtoBundle([
          { filename: "a.proto", content: 'syntax = "proto3"; package p; message A { string x = 1; }' },
          { filename: "b.proto", content: 'syntax = "proto3"; package p; message A { string y = 1; }' },
        ], "a.proto"),
      (err: unknown) => err instanceof ProtoBundleError && /duplicate/.test(err.message),
    );
    assert.throws(
      () => parseProtoBundle([{ filename: "a.proto", content: 'syntax = "proto3"; package p; message A { string x = 1; }' }], "nope.proto"),
      (err: unknown) => err instanceof ProtoBundleError && /not one of the uploaded files/.test(err.message),
    );
  });

  it("enforces the file-count cap and rejects directories in filenames", () => {
    const trivial = 'syntax = "proto3"; package p; message M { string x = 1; }';
    assert.throws(
      () => parseProtoBundle(Array.from({ length: 21 }, (_, i) => ({ filename: `f${i}.proto`, content: trivial }))),
      (err: unknown) => err instanceof ProtoBundleError && /at most 20 files/.test(err.message),
    );
    assert.throws(
      () => parseProtoBundle([{ filename: "sub/x.proto", content: trivial }]),
      (err: unknown) => err instanceof ProtoBundleError && /base names only/.test(err.message),
    );
  });

  it("materializes files into a temp dir that really exists on disk", () => {
    const { dir, paths } = materializeProtoFiles([
      { filename: "balance.proto", content: Buffer.from(BALANCE_PROTO) },
    ]);
    try {
      assert.equal(paths.length, 1);
      assert.ok(existsSync(paths[0]!));
      assert.equal(readdirSync(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarizeMethods truncates beyond the prompt cap", () => {
    const methods = Array.from({ length: 400 }, (_, i) => ({
      service: `pkg.S${i}`,
      method: "M",
      request: "pkg.R",
      response: "pkg.P",
      comment: "x".repeat(40),
      doc: "",
    }));
    const summary = summarizeMethods(methods);
    assert.ok(summary.length <= 4_100, "summary capped near 4000 chars");
    assert.ok(summary.includes("truncated"));
  });
});

// ── grpc_call hard validation + api-docs provider ────────────────────────────

interface GrpcTestServer {
  target: string;
  shutdown(): Promise<void>;
}

async function startGrpcServer(): Promise<GrpcTestServer> {
  const packageDefinition = protoLoader.loadSync(DEMO_APP_PROTO, {
    keepCase: false, longs: Number, enums: String, defaults: true, oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition);
  const server = new grpc.Server();
  server.addService((proto as unknown as { demo: { v1: { BalanceService: { service: never } } } }).demo.v1.BalanceService.service, {
    GetBalance: (_call: unknown, callback: (err: null, value: unknown) => void) => {
      callback(null, { env: "dev", currency: "CNY", balance: "1337.50", balanceCents: 133_750 });
    },
  });
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
  return {
    target: `127.0.0.1:${boundPort}`,
    shutdown: () => new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const runId = crypto.randomUUID();
  return {
    runId,
    agentId: "t22-test",
    env: { projectId: "proj-1", envId: "env-dev", name: "dev", baseUrl: "http://dev.example.test", variables: {} },
    input: {},
    events: new InMemoryEventSink({ runId }) as AgentEventSink,
    verdict: new VerdictChannel({ type: "object" }),
    evidence: new RunEvidence(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function surfaceForBalanceProto(): Promise<NonNullable<ToolContext["projectApi"]>> {
  const bundle = parseProtoBundle([{ filename: "balance.proto", content: BALANCE_STANDALONE }]);
  const materialized = materializeProtoFiles([{ filename: "balance.proto", content: BALANCE_STANDALONE }]);
  return {
    summary: bundle.summary,
    apiDoc: bundle.apiDoc,
    methods: bundle.methods,
    protoPaths: materialized.paths,
    protoDir: materialized.dir,
  };
}

describe("grpc_call hard validation (T22)", () => {
  it("rejects an undefined method before any network I/O", async () => {
    // The target is unreachable ON PURPOSE: a resolved {ok:false} result would
    // mean the call traveled; a thrown rejection proves validation fired first.
    const projectApi = await surfaceForBalanceProto();
    try {
      const context = makeContext({
        env: { projectId: "p", envId: "e", name: "dev", baseUrl: "http://x", variables: { grpc_target: "127.0.0.1:1" } },
        projectApi,
      });
      const tool = createGrpcCallTool(context, {});
      await assert.rejects(
        () => tool.execute("call_1", { method: "demo.v1.BalanceService/CloseAccount" }),
        (err: Error) => /is not defined in this project's registered API surface/.test(err.message)
          && err.message.includes("demo.v1.BalanceService/GetBalance"),
      );
    } finally {
      if (projectApi.protoDir) rmSync(projectApi.protoDir, { recursive: true, force: true });
    }
  });

  it("still executes a method that IS on the project surface", async () => {
    const projectApi = await surfaceForBalanceProto();
    const grpcServer = await startGrpcServer();
    try {
      const context = makeContext({
        env: { projectId: "p", envId: "e", name: "dev", baseUrl: "http://x", variables: { grpc_target: grpcServer.target } },
        projectApi,
      });
      const tool = createGrpcCallTool(context, {});
      const result = await tool.execute("call_1", { method: "demo.v1.BalanceService/GetBalance" });
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.ok, true);
      assert.equal(payload.response.balance, "1337.50");
    } finally {
      await grpcServer.shutdown();
      if (projectApi.protoDir) rmSync(projectApi.protoDir, { recursive: true, force: true });
    }
  });

  it("without a project surface, behavior is unchanged (no validation)", async () => {
    const context = makeContext({
      env: { projectId: "p", envId: "e", name: "dev", baseUrl: "http://x", variables: { grpc_target: "127.0.0.1:1" } },
    });
    const tool = createGrpcCallTool(context, { protoPaths: [DEMO_APP_PROTO], timeoutMs: 1500 });
    // Unknown service still fails the descriptor lookup, not the allowlist.
    await assert.rejects(() => tool.execute("call_1", { method: "nope.v1.Missing/Do" }), /not found in the registered protos/);
  });
});

describe("api-docs provider (T22)", () => {
  it("materializes no tools without a project surface", () => {
    const provider = createApiDocsToolProvider();
    assert.equal(provider.id, "api-docs");
    assert.deepEqual(provider.createTools(makeContext()), []);
  });

  it("lists and describes the registered methods", async () => {
    const provider = createApiDocsToolProvider();
    const projectApi = await surfaceForBalanceProto();
    const tools = provider.createTools(makeContext({ projectApi }));
    assert.deepEqual(tools.map((tool) => tool.name), ["list_apis", "describe_api"]);

    const listed = await tools[0]!.execute("t1", {});
    const listedPayload = JSON.parse((listed.content as Array<{ type: string; text: string }>)[0].text);
    assert.deepEqual(listedPayload.methods, ["demo.v1.BalanceService/GetBalance"]);

    const described = await tools[1]!.execute("t2", { query: "getbalance" });
    const describedText = (described.content as Array<{ type: string; text: string }>)[0].text;
    assert.ok(describedText.includes("account_id"));

    const miss = await tools[1]!.execute("t3", { query: "nonexistent" });
    const missPayload = JSON.parse((miss.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(missPayload.ok, false);
    await assert.rejects(() => tools[1]!.execute("t4", { query: "" }), /non-empty/);
  });
});

// ── migration 0007: prds -> assets ───────────────────────────────────────────

describe("migration 0007_assets", () => {
  it("migrates legacy prds rows into prd-type assets and drops prds", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      const legacy = MIGRATIONS.filter((migration) => migration.name < "0007_assets");
      const insertApplied = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
      for (const migration of legacy) {
        db.exec(migration.sql);
        insertApplied.run(migration.name, new Date().toISOString());
      }
      // A legacy project + PRD row in the old shape.
      db.prepare("INSERT INTO projects (id, name, repo_url, created_at) VALUES (?, ?, ?, ?)")
        .run("p1", "legacy", "", "2026-01-01T00:00:00.000Z");
      db.prepare(
        "INSERT INTO prds (id, project_id, filename, format, size_bytes, created_at, content_ref) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("prd-1", "p1", "payment.md", 1, 42, "2026-01-01T00:00:00.000Z", "artifacts/p/-/prd/x");

      // Apply the remaining migrations (0007 onwards), mirroring migrate().
      for (const migration of MIGRATIONS.filter((m) => m.name >= "0007_assets")) {
        db.exec(migration.sql);
        insertApplied.run(migration.name, new Date().toISOString());
      }

      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name);
      assert.ok(tables.includes("assets"));
      assert.ok(!tables.includes("prds"));
      const migrated = db.prepare("SELECT * FROM assets WHERE id = 'prd-1'").get() as {
        type: string; filename: string; size_bytes: number; content_ref: string;
      };
      assert.equal(migrated.type, "prd");
      assert.equal(migrated.filename, "payment.md");
      assert.equal(migrated.size_bytes, 42);
      assert.equal(migrated.content_ref, "artifacts/p/-/prd/x");
    } finally {
      db.close();
    }
  });
});

// ── real asset handlers ──────────────────────────────────────────────────────

describe("real asset handlers (T22)", () => {
  it("upload -> list -> get -> delete round-trips a proto bundle", async () => {
    const db = HpathDb.inMemory();
    const dir = mkdtempSync(join(tmpdir(), "hpath-assets-"));
    const store = new LocalArtifactStore(dir);
    db.projects.create({
      id: "p1",
      name: "proj",
      repoUrl: "",
      createdAt: new Date().toISOString(),
    });
    // Asset handlers only touch db + artifactStore; the rest of the deps are
    // never reached by these handlers.
    const deps = { db, artifactStore: store } as unknown as RunExecutionDeps;
    try {
      const upload = createUploadAssetHandler(deps);
      const asset = await callUnary<Asset>(upload, {
        projectId: "p1",
        type: AssetType.ASSET_TYPE_PROTO,
        files: [
          { filename: "balance.proto", content: Buffer.from(BALANCE_PROTO) },
          { filename: "common.proto", content: Buffer.from(COMMON_PROTO) },
        ],
        entryFilename: "",
      });
      assert.equal(asset.type, AssetType.ASSET_TYPE_PROTO);
      assert.equal(asset.filename, "balance.proto");
      assert.equal(asset.fileCount, 2);
      assert.ok(asset.apiDoc.includes("demo.v1.BalanceService/GetBalance"));

      // Bytes really stored (manifest keys resolvable).
      const full = db.assets.getFull(asset.id)!;
      assert.equal(full.storedFiles.length, 2);
      for (const ref of full.storedFiles) {
        assert.ok(await store.exists(ref.key), `stored: ${ref.key}`);
      }

      // Guardrails.
      await assert.rejects(
        () =>
          callUnary<Asset>(upload, {
            projectId: "p1",
            type: AssetType.ASSET_TYPE_PRD,
            files: [{ filename: "a.md", content: Buffer.from("x") }],
            entryFilename: "",
          }),
        (err: { details: string }) => /ParsePRD/.test(err.details),
      );
      await assert.rejects(
        () =>
          callUnary<Asset>(upload, {
            projectId: "p1",
            type: AssetType.ASSET_TYPE_PROTO,
            files: [{ filename: "bad.proto", content: Buffer.from('syntax="proto3"; import "nope.proto";') }],
            entryFilename: "",
          }),
        (err: { code: number; details: string }) => err.details.includes("nope.proto"),
      );

      // List + get.
      const listed = await callUnary<{ assets: Asset[] }>(createListAssetsHandler(deps), {
        projectId: "p1",
        type: AssetType.ASSET_TYPE_PROTO,
      });
      assert.deepEqual(listed.assets.map((entry) => entry.id), [asset.id]);
      const got = await callUnary<Asset>(createGetAssetHandler(deps), { assetId: asset.id });
      assert.equal(got.apiDoc, asset.apiDoc);

      // Delete purges the row AND the bytes.
      await callUnary<Record<string, never>>(createDeleteAssetHandler(deps), { assetId: asset.id });
      assert.equal(db.assets.get(asset.id), undefined);
      for (const ref of full.storedFiles) {
        assert.equal(await store.exists(ref.key), false, `purged: ${ref.key}`);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── mock handler parity ──────────────────────────────────────────────────────

describe("mock asset handlers (T22 parity)", () => {
  it("uploadAsset parses for real, PRD is rejected, ParsePRD writes an asset row, delete works", async () => {
    const store = createMockStore();
    seedMockStore(store);
    const handlers = createMockHandlers(store);
    const projectId = [...store.projects.keys()][0]!;

    const asset = await callUnary<Asset>(handlers.uploadAsset, {
      projectId,
      type: AssetType.ASSET_TYPE_PROTO,
      files: [{ filename: "balance.proto", content: Buffer.from(BALANCE_STANDALONE) }],
      entryFilename: "",
    });
    assert.ok(asset.apiDoc.includes("demo.v1.BalanceService/GetBalance"));

    // PRD uploads belong to ParsePRD.
    await assert.rejects(
      () =>
        callUnary<Asset>(handlers.uploadAsset, {
          projectId,
          type: AssetType.ASSET_TYPE_PRD,
          files: [{ filename: "a.md", content: Buffer.from("x") }],
          entryFilename: "",
        }),
      (err: { details: string }) => /ParsePRD/.test(err.details),
    );

    // ParsePRD lands a prd-type asset row (library visibility).
    await new Promise<void>((resolve) => {
      const stream = {
        request: { projectId, filename: "payment.md", format: 1, content: Buffer.from("# PRD") },
        write: () => true,
        end: () => resolve(),
        emit: () => resolve(),
        cancelled: false,
      };
      handlers.parsePrd!(stream as never);
    });
    const prdAssets = [...store.assets.values()].filter((entry) => entry.type === AssetType.ASSET_TYPE_PRD);
    assert.equal(prdAssets.length, 1);

    // Delete: existing removes (unknown id surfaces NOT_FOUND).
    await callUnary<Record<string, never>>(handlers.deleteAsset, { assetId: asset.id });
    assert.equal(store.assets.has(asset.id), false);
    await assert.rejects(
      () => callUnary<Record<string, never>>(handlers.deleteAsset, { assetId: "missing" }),
      (err: { code: number }) => err.code === 5, // NOT_FOUND
    );
  });

  it("deleteProject cascades to assets", () => {
    const store = createMockStore();
    seedMockStore(store);
    const handlers = createMockHandlers(store);
    const projectId = [...store.projects.keys()][0]!;
    const seededAssets = [...store.assets.values()].filter((entry) => entry.projectId === projectId);
    assert.ok(seededAssets.length >= 1, "seed carries a proto asset");
    callUnary<Record<string, never>>(handlers.deleteProject, { projectId });
    assert.equal([...store.assets.values()].filter((entry) => entry.projectId === projectId).length, 0);
    assert.ok(store.assets.size === 0);
  });
});

