// Test helper (T7b): starts the demo-app SUT (fixtures/demo-app) as a local
// node process on free ports — the headless strategy for the execute-agent
// acceptance run (node, no docker). Each call spawns its own isolated
// instance, so tests never share sessions or seeded state.

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo-root fixtures/demo-app server entrypoint. */
export const DEMO_APP_SERVER_JS = path.join(
  HELPERS_DIR,
  "../../../../fixtures/demo-app/src/server.js",
);

/** Demo-app proto; used to configure the built-in grpc ToolProvider. */
export const DEMO_APP_PROTO = path.join(
  HELPERS_DIR,
  "../../../../fixtures/demo-app/proto/balance.proto",
);

/** Credentials baked into the demo-app (its login page also displays them). */
export const DEMO_USER = "demo";
export const DEMO_PASS = "demo1234";

/** Dev seed: the compose dev instance serves the same value. */
export const DEMO_SEED = "1337.50";
export const DEMO_SEED_CENTS = 133_750;

export interface DemoApp {
  httpPort: number;
  grpcPort: number;
  baseUrl: string;
  grpcTarget: string;
  /** Seeded balance string served by all three channels. */
  seed: string;
  /** SIGTERM the instance and wait for exit. */
  stop(): Promise<void>;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitUntilHealthy(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
      lastError = `health status ${response.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`demo-app did not become healthy within ${timeoutMs}ms: ${lastError}`);
}

/** Start a dev demo-app instance on fresh ports with the given seed. */
export async function startDemoApp(seed = DEMO_SEED): Promise<DemoApp> {
  const httpPort = await getFreePort();
  const grpcPort = await getFreePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [DEMO_APP_SERVER_JS],
    {
      env: {
        ...process.env,
        APP_ENV: "dev",
        HTTP_PORT: String(httpPort),
        GRPC_PORT: String(grpcPort),
        BALANCE_SEED: seed,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[demo-app] ${chunk}`);
  });

  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const app: DemoApp = {
    httpPort,
    grpcPort,
    baseUrl,
    grpcTarget: `127.0.0.1:${grpcPort}`,
    seed,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
  try {
    await waitUntilHealthy(baseUrl);
  } catch (err) {
    await app.stop();
    throw err;
  }
  return app;
}
