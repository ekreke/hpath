// Browser pool (T23/T24): warm browser instances kept alive between runs so
// the first browser tool call of a run does not pay the cold-launch cost.
//
// What is pooled: only the browser process/connection (Playwright `Browser`).
// Every run still creates its own fresh BrowserContext (cookies/storage/cache
// partition isolation, per-run evidence) — the per-run isolation invariant
// holds at the context level; the pool just removes process startup from the
// critical path.
//
// Engine (T24): the pool is backed by exactly one BrowserEngine at a time
// (playwright chromium or obscura CDP). `setEngine()` hot-swaps it: the old
// engine's idle instances are closed immediately, its leased ones are closed
// as their runs release them, and the engine's process is disposed once the
// last lease drains — so switching never kills an in-flight run.
//
// Lifecycle: `prewarm()` launches up to the configured number of idle
// browsers; `acquire()` pops a healthy idle one (verified via isConnected) or
// launches a fresh browser on the spot; `release()` returns a browser to the
// idle set if there is room, otherwise closes it. `resize()` re-aligns the
// idle count with a new settings value (closing surplus, prewarming the
// shortfall). A browser that dies while idle is evicted lazily on the next
// acquire/prewarm. `close()` (server shutdown) closes everything.

import type { Browser } from "playwright";
import { FULL_BROWSER_CAPABILITIES } from "./browser-engine.js";
import type { BrowserCapabilities, BrowserEngine } from "./browser-engine.js";

/** Launch + close are injected so tests can stub chromium without spawning. */
export type BrowserLauncher = () => Promise<Browser>;

export interface BrowserPoolOptions {
  /** Idle browsers kept warm (0 = pool effectively disabled). */
  size?: number;
  /** Playwright chromium launcher (legacy/test path; wrapped as an engine). */
  launcher?: BrowserLauncher;
  /** Engine backing the pool (T24). Takes precedence over `launcher`. */
  engine?: BrowserEngine;
}

export class BrowserPool {
  private engine: BrowserEngine;
  private idle: Browser[] = [];
  /** Browsers handed out via acquire(), mapped to the engine that produced them. */
  private readonly leased = new Map<Browser, BrowserEngine>();
  /** Engines replaced by setEngine/close; disposed once their last lease drains. */
  private readonly retired = new Set<BrowserEngine>();
  private targetSize: number;
  private closed = false;

  constructor(options: BrowserPoolOptions = {}) {
    this.targetSize = Math.max(0, Math.floor(options.size ?? 0));
    this.engine = options.engine ?? launcherEngine(options.launcher ?? defaultLauncher);
  }

  /** Evidence capabilities of the current engine (full for the launcher path). */
  get capabilities(): BrowserCapabilities {
    return this.engine.capabilities;
  }

  /** Id of the current engine (used to forbid cross-engine fallbacks). */
  get engineId(): BrowserEngine["id"] {
    return this.engine.id;
  }

  /** Current idle count (healthy or not — eviction happens lazily). */
  get idleCount(): number {
    return this.idle.length;
  }

  /** Configured warm size; 0 means the pool is disabled. */
  get size(): number {
    return this.targetSize;
  }

  /**
   * Launch browsers until `idle` reaches the target size. Failures are
   * logged and swallowed: a cold pool must not break server startup — the
   * first acquire() will launch on demand instead.
   */
  async prewarm(): Promise<void> {
    await this.fillIdle();
  }

  /**
   * Take a browser: a healthy idle one when available, otherwise a fresh
   * launch (pool disabled/empty/dead instances). The caller MUST eventually
   * call release() or the browser leaks until the process exits.
   */
  async acquire(): Promise<Browser> {
    if (!this.closed) {
      // Evict dead instances from the front before handing one out.
      while (this.idle.length > 0) {
        const browser = this.idle.shift()!;
        if (browser.isConnected()) {
          this.leased.set(browser, this.engine);
          return browser;
        }
        await this.disposeQuietly(browser);
      }
    }
    const browser = await this.engine.launch();
    this.leased.set(browser, this.engine);
    return browser;
  }

