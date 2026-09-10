# Agent Design

All agents run on the pi agent framework: `@earendil-works/pi-agent-core` (Agent runtime, tool calling, hooks) + `@earendil-works/pi-ai` (multi-provider LLM API, OpenAI configured in 1.0).

## Two Extension Layers

Agents are *registered definitions*, never hardcoded branches. Two registries compose:

```
AgentRegistry (agent-level extension entry)
  AgentDefinition = {
    id, role, systemPromptTemplate,
    toolBindings: ToolProviderId[],
    model, hardLimits {maxSteps, tokenBudget, timeoutMs},
    inputSchema, outputSchema
  }
  1.0 built-ins: analyze-agent, execute-agent
  1.1+: diagnose-agent, optimize-agent, config/MCP-injected custom agents

ToolProviderRegistry (tool-level extension entry)
  1.0 built-ins: browser, http, grpc, evidence, prd-analysis, api-docs, desktop
  1.1+ reserved: mcp/<external-server>, skills/<name>
```

The server kernel only knows `AgentDefinition`. Adding an agent = registering a definition; orchestration (triggering, event streaming, evidence recording, hard limits) is shared and unchanged.

## Built-in Agents (1.0)

### analyze-agent (PRD -> case drafts)

- Input: PRD file (md read directly; docx via mammoth; pdf via pdf-parse) + existing case list.
- Output: one or more case drafts with status `pending` (require human approval in the client before they can run).
- Tools: `read_prd`, `list_existing_cases`, `write_case_draft` (schema-validated), `finish`.
- Each draft records: creator `{type: "agent", run}`, `source_prd_ref`, version.

### execute-agent (autonomous case execution)

- Input: case definition + relevant PRD section + current env config.
- Mode: pure autonomous. The case states *what to verify and what counts as pass* (goal + alignments); the agent decides *how* (pages to open, buttons to click, APIs to call).
- Verdict: structured three-way alignment evidence per alignment entry:
  `{api: observed response, ui: observed display, rule, match: bool, notes}`.
- Tools:

