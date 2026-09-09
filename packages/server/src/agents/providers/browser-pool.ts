// Browser pool (T23): warm chromium processes kept alive between runs so the
// first browser tool call of a run does not pay the cold-launch cost.
//
// What is pooled: ONLY the chromium process (Playwright `Browser`). Every run
// still creates its own fresh BrowserContext (cookies/storage/cache partition
// isolation, video + trace recording) — the per-run isolation invariant holds
// at the context level, exactly as before; the pool just removes the process
// startup from the critical path.
//
// Lifecycle: `prewarm()` launches up to the configured number of idle
// browsers; `acquire()` pops a healthy idle one (verified via isConnected) or
// launches a fresh browser on the spot; `release()` returns a browser to the
// idle set if there is room, otherwise closes it. `resize()` re-aligns the
// idle count with a new settings value (closing surplus, prewarming the
// shortfall). A browser that dies while idle is evicted lazily on the next
// acquire/prewarm. `close()` (server shutdown) closes everything.

import { chromium } from "playwright";
import type { Browser } from "playwright";

/** Launch + close are injected so tests can stub chromium without spawning. */
export type BrowserLauncher = () => Promise<Browser>;

export interface BrowserPoolOptions {
  /** Idle browsers kept warm (0 = pool effectively disabled). */
  size?: number;
  /** Playwright chromium launcher (default: real chromium.launch). */
  launcher?: BrowserLauncher;
}

export class BrowserPool {
  private readonly launcher: BrowserLauncher;
  private idle: Browser[] = [];
  /** Browsers handed out via acquire(); not closable until released/closed. */
  private readonly leased = new Set<Browser>();
  private targetSize: number;
  private closed = false;

  constructor(options: BrowserPoolOptions = {}) {
    this.targetSize = Math.max(0, Math.floor(options.size ?? 0));
    this.launcher = options.launcher ?? defaultLauncher;
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
    if (this.closed) {
      return this.launch();
    }
    // Evict dead instances from the front before handing one out.
    while (this.idle.length > 0) {
      const browser = this.idle.shift()!;
      if (browser.isConnected()) {
        this.leased.add(browser);
        return browser;
      }
      await this.disposeQuietly(browser);
    }
    return this.launch();
  }

  /**
   * Return a previously acquired browser. It re-enters the idle set while
   * there is room (idle < target) and is still healthy; otherwise it is
   * closed. Unknown/closed browsers are tolerated (idempotent).
   */
  async release(browser: Browser): Promise<void> {
    if (!browser.isConnected() || this.closed || this.idle.length >= this.targetSize) {
      await this.disposeQuietly(browser);
      this.leased.delete(browser);
      return;
    }
    this.leased.delete(browser);
    this.idle.push(browser);
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

  /** Close every idle browser (server shutdown). Leased ones are the
   * sessions' responsibility; they will be discarded on release(). */
  async close(): Promise<void> {
    this.closed = true;
    const idle = this.idle.splice(0);
    await Promise.all(idle.map((b) => this.disposeQuietly(b)));
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
        this.idle.push(await this.launcher());
      } catch (err) {
        console.error("[hpath-server] browser pool prewarm failed:", err);
        break;
      }
    }
  }

  private async launch(): Promise<Browser> {
    return this.launcher();
  }

  private async disposeQuietly(browser: Browser): Promise<void> {
    try {
      await browser.close();
    } catch {
      // A dead browser may fail to close; nothing more to do.
    }
  }
}

async function defaultLauncher(): Promise<Browser> {
  return chromium.launch({ headless: true });
}