  /**
   * Return a previously acquired browser. It re-enters the idle set while
   * there is room (idle < target) and is still healthy; otherwise it is
   * closed. A browser leased from a retired engine is always closed, and its
   * engine disposed once the last lease drains. Unknown/closed browsers are
   * tolerated (idempotent).
   */
  async release(browser: Browser): Promise<void> {
    const engine = this.leased.get(browser);
    this.leased.delete(browser);
    if (engine === undefined) return;
    const reusable =
      browser.isConnected()
      && !this.closed
      && engine === this.engine
      && !this.retired.has(engine)
      && this.idle.length < this.targetSize;
    if (reusable) {
      this.idle.push(browser);
    } else {
      await this.disposeQuietly(browser);
    }
    await this.disposeEngineIfDrained(engine);
  }

  /**
   * Apply a new pool size (settings update): shrink closes surplus idle
   * browsers (leased ones close on release), grow prewarms the shortfall.
   * Best-effort and non-throwing.
   */
  async resize(size: number): Promise<void> {
    this.targetSize = Math.max(0, Math.floor(size));
    await this.fillIdle();
  }

  /**
   * Hot-swap the backing engine (settings update). New acquires use the new
   * engine immediately; the previous engine's idle browsers close now and its
   * leased ones are closed on release, disposing the old process only when the
   * last in-flight run is done. Best-effort.
   */
  async setEngine(engine: BrowserEngine): Promise<void> {
    if (engine === this.engine) return;
    const previous = this.engine;
    this.engine = engine;
    const idle = this.idle.splice(0);
    await Promise.all(idle.map((b) => this.disposeQuietly(b)));
    if (this.leasedCountFor(previous) === 0) {
      await this.disposeEngine(previous);
    } else {
      this.retired.add(previous);
    }
    await this.fillIdle();
  }

  /** Close every idle browser (server shutdown). Leased ones are the
   * sessions' responsibility; the engine is disposed once they drain. */
  async close(): Promise<void> {
    this.closed = true;
    const idle = this.idle.splice(0);
    await Promise.all(idle.map((b) => this.disposeQuietly(b)));
    if (this.leasedCountFor(this.engine) === 0) {
      await this.disposeEngine(this.engine);
    } else {
      this.retired.add(this.engine);
    }
  }

  /** Launch idle browsers up to target, evicting dead ones first. Shrink
   * closes the surplus beyond the target. */
  private async fillIdle(): Promise<void> {
    if (this.closed) return;
    // Evict dead instances first so they do not count toward the target.
    const alive: Browser[] = [];
    for (const browser of this.idle) {
      if (browser.isConnected()) {
        alive.push(browser);
      } else {
        await this.disposeQuietly(browser);
      }
    }
    this.idle = alive;
    // Shrink: close healthy idle browsers beyond the new target.
    while (this.idle.length > this.targetSize) {
      await this.disposeQuietly(this.idle.pop()!);
    }
    // Grow: prewarm the shortfall.
    while (this.idle.length < this.targetSize) {
      try {
        this.idle.push(await this.engine.launch());
      } catch (err) {
        console.error("[hpath-server] browser pool prewarm failed:", err);
        break;
      }
    }
  }

  private leasedCountFor(engine: BrowserEngine): number {
    let count = 0;
    for (const leasedEngine of this.leased.values()) {
      if (leasedEngine === engine) count += 1;
    }
    return count;
  }

  private async disposeEngineIfDrained(engine: BrowserEngine): Promise<void> {
    if (this.leasedCountFor(engine) > 0) return;
    if (engine === this.engine && !this.closed) return;
    if (this.retired.delete(engine) || this.closed) {
      await this.disposeEngine(engine);
    }
  }

  private async disposeEngine(engine: BrowserEngine): Promise<void> {
    try {
      await engine.dispose();
    } catch (err) {
      console.error("[hpath-server] browser engine dispose failed:", err);
    }
  }

  private async disposeQuietly(browser: Browser): Promise<void> {
    try {
      await browser.close();
    } catch {
      // A dead browser may fail to close; nothing more to do.
    }
  }
}

/** Wrap a bare launcher as a full-capability engine (legacy/test compatibility). */
function launcherEngine(launcher: BrowserLauncher): BrowserEngine {
  return {
    id: "playwright",
    capabilities: FULL_BROWSER_CAPABILITIES,
    ensureInstalled: async () => true,
    launch: launcher,
    dispose: async () => {},
  };
}

async function defaultLauncher(): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true });
}
