// Server entrypoint. Usage:
//   node dist/index.js --mock            (default) mock mode, in-memory data
//   node dist/index.js --real            SQLite-backed persistence + the real
//                                        run path: RunCase executes approved
//                                        cases through the execute-agent,
//                                        evidence lands in the artifact store
//   node dist/index.js --port 50051
//   node dist/index.js --host 0.0.0.0    bind address (env: HPATH_HOST)

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMockStore } from "./mock/store.js";
import { seedMockStore } from "./mock/seed.js";
import type { MockStore } from "./mock/store.js";
import { startServer } from "./grpc/server.js";
import type { RealExecutionDeps, ServerMode } from "./grpc/hpath.js";
import { HpathDb, defaultDbPath } from "./db/index.js";
import { seedDatabase } from "./db/seed.js";
import { SettingsStore, agentModelOverrides } from "./settings.js";
import { AgentKernel } from "./agents/pipeline.js";
import { AgentRegistry } from "./agents/registry.js";
import { ToolProviderRegistry } from "./agents/tools.js";
import { registerBuiltIns } from "./agents/builtins.js";
import {
  createCatalogModelResolver,
  createDefaultModels,
  registerSettingsProviders,
} from "./agents/model.js";
import { ArtifactIndex } from "./artifacts/artifact-index.js";
import { createArtifactStore } from "./artifacts/store.js";

/** gRPC protos the grpc_call tool may resolve methods against. HPATH_GRPC_PROTOS
 * (colon-separated) wins; otherwise the repo's demo-app proto is probed at the
 * src/ and dist/ layouts. An empty list keeps grpc_call working for tools that
 * pass explicit protos-less targets... it reports a descriptive error instead:
 * proto resolution is configuration, not guessing. */
function resolveGrpcProtoPaths(): string[] {
  const fromEnv = process.env.HPATH_GRPC_PROTOS;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv.split(":").filter((entry) => entry.trim() !== "");
  }
  const candidates = [
    new URL("../../../fixtures/demo-app/proto/balance.proto", import.meta.url),
    new URL("../../../../fixtures/demo-app/proto/balance.proto", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return [path];
  }
  return [];
}

/** Build the T8 execution deps: agent kernel (built-ins, settings-driven
 * model) + artifact store. Providers register settings providers on every
 * call so a settings update applies without a server restart. */
async function buildExecutionDeps(db: HpathDb, settings: SettingsStore): Promise<RealExecutionDeps> {
  const agents = new AgentRegistry();
  const toolProviders = new ToolProviderRegistry();
  registerBuiltIns(agents, toolProviders, {
    ...agentModelOverrides(settings),
    grpc: { protoPaths: resolveGrpcProtoPaths() },
  });
  const models = createDefaultModels();
  const kernel = new AgentKernel({
    agents,
    toolProviders,
    resolveModel: (modelId) => {
      registerSettingsProviders(models, settings.get());
      return createCatalogModelResolver(models)(modelId);
    },
    streamFn: (model, context, streamOptions) => {
      registerSettingsProviders(models, settings.get());
      return models.streamSimple(model, context, streamOptions);
    },
  });
  const artifactStore = await createArtifactStore();
  const artifactIndex = new ArtifactIndex(db.artifacts);
  console.log(`[hpath-server] artifact store: ${artifactStore.backend}`);
  return { kernel, artifactStore, artifactIndex };
}

function parseArgs(argv: string[]): { mode: ServerMode; port: number; host: string } {
  let mode: ServerMode = "mock";
  let port = Number(process.env.HPATH_PORT ?? 50051);
  let host = process.env.HPATH_HOST ?? "127.0.0.1";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mock") mode = "mock";
    if (arg === "--real") mode = "real";
    if (arg === "--port") {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        port = value;
      }
    }
    if (arg === "--host") {
      const value = argv[i + 1];
      if (value) {
        host = value;
      }
    }
  }
  return { mode, port, host };
}

async function main(): Promise<void> {
  const { mode, port, host } = parseArgs(process.argv.slice(2));

  let store: MockStore | undefined;
  let db: HpathDb | undefined;
  let settings: SettingsStore | undefined;
  let execution: RealExecutionDeps | undefined;
  if (mode === "mock") {
    store = createMockStore();
    seedMockStore(store);
  } else {
    // Real mode: open (and migrate) the SQLite database, seeding demo data on
    // first boot. HPATH_DB_PATH overrides the default data/hpath.db.
    db = HpathDb.open();
    if (seedDatabase(db)) {
      console.log(`[hpath-server] seeded demo data into ${defaultDbPath()}`);
    }
    // Model provider settings (chat + agents); seeded on first boot.
    settings = SettingsStore.load();
    console.log(`[hpath-server] settings loaded from ${process.env.HPATH_SETTINGS_PATH ?? "data/settings.json"}`);
    // T8: the run path (RunCase/GetRun/DownloadArtifact) backed by the agent
    // kernel and the artifact store.
    execution = await buildExecutionDeps(db, settings);
  }

  const server = await startServer({ mode, port, host, store, db, settings, execution });
  console.log(`[hpath-server] mode=${mode} listening on ${host}:${server.port}`);

  const shutdown = (): void => {
    console.log("[hpath-server] shutting down");
    // Graceful shutdown with a hard fallback: tryShutdown can wait
    // indefinitely on open client connections, and an unexpected rejection
    // must never leave the process hanging.
    const force = setTimeout(() => {
      console.error("[hpath-server] graceful shutdown timed out, forcing shutdown");
      server.forceShutdown();
      process.exit(1);
    }, 5000);
    server
      .shutdown()
      .then(() => {
        clearTimeout(force);
        db?.close();
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("[hpath-server] shutdown failed:", err);
        clearTimeout(force);
        db?.close();
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err) => {
  console.error("[hpath-server] failed to start:", err);
  process.exit(1);
});
