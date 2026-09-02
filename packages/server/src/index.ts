// Server entrypoint. Usage:
//   node dist/index.js --mock            (default) mock mode, in-memory data
//   node dist/index.js --real            skeleton, all methods UNIMPLEMENTED
//   node dist/index.js --port 50051

import { createMockStore } from "./mock/store.js";
import { seedMockStore } from "./mock/seed.js";
import { startServer } from "./grpc/server.js";
import type { ServerMode } from "./grpc/hpath.js";

function parseArgs(argv: string[]): { mode: ServerMode; port: number } {
  let mode: ServerMode = "mock";
  let port = Number(process.env.HPATH_PORT ?? 50051);
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
  }
  return { mode, port };
}

async function main(): Promise<void> {
  const { mode, port } = parseArgs(process.argv.slice(2));

  let store;
  if (mode === "mock") {
    store = createMockStore();
    seedMockStore(store);
  }

  const server = await startServer({ mode, port, store });
  console.log(`[hpath-server] mode=${mode} listening on 127.0.0.1:${server.port}`);

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
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error("[hpath-server] shutdown failed:", err);
        clearTimeout(force);
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