| Provider | Tools |
|----------|-------|
| browser | navigate, click, fill, read_page, screenshot, wait |
| http | http_request |
| grpc | grpc_call |
| evidence (kernel) | record_evidence, finish_verdict |
| api-docs | list_apis, describe_api (T22; no tools without a project API surface) |
| desktop | shell_state, capture_window (T18 dogfood; no tools unless the desktop client's debug bridge is discoverable) |

**Project API surface (T22):** proto assets uploaded through the asset
library are parsed server-side into a method allowlist + markdown API doc.
The compact method list is injected into the execute-agent system prompt
(`{{input.apiSurface}}`), the api-docs provider exposes on-demand schema
lookup, and `grpc_call` hard-validates every call against the allowlist
before any network I/O — methods outside the surface are rejected with the
defined methods listed. HTTP stays origin-fenced with the doc as soft
guidance only.

## Isolation Rules

- Every run = a fresh pi Agent session. No cross-run or cross-env memory.
- Env binding: system prompt + tool config contain only the current env's targets/variables. Other envs are invisible.
- Storage namespace: runs / events / artifacts keyed by `(project, env, run)`.
- Execution isolation: one browser **BrowserContext** per run; `recordVideo` + `tracing.start(screenshots, snapshots, sources)` + per-step screenshots when the selected engine supports them (see the browser engine section below). The browser process may be shared (see the browser pool below) — contexts are what carry the per-run state.

## Browser Pool (T23)

The browser ToolProvider can borrow its chromium process from a warm pool
(`BrowserPool`, `agents/providers/browser-pool.ts`) instead of launching one
per run:

- `AppSettings.browser_pool_size` (Settings → Models in the desktop): warm
  chromium instances kept idle between runs. `0` disables the pool (launch
  per run — the pre-T23 behavior); the server caps the value at
  `MAX_BROWSER_POOL = 4`; default `1`.
- Each pooled instance is a bare chromium process (~0.6–1 GB RSS headless on
  macOS, less in the playwright docker image). Every run still creates its
  own fresh `BrowserContext` (cookies/storage/cache partitions, video,
  trace, screencast), so per-run isolation is unchanged; pooling only shares
  the process infrastructure.
- Lifecycle: prewarm at server boot (best-effort, non-blocking), `acquire()`
  hands out a healthy idle browser (`isConnected()` checked; dead instances
  are evicted) or launches fresh when the pool is empty/disabled,
  `release()` re-pools while there is room (idle < target) and closes
  otherwise. Concurrency beyond the pool size launches ephemeral browsers —
  no queuing.
- `UpdateSettings` resizes the live pool (grow = prewarm the shortfall,
  shrink = close surplus idle browsers; leased ones close on release) — no
  restart needed. Server shutdown closes every pooled instance.
- Isolation trade-off: a pooled chromium shares process-level caches (DNS,
  GPU/network service). Playwright BrowserContexts isolate cookies, storage
  and cache partitions, which is what the tests observe. A browser that
  dies mid-run is discarded on release and replaced on the next acquire.

## Browser Engine Selection (T24)

The pool is backed by exactly one **engine** at a time, chosen in settings
(`AppSettings.browser_engine`, Settings → Models in the desktop):

- `playwright` (default) — the bundled Playwright chromium. Full evidence:
  `recordVideo` + tracing + screenshots + live frames.
- `obscura` — the [Obscura](https://github.com/h4ckf0r0day/obscura) Rust
  headless engine, run as a local `obscura serve` CDP endpoint and attached
  with `chromium.connectOverCDP`. Obscura does not implement Playwright
  `page.video()` or tracing artifacts, so runs degrade to per-step screenshots
  + live CDP frames (the engine advertises this via
  `BrowserCapabilities`, and `BrowserSession` skips the unsupported evidence).
  The `serve` process is started with `--allow-private-network` so the local
  SUT is reachable (Obscura blocks private IPs by default).

Rules that hold for both engines:

- **Mutually exclusive, no fallback.** A failed borrow only falls back to a
  fresh Playwright launch when the active engine is Playwright; for any other
  engine the failure surfaces. An engine that is not installed disables the
  browser tools (they report a clear error) — the server never silently
  switches to the other engine.
- **Install-on-first-use.** `PlaywrightEngine.ensureInstalled()` checks the
  bundled chromium; `ObscuraEngine.ensureInstalled()` downloads the platform
  release archive into `data/browsers/obscura` (or uses `HPATH_OBSCURA_PATH`).
  Failure leaves the engine selected but unavailable.
- **Live hot-swap.** `UpdateSettings` calls `BrowserPool.setEngine()` when the
  id changes: new acquires use the new engine immediately, the previous
  engine's idle instances close at once, its leased ones close as their runs
  release them, and its process is disposed only when the last in-flight run
  drains — switching never kills a running case.
- **Isolation limit.** Obscura pages share a single V8 isolate, so CPU-bound
  JavaScript on one page blocks the others (unlike per-process chromium).

## Hard Limits

Configured per AgentDefinition, enforced by the kernel:

- `maxSteps` — stop and fail with evidence preserved.
- `tokenBudget` — cumulative input+output token cap.
- `timeoutMs` — wall-clock cap (kernel-internal unit: milliseconds; the contract/UI unit for the per-env override is minutes, converted once at the env boundary).

On limit breach: status `failed`, reason `limit:<kind>`, all collected evidence retained.

## Run State Machine (runtime control)

```
PENDING --> RUNNING <--> PAUSED
             |  \           |
             v   v----------+--> CANCELLED
          PASSED  FAILED
```

- The run row is created `PENDING` (the gRPC handler), flips to `RUNNING` when the kernel's agent starts, and settles to `PASSED` / `FAILED` / `CANCELLED`.
- **Pause** (`PauseRun`) suspends the agent at a turn boundary: the pi loop awaits the kernel's turn-end listener, so the loop parks there while the browser session, event sink and transcript stay alive. `ResumeRun` continues the same session.
- While paused the wall-clock timer is stopped (suspended time is neither charged to the timeout nor to the run's `durationMs`).
- **Cancel** (`CancelRun`) aborts the agent and the run signal (interrupting in-flight browser/http/grpc work) and settles the run as `CANCELLED` with reason `cancelled`; evidence recorded so far is retained. Allowed from PENDING, RUNNING and PAUSED.
- Control RPCs reach the run through `AgentKernel.runControl` (a runId → controller registry populated by the pipeline for the duration of a run). Unknown ids → `NOT_FOUND`; not-in-flight or invalid transitions → `FAILED_PRECONDITION`.
- A breach (`limit:<kind>`) always wins over cancellation: it settles `FAILED` with its reason, evidence intact.

## Evidence Pipeline (shared by all agents)

Every agent run streams events through the same pipe:

- Event types: agent text/thinking, tool_call started/finished, screenshot captured, request/response recorded, verdict produced, error.
- Events persist to SQLite (`events` table) and stream to clients over gRPC server-streaming.
- Binary evidence uploads to SeaweedFS; metadata (key, kind, sha256) persists in `artifacts` table.
- pi hooks used for recording: `afterToolCall` (capture tool results), before/after run (session boundaries).

## OpenAI Access

- Provider configured via `pi-ai` with an OpenAI API key from server env (`OPENAI_API_KEY`).
- Model id configurable per AgentDefinition; defaults set in server config.
