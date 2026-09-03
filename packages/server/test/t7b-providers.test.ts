// T7b tests: built-in ToolProviders (browser / http / grpc), the kernel
// evidence store with the `record_evidence` tool, and the schema validator's
// minItems/maxItems extension. Provider tools are exercised directly through
// a fabricated ToolContext — no kernel, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import type { AddressInfo } from "node:net";
import {
  InMemoryEventSink,
  RunEvidence,
  VerdictChannel,
  createBrowserTools,
  createBrowserToolProvider,
  createGrpcCallTool,
  createHttpRequestTool,
  createRecordEvidenceTool,
  validateSchema,
  type ToolContext,
} from "../src/agents/index.js";
import { DEMO_APP_PROTO } from "./helpers/demo-app.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Fabricate a run ToolContext for direct provider testing. */
function makeContext(
  baseUrl: string,
  variables: Record<string, string> = {},
): ToolContext {
  const runId = crypto.randomUUID();
  return {
    runId,
    agentId: "provider-test",
    env: { projectId: "proj-1", envId: "env-dev", name: "dev", baseUrl, variables },
    input: {},
    events: new InMemoryEventSink({ runId }),
    verdict: new VerdictChannel({ type: "object" }),
    evidence: new RunEvidence(),
  };
}

interface HttpTestServer {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

/** Minimal HTTP server on an ephemeral port for http/browser provider tests. */
function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<HttpTestServer> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

// ── RunEvidence (kernel evidence store) ─────────────────────────────────────

test("RunEvidence records entries in order and disposes cleanups in reverse", async () => {
  const evidence = new RunEvidence();
  evidence.record({ rule: "r1" });
  evidence.record({ rule: "r2" });

  const order: string[] = [];
  evidence.registerCleanup(() => { order.push("first"); });
  evidence.registerCleanup(async () => { order.push("second"); });

  await evidence.dispose();
  await evidence.dispose(); // idempotent

  assert.deepEqual(evidence.entries.map((entry) => entry.rule), ["r1", "r2"]);
  assert.deepEqual(order, ["second", "first"]);
});

test("RunEvidence dispose swallows cleanup errors and still runs the rest", async () => {
  const evidence = new RunEvidence();
  const order: string[] = [];
  evidence.registerCleanup(() => { order.push("a"); });
  evidence.registerCleanup(() => { throw new Error("boom"); });
  evidence.registerCleanup(async () => { order.push("c"); });

  await evidence.dispose();
  assert.deepEqual(order, ["c", "a"]);
});

// ── record_evidence tool ────────────────────────────────────────────────────

test("record_evidence stores the entry and emits an evidence_recorded event", async () => {
  const context = makeContext("http://dev.example.test");
  const tool = createRecordEvidenceTool({ evidence: context.evidence, events: context.events });

  await tool.execute("call_1", { rule: "r", api: "a", ui: "u", match: true });
  await tool.execute("call_2", { rule: "r2", api: "a2", ui: "u2", match: false });

  assert.equal(context.evidence.entries.length, 2);
  const events = context.events.events();
  assert.equal(events.length, 2);
  const kinds = events.map((event) => event.payload.kind);
  assert.deepEqual(kinds, ["evidence_recorded", "evidence_recorded"]);

  await assert.rejects(
    () => tool.execute("call_3", "not an object"),
    /must be a JSON object/,
  );
});

// ── schema validator: minItems / maxItems ───────────────────────────────────

test("schema validator enforces minItems and maxItems on arrays", () => {
  const schema = {
    type: "object",
    required: ["alignments"],
    properties: {
      alignments: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: { type: "object", required: ["rule"], properties: { rule: { type: "string" } } },
      },
    },
  };

  assert.deepEqual(validateSchema({ alignments: [{ rule: "r" }] }, schema), []);
  const tooFew = validateSchema({ alignments: [] }, schema);
  assert.ok(tooFew.some((issue) => issue.path === "alignments" && issue.message.includes("minItems 1")));
  const tooMany = validateSchema({ alignments: [{ rule: "r" }, { rule: "r" }, { rule: "r" }] }, schema);
  assert.ok(tooMany.some((issue) => issue.path === "alignments" && issue.message.includes("maxItems 2")));
});

// ── http provider ───────────────────────────────────────────────────────────

