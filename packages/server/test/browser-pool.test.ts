// T23: BrowserPool unit tests — prewarm/acquire/release/resize, dead-instance
// eviction, disabled-pool passthrough and shutdown. A stub Browser replaces a
// real chromium so no browser binary is needed here (integration over the real
// launcher is covered by the t7b provider suite).

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { BrowserPool } from "../src/agents/providers/browser-pool.js";
import {
  FULL_BROWSER_CAPABILITIES,
  SCREENSHOT_ONLY_CAPABILITIES,
} from "../src/agents/providers/browser-engine.js";
import type { BrowserEngine } from "../src/agents/providers/browser-engine.js";

/** Minimal Browser stub: healthy by default, closable, killable. */
function stubBrowser(healthy = true): Browser & { kill: () => void } {
  let closed = false;
  const browser = {
    isConnected: () => healthy && !closed,
    close: async () => {
      closed = true;
    },
    kill: () => {
      closed = true;
    },
  };
  return browser as never;
}

test("prewarm launches up to the target size", async () => {
  let launches = 0;
  const pool = new BrowserPool({
    size: 2,
    launcher: async () => {
      launches += 1;
      return stubBrowser();
    },
  });
  await pool.prewarm();
  assert.equal(pool.idleCount, 2);
  assert.equal(launches, 2);
  await pool.close();
});

test("acquire hands out an idle browser and release returns it", async () => {
  let launches = 0;
  const pool = new BrowserPool({
    size: 1,
    launcher: async () => {
      launches += 1;
      return stubBrowser();
    },
  });
  await pool.prewarm();
  const first = await pool.acquire();
  assert.equal(pool.idleCount, 0);
  assert.equal(launches, 1);
  await pool.release(first);
  assert.equal(pool.idleCount, 1);
  assert.equal(launches, 1, "a released healthy browser must be reused, not relaunched");
  await pool.close();
});

test("acquire with an empty pool launches on demand and release keeps it idle up to the target", async () => {
  let launches = 0;
  const pool = new BrowserPool({
    size: 1,
    launcher: async () => {
      launches += 1;
      return stubBrowser();
    },
  });
  const b1 = await pool.acquire();
  const b2 = await pool.acquire();
  assert.equal(launches, 2, "concurrent acquisitions beyond the pool size launch ephemeral browsers");
  await pool.release(b1);
  assert.equal(pool.idleCount, 1, "released while there is room -> kept idle");
  await pool.release(b2);
  assert.equal(pool.idleCount, 1, "released beyond the target -> closed, not pooled");
  assert.equal(launches, 2);
  await pool.close();
});

test("dead idle instances are evicted on acquire and prewarm", async () => {
  const created: Array<ReturnType<typeof stubBrowser>> = [];
  const pool = new BrowserPool({
    size: 2,
    launcher: async () => {
      const b = stubBrowser();
      created.push(b);
      return b;
    },
  });
  await pool.prewarm();
  created[0]!.kill();
  // Acquire must skip the dead one and hand out the healthy one.
  const acquired = await pool.acquire();
  assert.equal(acquired, created[1]);
  assert.equal(pool.idleCount, 0);
  await pool.release(acquired);
  // Prewarm evicts dead instances and refills to the target.
  created[1]!.kill();
  created[0]!.kill();
  await pool.prewarm();
  assert.equal(pool.idleCount, 2);
  await pool.close();
});

test("release of a dead browser closes it instead of pooling it", async () => {
  let launches = 0;
  let closes = 0;
  const pool = new BrowserPool({
    size: 1,
    launcher: async () => {
      launches += 1;
      const b = stubBrowser();
      const originalClose = b.close.bind(b);
      (b as { close: () => Promise<void> }).close = async () => {
        closes += 1;
        await originalClose();
      };
      return b;
    },
  });
  const b = await pool.acquire();
  (b as unknown as { kill: () => void }).kill();
  await pool.release(b);
  assert.equal(pool.idleCount, 0);
  assert.equal(closes, 1, "a dead release must be closed/discarded");
  await pool.close();
});

