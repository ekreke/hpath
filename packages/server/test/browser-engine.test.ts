// T24: BrowserEngine factory + obscura install detection. Network + filesystem
// are stubbed so no binary is downloaded and no process is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrowserEngine,
  FULL_BROWSER_CAPABILITIES,
  ObscuraEngine,
  obscuraAssetName,
  SCREENSHOT_ONLY_CAPABILITIES,
} from "../src/agents/providers/browser-engine.js";

test("factory returns the engine matching the id and defaults to playwright", () => {
  const pw = createBrowserEngine("playwright");
  assert.equal(pw.id, "playwright");
  assert.deepEqual(pw.capabilities, FULL_BROWSER_CAPABILITIES);

  const obscura = createBrowserEngine("obscura");
  assert.equal(obscura.id, "obscura");
  assert.deepEqual(obscura.capabilities, SCREENSHOT_ONLY_CAPABILITIES);

  const fallback = createBrowserEngine("webkit");
  assert.equal(fallback.id, "playwright", "an unknown id falls back to the default engine");
});

test("obscuraAssetName maps supported platform/arch pairs", () => {
  assert.equal(obscuraAssetName("darwin", "arm64"), "obscura-aarch64-macos.tar.gz");
  assert.equal(obscuraAssetName("darwin", "x64"), "obscura-x86_64-macos.tar.gz");
  assert.equal(obscuraAssetName("linux", "x64"), "obscura-x86_64-linux.tar.gz");
  assert.equal(obscuraAssetName("linux", "arm64"), "obscura-aarch64-linux.tar.gz");
  assert.equal(obscuraAssetName("win32", "x64"), undefined);
  assert.equal(obscuraAssetName("darwin", "ia32"), undefined);
});

test("ObscuraEngine.ensureInstalled is true when the binary already exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpath-obscura-"));
  const binary = join(dir, "obscura");
  writeFileSync(binary, "#!/bin/sh\n");
  const engine = new ObscuraEngine({ binaryPath: binary, installDir: dir });
  assert.equal(await engine.ensureInstalled(), true);
});

test("ObscuraEngine.ensureInstalled returns false when the download fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hpath-obscura-"));
  const engine = new ObscuraEngine({
    binaryPath: join(dir, "obscura"),
    installDir: dir,
    fetchImpl: (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch,
  });
  assert.equal(await engine.ensureInstalled(), false);
});

test("ObscuraEngine.dispose before start is a no-op", async () => {
  const engine = new ObscuraEngine({ binaryPath: "/nonexistent/obscura" });
  await engine.dispose();
});
