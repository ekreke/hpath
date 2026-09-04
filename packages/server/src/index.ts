// Server entrypoint. Usage:
//   node dist/index.js --mock            (default) mock mode, in-memory data
//   node dist/index.js --real            SQLite-backed reads (ListProjects/
//                                        ListEnvs/ListCases/GetCase, seeded on
//                                        first boot), settings + status chat;
//                                        other RPCs UNIMPLEMENTED
//   node dist/index.js --port 50051
//   node dist/index.js --host 0.0.0.0    bind address (env: HPATH_HOST)

import { createMockStore } from "./mock/store.js";
import { seedMockStore } from "./mock/seed.js";
import type { MockStore } from "./mock/store.js";
import { startServer } from "./grpc/server.js";
import type { ServerMode } from "./grpc/hpath.js";
import { HpathDb, defaultDbPath } from "./db/index.js";
import { seedDatabase } from "./db/seed.js";
import { SettingsStore } from "./settings.js";

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
  }

  const server = await startServer({ mode, port, host, store, db, settings });
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