test("http_request resolves relative URLs against the env base URL and parses JSON", async () => {
  const server = await startHttpServer((req, res) => {
    if (req.url === "/api/balance") return json(res, 200, { env: "dev", balance: "1337.50", balanceCents: 133750 });
    res.writeHead(404);
    res.end("{}");
  });
  try {
    const context = makeContext(server.baseUrl);
    const tool = createHttpRequestTool(context);
    const result = await tool.execute("call_1", { url: "/api/balance" });
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(payload.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.url, `${server.baseUrl}/api/balance`);
    assert.deepEqual(payload.body, { env: "dev", balance: "1337.50", balanceCents: 133750 });
  } finally {
    await server.close();
  }
});

test("http_request sends method, headers and body", async () => {
  const server = await startHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      json(res, 200, { method: req.method, seen: req.headers["x-test"], body: JSON.parse(body || "null") });
    });
  });
  try {
    const context = makeContext(server.baseUrl);
    const tool = createHttpRequestTool(context);
    const result = await tool.execute("call_1", {
      url: "/api/echo",
      method: "post",
      headers: { "x-test": "t7b" },
      body: JSON.stringify({ hello: "world" }),
    });
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    assert.deepEqual(payload.body, { method: "POST", seen: "t7b", body: { hello: "world" } });
  } finally {
    await server.close();
  }
});

test("http_request times out per its configured deadline", async () => {
  const server = await startHttpServer((req, res) => {
    setTimeout(() => json(res, 200, { ok: true }), 500);
  });
  try {
    const context = makeContext(server.baseUrl);
    const tool = createHttpRequestTool(context, { timeoutMs: 50 });
    const startedAt = Date.now();
    await assert.rejects(() => tool.execute("call_1", { url: "/slow" }), /timed out/);
    assert.ok(Date.now() - startedAt < 2000, "timeout should fire promptly");
  } finally {
    await server.close();
  }
});

test("http_request rejects non-http protocols and empty urls", async () => {
  const context = makeContext("http://dev.example.test");
  const tool = createHttpRequestTool(context);
  await assert.rejects(() => tool.execute("call_1", { url: "ftp://example.test/x" }), /only http\/https/);
  await assert.rejects(() => tool.execute("call_2", { url: "" }), /non-empty string "url"/);
});

// ── grpc provider ───────────────────────────────────────────────────────────

interface GrpcTestServer {
  target: string;
  shutdown(): Promise<void>;
}

