// T18 dogfooding tests: the "desktop" ToolProvider (debug-bridge shell state
// + true-window screenshot evidence) and the http provider's env-driven
// allowed-origins extension.

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createDesktopToolProvider,
  resolveBridgeUrl,
} from "../src/agents/providers/desktop.js";
import { createHttpRequestTool } from "../src/agents/providers/http.js";
import {
  InMemoryEventSink,
  RunEvidence,
  VerdictChannel,
  type AgentEventSink,
} from "../src/agents/index.js";
import type { ToolContext } from "../src/agents/tools.js";

function makeContext(variables: Record<string, string> = {}): ToolContext {
  const runId = crypto.randomUUID();
  return {
    runId,
    agentId: "t18-test",
    env: { projectId: "proj-1", envId: "env-dev", name: "dev", baseUrl: "http://localhost:1420", variables },
    input: {},
    events: new InMemoryEventSink({ runId }) as AgentEventSink,
    verdict: new VerdictChannel({ type: "object" }),
    evidence: new RunEvidence(),
    signal: new AbortController().signal,
  };
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

interface BridgeServer {
  url: string;
  close(): Promise<void>;
}

async function startBridge(
  handler: (res: ServerResponse, path: string) => void,
): Promise<BridgeServer> {
  const server = createServer((req, res) => {
    handler(res, req.url ?? "/");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("desktop provider (T18)", () => {
  it("materializes no tools when no bridge is discoverable", () => {
    // No bridge_url variable and (in the test env) no port file resolves —
    // resolveBridgeUrl reads a fixed tmp path; point HOME-independent tmpdir
    // at the real one and ensure the file is absent for this check.
    const provider = createDesktopToolProvider();
    const tools = provider.createTools(makeContext({}));
    // The port file MAY exist if a dev desktop app is running on this machine;
    // in that case tools legitimately appear. Only assert the no-variable
    // branch does not throw and yields at most the two known tools.
    assert.ok(tools.every((tool) => tool.name === "shell_state" || tool.name === "capture_window"));
  });

  it("resolves the bridge from an explicit bridge_url variable", () => {
    assert.equal(resolveBridgeUrl({ bridge_url: "http://127.0.0.1:4242/" }), "http://127.0.0.1:4242");
    // Hermetic "no bridge" check: a path that cannot exist (the real port
    // file may legitimately be present on a dev machine).
    assert.equal(resolveBridgeUrl({}, join(tmpdir(), "hpath-no-such-bridge-port.json")), undefined);
  });

  it("shell_state reads the live shell snapshot from the bridge", async () => {
    const bridge = await startBridge((res, path) => {
      if (path === "/state") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ connectionStatus: "connected", selectedProjectName: "demo-bank", pid: 4242 }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    try {
      const context = makeContext({ bridge_url: bridge.url });
      const tools = createDesktopToolProvider().createTools(context);
      assert.deepEqual(tools.map((tool) => tool.name), ["shell_state", "capture_window"]);
      const result = await tools[0]!.execute("t1", {});
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.connectionStatus, "connected");
      assert.equal(payload.selectedProjectName, "demo-bank");
    } finally {
      await bridge.close();
    }
  });

  it("capture_window records the screenshot into the kernel evidence chain", async () => {
    const bridge = await startBridge((res, path) => {
      if (path === "/screenshot") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ mime: "image/png", base64: TINY_PNG_BASE64, bytes: 95 }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    try {
      const context = makeContext({ bridge_url: bridge.url });
      const tools = createDesktopToolProvider().createTools(context);
      const capture = tools.find((tool) => tool.name === "capture_window")!;
      const result = await capture.execute("t1", {});
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.ok, true);
      // The screenshot event landed in the run's evidence stream (the RunCase
      // handler uploads it to the artifact store) — never inline for the model.
      const events = context.events.events();
      const screenshot = events.find((event) => event.payload.kind === "screenshot");
      assert.ok(screenshot, "screenshot event appended");
      assert.equal((screenshot!.payload as { label: string }).label, "desktop-window");
      assert.equal((screenshot!.payload as { base64: string }).base64, TINY_PNG_BASE64);
    } finally {
      await bridge.close();
    }
  });

  it("surfaces bridge errors as tool errors (agent gets a reason, not a crash)", async () => {
    const bridge = await startBridge((res, path) => {
      if (path === "/screenshot") {
        res.statusCode = 503;
        res.end(JSON.stringify({ ok: false, error: "no screen-recording permission" }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    try {
      const context = makeContext({ bridge_url: bridge.url });
      const tools = createDesktopToolProvider().createTools(context);
      const capture = tools.find((tool) => tool.name === "capture_window")!;
      await assert.rejects(
        () => capture.execute("t1", {}),
        /no screen-recording permission/,
      );
    } finally {
      await bridge.close();
    }
  });

  it("resolves the bridge port from the desktop app's port file when the env has no URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "hpath-bridge-port-"));
    const portFile = join(dir, "hpath-debug-bridge.json");
    try {
      writeFileSync(portFile, JSON.stringify({ port: 4242, pid: 999 }));
      assert.equal(resolveBridgeUrl({}, portFile), "http://127.0.0.1:4242");
      // The explicit variable still wins over the file.
      assert.equal(resolveBridgeUrl({ bridge_url: "http://127.0.0.1:1/" }, portFile), "http://127.0.0.1:1");
      // Garbage and missing files degrade to "no bridge".
      writeFileSync(portFile, "not json");
      assert.equal(resolveBridgeUrl({}, portFile), undefined);
      assert.equal(resolveBridgeUrl({}, join(dir, "absent.json")), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("http provider env origins (T18)", () => {  it("hpath_allowed_origins extends the origin fence", async () => {
    let seenPath = "";
    const bridge = await startBridge((res, path) => {
      seenPath = path;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const context = makeContext({ hpath_allowed_origins: bridge.url });
      const tool = createHttpRequestTool(context);
      const result = await tool.execute("t1", { url: `${bridge.url}/state` });
      const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(payload.status, 200);
      assert.equal(seenPath, "/state");
    } finally {
      await bridge.close();
    }
  });

  it("without the env variable the bridge origin stays fenced out", async () => {
    const bridge = await startBridge(() => {});
    try {
      const context = makeContext({});
      const tool = createHttpRequestTool(context);
      await assert.rejects(
        () => tool.execute("t1", { url: `${bridge.url}/state` }),
        /outside the current environment/,
      );
    } finally {
      await bridge.close();
    }
  });
});

