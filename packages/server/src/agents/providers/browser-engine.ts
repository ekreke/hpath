// Browser engines (T24): the browser ToolProvider can be backed by exactly one
// engine at a time, selected from settings. This module owns the engine
// abstraction and the two built-in implementations:
//
//   - playwright: the bundled Playwright chromium process. Full evidence
//     (recordVideo + tracing) is available.
//   - obscura: the Obscura headless engine (https://github.com/h4ckf0r0day/obscura)
//     run as a local `obscura serve` CDP endpoint. The server connects over
//     `chromium.connectOverCDP`. Obscura does NOT implement Playwright's
//     `page.video()` or tracing artifacts, so runs on this engine degrade to
//     per-step screenshots + live CDP frames (capabilities below say so).
//
// The engines are mutually exclusive and never fall back to one another: if
// the selected engine is unavailable the browser tools are disabled instead.
//
// Obscura installation: on first use the binary is downloaded from the GitHub
// releases (latest) into `data/browsers/obscura` unless HPATH_OBSCURA_PATH
// points at an existing binary. The serve process is started on demand and
// killed on dispose.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { DEFAULT_BROWSER_ENGINE, isBrowserEngineId } from "../../settings.js";
import type { BrowserEngineId } from "../../settings.js";

/** Evidence features an engine can produce for a run. */
export interface BrowserCapabilities {
  /** Playwright `recordVideo` (per-run webm). */
  video: boolean;
  /** Playwright tracing (trace.zip). */
  tracing: boolean;
}

/** Full evidence (Playwright chromium). */
export const FULL_BROWSER_CAPABILITIES: BrowserCapabilities = { video: true, tracing: true };

/** Screenshots + live frames only (Obscura). */
export const SCREENSHOT_ONLY_CAPABILITIES: BrowserCapabilities = { video: false, tracing: false };

/** A mutually-exclusive browser backend. */
export interface BrowserEngine {
  readonly id: BrowserEngineId;
  readonly capabilities: BrowserCapabilities;
  /**
   * Make sure the underlying browser is present (download/install when the
   * engine supports it). Returns false when the engine cannot be used — the
   * caller must then disable the browser tools rather than fall back.
   */
  ensureInstalled(): Promise<boolean>;
  /** Launch/connect one browser instance (each pooled slot is one instance). */
  launch(): Promise<Browser>;
  /** Release engine-level resources (long-lived processes). Idempotent. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Playwright chromium
// ---------------------------------------------------------------------------

export class PlaywrightEngine implements BrowserEngine {
  readonly id = "playwright" as const;
  readonly capabilities = FULL_BROWSER_CAPABILITIES;

  constructor(private readonly options: { headless?: boolean } = {}) {}

  async ensureInstalled(): Promise<boolean> {
    try {
      const path = chromium.executablePath();
      // An empty path means Playwright resolves a system/channel browser at
      // launch time; fall through and let launch() decide.
      return !path || existsSync(path);
    } catch {
      return false;
    }
  }

  async launch(): Promise<Browser> {
    return chromium.launch({ headless: this.options.headless ?? true });
  }

  async dispose(): Promise<void> {
    // A launched chromium owns its process; the pool's browser.close() handles
    // teardown. Nothing engine-level to release.
  }
}

// ---------------------------------------------------------------------------
// Obscura (CDP)
// ---------------------------------------------------------------------------

/** Default install directory, relative to the working directory. */
export const DEFAULT_OBSCURA_DIR = "data/browsers";

/** Release asset name for a platform/arch pair, or undefined when unsupported. */
export function obscuraAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
  const archToken = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  if (!archToken) return undefined;
  if (platform === "darwin") return `obscura-${archToken}-macos.tar.gz`;
  if (platform === "linux") return `obscura-${archToken}-linux.tar.gz`;
  return undefined;
}

export interface ObscuraEngineOptions {
  /** Explicit binary path; defaults to HPATH_OBSCURA_PATH then <installDir>/obscura. */
  binaryPath?: string;
  /** Download directory; defaults to HPATH_OBSCURA_DIR then data/browsers. */
  installDir?: string;
  /** Obscura serve port; defaults to an ephemeral free port. */
  port?: number;
  /** Allow navigating loopback/LAN (required for the local demo-app). Default true. */
  allowPrivateNetwork?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Readiness poll timeout in ms (default 20000). */
  readyTimeoutMs?: number;
}