test("resize grows with prewarm and shrink closes surplus idle browsers", async () => {
  const closes: unknown[] = [];
  const pool = new BrowserPool({
    size: 1,
    launcher: async () => {
      const b = stubBrowser();
      const originalClose = b.close.bind(b);
      (b as { close: () => Promise<void> }).close = async () => {
        closes.push(b);
        await originalClose();
      };
      return b;
    },
  });
  await pool.prewarm();
  await pool.resize(3);
  assert.equal(pool.idleCount, 3);
  const leased = await pool.acquire();
  assert.equal(pool.idleCount, 2);
  await pool.resize(1);
  assert.equal(pool.idleCount, 1, "shrink closes surplus idle browsers");
  await pool.release(leased);
  assert.equal(pool.idleCount, 1, "a leased browser released into a shrunken pool is closed");
  await pool.close();
  assert.equal(pool.idleCount, 0);
});

test("close() drains idle browsers and the pool afterwards launches fresh per acquire", async () => {
  let launches = 0;
  const pool = new BrowserPool({
    size: 2,
    launcher: async () => {
      launches += 1;
      return stubBrowser();
    },
  });
  await pool.prewarm();
  await pool.close();
  assert.equal(pool.idleCount, 0);
  const b = await pool.acquire();
  assert.equal(launches, 3, "post-close acquire launches fresh (server already shutting down)");
  await pool.release(b);
  assert.equal(pool.idleCount, 0, "release after close discards the browser");
});

test("size 0 disables pooling: acquire launches, release closes", async () => {
  let launches = 0;
  let closes = 0;
  const pool = new BrowserPool({
    size: 0,
    launcher: async () => {
      launches += 1;
      const b = stubBrowser();
      const originalClose = b.close.bind(b);
      (b as { close: () => Promise<void> }).close = async () => {
        closes += 1;
        await originalClose();
      };
      return b;
    },
  });
  await pool.prewarm();
  assert.equal(pool.idleCount, 0);
  const b = await pool.acquire();
  assert.equal(launches, 1);
  await pool.release(b);
  assert.equal(closes, 1, "release with no room must close the browser");
  await pool.close();
});

/** Stub BrowserEngine that hands out stub browsers and tracks disposal. */
function stubEngine(
  id: BrowserEngine["id"],
  capabilities = FULL_BROWSER_CAPABILITIES,
  onDispose?: () => void,
): BrowserEngine {
  return {
    id,
    capabilities,
    ensureInstalled: async () => true,
    launch: async () => stubBrowser(),
    dispose: async () => {
      onDispose?.();
    },
  };
}

test("capabilities come from the current engine", async () => {
  const engine = stubEngine("obscura", SCREENSHOT_ONLY_CAPABILITIES);
  const pool = new BrowserPool({ size: 0, engine });
  assert.deepEqual(pool.capabilities, SCREENSHOT_ONLY_CAPABILITIES);
  assert.equal(pool.engineId, "obscura");
  await pool.close();
});

test("setEngine closes the previous idle browsers and disposes it", async () => {
  let disposed = 0;
  const first = stubEngine("playwright", FULL_BROWSER_CAPABILITIES, () => {
    disposed += 1;
  });
  const second = stubEngine("obscura", SCREENSHOT_ONLY_CAPABILITIES);
  const pool = new BrowserPool({ size: 2, engine: first });
  await pool.prewarm();
  assert.equal(pool.idleCount, 2);
  await pool.setEngine(second);
  assert.equal(pool.engineId, "obscura");
  assert.equal(disposed, 1, "the replaced engine is disposed once its idle set closes");
  assert.equal(pool.idleCount, 2, "the new engine is prewarmed");
  await pool.close();
});

test("setEngine defers disposal until a leased browser returns, then closes it", async () => {
  let disposed = 0;
  let closes = 0;
  const first = stubEngine("playwright", FULL_BROWSER_CAPABILITIES, () => {
    disposed += 1;
  });
  // Replace the stubbed launch so we can count the leased browser's close().
  (first as { launch: () => Promise<Browser> }).launch = async () => {
    const b = stubBrowser();
    const originalClose = b.close.bind(b);
    (b as { close: () => Promise<void> }).close = async () => {
      closes += 1;
      await originalClose();
    };
    return b;
  };
  const second = stubEngine("obscura", SCREENSHOT_ONLY_CAPABILITIES);
  const pool = new BrowserPool({ size: 1, engine: first });
  const leased = await pool.acquire();
  await pool.setEngine(second);
  assert.equal(disposed, 0, "an engine with an in-flight lease must not be disposed yet");
  await pool.release(leased);
  assert.equal(closes, 1, "the retired engine's leased browser is closed on release");
  assert.equal(disposed, 1, "the retired engine disposes once its last lease drains");
  await pool.close();
});
