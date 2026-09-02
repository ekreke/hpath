// demo-app: the three-way aligned system under test for HPath 1.0 (SPEC T4).
//
// One seeded balance value is served over three channels so an agent (or a
// human) can verify they agree:
//   1. UI   — dashboard balance card (rendered by the page from /api/balance)
//   2. HTTP — GET /api/balance
//   3. gRPC — demo.v1.BalanceService/GetBalance
//
// Dev and staging instances run with different BALANCE_SEED values, so env
// switching is observable in every channel. Code comments in English;
// user-facing copy is Chinese.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { ReflectionService } from "@grpc/reflection";

// ── configuration ─────────────────────────────────────────────────────────

function toCents(seed) {
  const match = /^(\d+)\.(\d{2})$/.exec(seed);
  if (!match) {
    throw new Error(`BALANCE_SEED must look like "238.00", got: "${seed}"`);
  }
  return Number(match[1]) * 100 + Number(match[2]);
}

function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

const config = {
  env: process.env.APP_ENV ?? "dev",
  httpPort: Number(process.env.HTTP_PORT ?? 8080),
  grpcPort: Number(process.env.GRPC_PORT ?? 9090),
  // Seeded value in cents; every channel serves this exact number.
  balanceCents: toCents(process.env.BALANCE_SEED ?? "0.00"),
  currency: process.env.BALANCE_CURRENCY ?? "CNY",
  user: process.env.DEMO_USER ?? "demo",
  pass: process.env.DEMO_PASS ?? "demo1234",
};

// In-memory session store; a restart logs everyone out, which is fine for a
// demo SUT.
const sessions = new Map();
const SESSION_COOKIE = "demo_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ── helpers ───────────────────────────────────────────────────────────────