/** In-process BalanceService speaking the demo-app proto. */
async function startGrpcServer(): Promise<GrpcTestServer> {
  const packageDefinition = protoLoader.loadSync(DEMO_APP_PROTO, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition);
  const server = new grpc.Server();
  server.addService((proto as Record<string, any>).demo.v1.BalanceService.service, {
    GetBalance: (_call: unknown, callback: (err: null, value: unknown) => void) => {
      callback(null, { env: "dev", currency: "CNY", balance: "1337.50", balanceCents: 133_750 });
    },
  });
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
  return {
    target: `127.0.0.1:${boundPort}`,
    shutdown: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

test("grpc_call resolves the method against configured protos and returns the reply", async () => {
  const grpcServer = await startGrpcServer();
  try {
    const context = makeContext("http://dev.example.test", { grpc_target: grpcServer.target });
    const tool = createGrpcCallTool(context, { protoPaths: [DEMO_APP_PROTO] });
    const result = await tool.execute("call_1", {
      method: "demo.v1.BalanceService/GetBalance",
      request: { account_id: "seed" },
    });
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.target, grpcServer.target);
    assert.deepEqual(payload.response, {
      env: "dev",
      currency: "CNY",
      balance: "1337.50",
      balanceCents: 133_750,
    });
  } finally {
    await grpcServer.shutdown();
  }
});

test("grpc_call env-binds its target: provider default only when the env has none", async () => {
  const grpcServer = await startGrpcServer();
  try {
    const context = makeContext("http://dev.example.test");
    const tool = createGrpcCallTool(context, {
      protoPaths: [DEMO_APP_PROTO],
      defaultTarget: grpcServer.target,
    });
    const result = await tool.execute("call_1", { method: "demo.v1.BalanceService/GetBalance" });
    const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(payload.target, grpcServer.target);
  } finally {
    await grpcServer.shutdown();
  }
});

test("grpc_call reports transport errors as structured results, not throws", async () => {
  // An unbound port: connection refused / unavailable, resolved (not thrown).
  const context = makeContext("http://dev.example.test", { grpc_target: "127.0.0.1:1" });
  const tool = createGrpcCallTool(context, { protoPaths: [DEMO_APP_PROTO], timeoutMs: 2000 });
  const result = await tool.execute("call_1", { method: "demo.v1.BalanceService/GetBalance" });
  const payload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
  assert.equal(payload.ok, false);
  assert.ok(payload.codeName.length > 0);
});

test("grpc_call rejects unknown services and calls without any target", async () => {
  // Target resolution happens first, so give the unknown-service call a target.
  const context = makeContext("http://dev.example.test", { grpc_target: "127.0.0.1:1" });
  const tool = createGrpcCallTool(context, { protoPaths: [DEMO_APP_PROTO] });
  await assert.rejects(
    () => tool.execute("call_1", { method: "nope.v1.Missing/Do" }),
    /service "nope\.v1\.Missing" not found/,
  );
  const noTargetContext = makeContext("http://dev.example.test");
  const noTargetTool = createGrpcCallTool(noTargetContext, { protoPaths: [DEMO_APP_PROTO] });
  await assert.rejects(
    () => noTargetTool.execute("call_2", { method: "demo.v1.BalanceService/GetBalance" }),
    /no gRPC target/,
  );
});

// ── browser provider ────────────────────────────────────────────────────────

const LOGIN_PAGE = `<!DOCTYPE html>
<html><head><title>登录 · Test</title></head>
<body>
  <form id="f">
    <input id="u" autocomplete="username">
    <input id="p" type="password">
    <button id="go" type="submit">登 录</button>
  </form>
  <div id="msg" style="display:none">welcome alice</div>
  <script>
    document.getElementById("f").addEventListener("submit", (ev) => {
      ev.preventDefault();
      document.getElementById("msg").style.display = "block";
    });
  </script>
</body></html>`;

test("browser provider drives navigate/fill/click/wait/read_page/screenshot end to end", async () => {
  const server = await startHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE);
  });
  const context = makeContext(server.baseUrl);
  try {
    const [navigate, click, fill, readPage, screenshot, wait] = createBrowserTools(context);

    const nav = await navigate!.execute("c1", { url: "/login" });
    const navPayload = JSON.parse((nav.content as Array<{ type: string; text: string }>)[0].text);
    assert.equal(navPayload.url, `${server.baseUrl}/login`);
    assert.equal(navPayload.title, "登录 · Test");
    assert.equal(navPayload.status, 200);

    await fill!.execute("c2", { selector: "#u", value: "alice" });
    await fill!.execute("c3", { selector: "#p", value: "secret" });
    await click!.execute("c4", { selector: "#go" });
    await wait!.execute("c5", { selector: "#msg" });

    const page = await readPage!.execute("c6", {});
    const pagePayload = JSON.parse((page.content as Array<{ type: string; text: string }>)[0].text);
    assert.ok(pagePayload.text.includes("welcome alice"), "read_page should see the post-click state");

    const shot = await screenshot!.execute("c7", { label: "after-login" });
    assert.match((shot.content as Array<{ type: string; text: string }>)[0].text, /screenshot captured/);
    const shotEvents = context.events.events().filter((event) => event.payload.kind === "screenshot");
    assert.equal(shotEvents.length, 1);
    const shotPayload = shotEvents[0].payload as { label: string; mime: string; base64: string };
    assert.equal(shotPayload.label, "after-login");
    assert.equal(shotPayload.mime, "image/png");
    assert.ok(shotPayload.base64.length > 100);

    // Env-bound navigation: absolute non-http URLs are refused.
    await assert.rejects(() => navigate!.execute("c8", { url: "file:///etc/passwd" }), /only http\/https/);
  } finally {
    await context.evidence.dispose();
    await server.close();
  }
});

test("browser provider: run-scoped cleanup closes the session (isolation)", async () => {
  const server = await startHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>hi</body></html>");
  });
  const context = makeContext(server.baseUrl);
  const tools = createBrowserTools(context);
  const navigate = tools.find((tool) => tool.name === "navigate")!;

  await navigate.execute("c1", { url: "/" });
  await context.evidence.dispose();
  await assert.rejects(() => navigate.execute("c2", { url: "/" }), /already closed/);
  await server.close();
});

test("built-in provider registry entries describe the T7b tool surface", () => {
  const browserProvider = createBrowserToolProvider();
  assert.equal(browserProvider.id, "browser");
  const tools = browserProvider.createTools(makeContext("http://dev.example.test"));
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["click", "fill", "navigate", "read_page", "screenshot", "wait"],
  );
  // Provider-created sessions register their cleanup on the run evidence.
  assert.equal(tools.length > 0, true);
});