export class ObscuraEngine implements BrowserEngine {
  readonly id = "obscura" as const;
  readonly capabilities = SCREENSHOT_ONLY_CAPABILITIES;

  private readonly binaryPath: string;
  private readonly installDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly readyTimeoutMs: number;
  private readonly allowPrivateNetwork: boolean;
  private requestedPort?: number;
  private child?: ChildProcess;
  private port?: number;
  private startPromise?: Promise<void>;

  constructor(options: ObscuraEngineOptions = {}) {
    this.installDir = options.installDir ?? process.env.HPATH_OBSCURA_DIR ?? DEFAULT_OBSCURA_DIR;
    this.binaryPath =
      options.binaryPath ?? process.env.HPATH_OBSCURA_PATH ?? join(this.installDir, "obscura");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 20_000;
    this.allowPrivateNetwork = options.allowPrivateNetwork ?? true;
    this.requestedPort = options.port;
  }

  /** Download the release binary when it is not already present. */
  async ensureInstalled(): Promise<boolean> {
    if (existsSync(this.binaryPath)) return true;
    const asset = obscuraAssetName(process.platform, process.arch);
    if (!asset) {
      console.error(`[hpath-server] obscura: unsupported platform ${process.platform}/${process.arch}`);
      return false;
    }
    const url = `https://github.com/h4ckf0r0day/obscura/releases/latest/download/${asset}`;
    const tarball = join(this.installDir, asset);
    try {
      mkdirSync(this.installDir, { recursive: true });
      console.log(`[hpath-server] obscura: downloading ${url}`);
      const response = await this.fetchImpl(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        console.error(`[hpath-server] obscura download failed: HTTP ${response.status}`);
        return false;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tarball, bytes);
      // The release is a tar.gz holding `obscura` + `obscura-worker`.
      const { execFileSync } = await import("node:child_process");
      execFileSync("tar", ["-xzf", tarball, "-C", this.installDir], { stdio: "ignore" });
      chmodSync(this.binaryPath, 0o755);
      if (!existsSync(this.binaryPath)) {
        console.error(`[hpath-server] obscura archive did not contain ${this.binaryPath}`);
        return false;
      }
      console.log(`[hpath-server] obscura: installed ${this.binaryPath}`);
      return true;
    } catch (err) {
      console.error("[hpath-server] obscura install failed:", err);
      return false;
    } finally {
      rmSync(tarball, { force: true });
    }
  }

  async launch(): Promise<Browser> {
    await this.start();
    const endpoint = `http://127.0.0.1:${this.port}`;
    return chromium.connectOverCDP(endpoint);
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.port = undefined;
    this.startPromise = undefined;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private async start(): Promise<void> {
    if (this.child && this.port) return;
    this.startPromise ??= this.startOnce().catch((err) => {
      this.startPromise = undefined;
      throw err;
    });
    await this.startPromise;
  }

  private async startOnce(): Promise<void> {
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `obscura binary not found at ${this.binaryPath} — install it (ensureInstalled) or set HPATH_OBSCURA_PATH`,
      );
    }
    const port = this.requestedPort ?? (await pickFreePort());
    const args = ["serve", "--port", String(port)];
    if (this.allowPrivateNetwork) args.push("--allow-private-network");
    const child = spawn(this.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.port = port;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[hpath-server] obscura: ${text}`);
    });
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
        this.port = undefined;
        this.startPromise = undefined;
      }
      if (code !== 0 && code !== null) {
        console.error(`[hpath-server] obscura serve exited with code ${code}`);
      }
    });
    await waitForCdp(port, this.fetchImpl, this.readyTimeoutMs, child);
  }
}

// ---------------------------------------------------------------------------
// Factory + helpers
// ---------------------------------------------------------------------------

export interface BrowserEngineFactoryOptions {
  headless?: boolean;
  obscura?: ObscuraEngineOptions;
}

/** Build the engine for an id (falls back to the Playwright engine on junk ids). */
export function createBrowserEngine(
  id: unknown,
  options: BrowserEngineFactoryOptions = {},
): BrowserEngine {
  const engineId: BrowserEngineId = isBrowserEngineId(id) ? id : DEFAULT_BROWSER_ENGINE;
  if (engineId === "obscura") return new ObscuraEngine(options.obscura);
  return new PlaywrightEngine({ headless: options.headless });
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForCdp(
  port: number,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`obscura serve exited early (code ${child.exitCode})`);
    }
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`obscura serve did not become ready on port ${port} within ${timeoutMs}ms`);
}