function parseCookies(header) {
  const jar = {};
  for (const part of header?.split(";") ?? []) {
    const idx = part.indexOf("=");
    if (idx > 0) jar[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return jar;
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = token ? sessions.get(token) : undefined;
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function readJsonBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

// ── pages ─────────────────────────────────────────────────────────────────

function loginPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Demo 电商</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
    background:#f5f6f8;color:#1a1a1a;min-height:100vh;display:grid;place-items:center}
  .card{width:340px;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:32px 28px}
  .brand{font-size:18px;font-weight:700;letter-spacing:-.01em}
  .brand span{color:#8a8f98;font-weight:500;font-size:12px;margin-left:8px}
  h1{font-size:15px;font-weight:600;margin:22px 0 4px}
  .sub{font-size:12.5px;color:#8a8f98;margin-bottom:18px}
  label{display:block;font-size:12px;color:#5c626b;margin:12px 0 4px}
  input{width:100%;height:36px;border:1px solid #d5d9de;border-radius:7px;padding:0 10px;font-size:13.5px;outline:none}
  input:focus{border-color:#1a1a1a}
  button{width:100%;height:38px;margin-top:18px;border:0;border-radius:7px;background:#1a1a1a;color:#fff;
    font-size:13.5px;font-weight:600;cursor:pointer}
  button:hover{background:#000}
  .err{display:none;margin-top:12px;font-size:12.5px;color:#c62828}
  .hint{margin-top:18px;padding-top:14px;border-top:1px solid #eef0f2;font-size:12px;color:#8a8f98;line-height:1.7}
  .hint code{font-family:"SF Mono",Menlo,monospace;font-size:11.5px;background:#f0f2f4;border-radius:4px;padding:1px 5px}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Demo 电商<span>测试环境样例应用</span></div>
    <h1>登录</h1>
    <div class="sub">登录后查看账户余额</div>
    <form id="f">
      <label for="u">用户名</label>
      <input id="u" autocomplete="username">
      <label for="p">密码</label>
      <input id="p" type="password" autocomplete="current-password">
      <button type="submit">登 录</button>
      <div class="err" id="e">用户名或密码错误</div>
    </form>
    <div class="hint">演示账号：<code>${config.user}</code> / <code>${config.pass}</code><br>
      当前实例环境：<code>${config.env}</code></div>
  </div>
<script>
  document.getElementById("f").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("u").value,
        password: document.getElementById("p").value
      })
    });
    if (r.ok) { location.href = "/"; return; }
    document.getElementById("e").style.display = "block";
  });
</script>
</body>
</html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的账户 · Demo 电商</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;
    background:#f5f6f8;color:#1a1a1a;min-height:100vh}
  header{height:52px;background:#fff;border-bottom:1px solid #e3e5e8;display:flex;align-items:center;
    gap:12px;padding:0 24px}
  .brand{font-size:15px;font-weight:700}
  .env{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5c626b;
    border:1px solid #d5d9de;border-radius:999px;padding:2px 10px}
  header .ops{margin-left:auto}
  header a{font-size:12.5px;color:#8a8f98;text-decoration:none;cursor:pointer}
  header a:hover{color:#1a1a1a}
  main{max-width:760px;margin:0 auto;padding:32px 20px}
  .balance-card{background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:26px 28px}
  .balance-card .l{font-size:12.5px;color:#8a8f98}
  .balance-card .v{font-size:40px;font-weight:700;letter-spacing:-.02em;margin:10px 0 4px;
    font-variant-numeric:tabular-nums}
  .balance-card .s{font-size:12px;color:#8a8f98}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
  .cell{background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:16px 18px}
  .cell .l{font-size:11.5px;color:#8a8f98}
  .cell .v{font-size:16px;font-weight:600;margin-top:6px;font-variant-numeric:tabular-nums}
  footer{max-width:760px;margin:26px auto 40px;padding:0 20px;font-size:12px;color:#8a8f98;line-height:1.9}
  footer code{font-family:"SF Mono",Menlo,monospace;font-size:11px;background:#eceef0;border-radius:4px;padding:1px 5px}
</style>
</head>
<body>
  <header>
    <span class="brand">Demo 电商</span>
    <span class="env" id="env">…</span>
    <span class="ops"><a id="logout">退出登录</a></span>
  </header>
  <main>
    <div class="balance-card">
      <div class="l">账户余额</div>
      <div class="v" id="balance">加载中…</div>
      <div class="s" id="meta"></div>
    </div>
    <div class="grid">
      <div class="cell"><div class="l">积分</div><div class="v">2,400</div></div>
      <div class="cell"><div class="l">优惠券</div><div class="v">3 张</div></div>
      <div class="cell"><div class="l">本月订单</div><div class="v">5 单</div></div>
    </div>
  </main>
  <footer>
    三方对齐检查点：本页余额（UI）= <code>GET /api/balance</code>（HTTP）=
    <code>demo.v1.BalanceService/GetBalance</code>（gRPC）。<br>
    dev 与 staging 实例使用不同的种子数据，切换环境后数值应当变化。
  </footer>
<script>
  const $ = (id) => document.getElementById(id);
  fetch("/api/balance").then(r => r.json()).then(d => {
    $("env").textContent = d.env;
    $("balance").textContent = "¥ " + Number(d.balance).toLocaleString("zh-CN", { minimumFractionDigits: 2 });
    $("meta").textContent = d.currency + " · balanceCents=" + d.balanceCents;
  });
  $("logout").addEventListener("click", async () => {
    await fetch("/api/login", { method: "DELETE" });
    location.href = "/login";
  });
</script>
</body>
</html>`;
}

// ── http server ───────────────────────────────────────────────────────────

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  // Public endpoints (kept open so curl/grpcurl can cross-check the value
  // without logging in — see SPEC T4 verify).
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, env: config.env });
  }
  if (req.method === "GET" && url.pathname === "/api/balance") {
    return sendJson(res, 200, {
      env: config.env,
      currency: config.currency,
      balance: formatCents(config.balanceCents),
      balanceCents: config.balanceCents,
    });
  }

  if (req.method === "GET" && url.pathname === "/login") {
    return sendHtml(res, 200, loginPage());
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    if (body.username === config.user && body.password === config.pass) {
      const token = randomBytes(24).toString("hex");
      sessions.set(token, { user: body.username, createdAt: Date.now() });
      return sendJson(res, 200, { ok: true }, {
        "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax`,
      });
    }
    return sendJson(res, 401, { ok: false, error: "用户名或密码错误" });
  }

  if (req.method === "DELETE" && url.pathname === "/api/login") {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true }, {
      "set-cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`,
    });
  }

  // Everything below requires a session.
  if (!getSession(req)) {
    res.writeHead(302, { location: "/login" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, dashboardPage());
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : "internal error";
    sendJson(res, message.includes("too large") || message.includes("invalid JSON") ? 400 : 500,
      { ok: false, error: message });
  });
});

// ── grpc server (same seeded value, channel 3) ────────────────────────────

const protoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../proto/balance.proto");
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
});
const demoProto = grpc.loadPackageDefinition(packageDefinition);

const grpcServer = new grpc.Server();
grpcServer.addService(demoProto.demo.v1.BalanceService.service, {
  GetBalance: (call, callback) => {
    callback(null, {
      env: config.env,
      currency: config.currency,
      balance: formatCents(config.balanceCents),
      balanceCents: config.balanceCents,
    });
  },
});
// Reflection so grpcurl can browse the service without the proto file.
new ReflectionService(packageDefinition).addToServer(grpcServer);

// ── startup ───────────────────────────────────────────────────────────────

httpServer.listen(config.httpPort, "0.0.0.0", () => {
  console.log(`[demo-app] env=${config.env} http listening on 0.0.0.0:${config.httpPort}`);
});

grpcServer.bindAsync(`0.0.0.0:${config.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) {
    console.error("[demo-app] grpc bind failed:", err);
    process.exit(1);
  }
  console.log(`[demo-app] env=${config.env} grpc listening on 0.0.0.0:${config.grpcPort}`);
});

console.log(`[demo-app] env=${config.env} seeded balance=${formatCents(config.balanceCents)} ${config.currency}`);

function shutdown() {
  httpServer.close();
  grpcServer.tryShutdown(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
