# SPEC 1.0 — End-to-End Spike

Active version: **1.0** (see `milestones.md`). This file is the single source of truth for scope and progress. One checkbox = one dev-workflow iteration (progress-tracker -> implement -> testing-stage -> checkpoint).

Status legend: `[ ]` todo, `[x]` done, `[~]` in progress.

## Architecture Invariants (protected every iteration)

- Desktop (Tauri) is display + triggers only; server owns orchestration, persistence, scheduling.
- Every run is isolated: fresh agent session, own Playwright context, own `(project, env, run)` storage namespace.
- Agents are registered `AgentDefinition`s (AgentRegistry), never hardcoded branches; tools come from ToolProviders.
- All docs and code comments in English.

## Execution Strategy: Client-First, Mock-First

Desktop work is prioritized. The gRPC contract (T1) is finalized once, up front. The server skeleton ships a `--mock` mode (in-memory seed data + scripted run event streams + synthetic artifacts) implementing the same contract. All desktop tasks (T10–T14) are built and verified against the mock. Later tasks (C/D sections) replace mock internals with real implementations behind the identical contract — zero client rework.

Iteration order: **T1 -> T10 -> T16 -> T11 -> T17 -> T12 -> T13 -> T14 -> T2 -> T4 -> T5 -> T6 -> T7a -> T7b -> T8 -> T9 -> T3 -> T15 -> T21 -> T22 -> T23 -> T18.**

---

## Artifact Storage Configuration

Binary artifacts (video / screenshots / trace / request records) go through a
single `ArtifactStore` interface. The backend is selected by env var
`HPATH_ARTIFACT_STORE`:

- `local` (default): filesystem directory rooted at `HPATH_ARTIFACT_DIR`
  (default `data/artifacts`). Simplest setup; used by the default compose stack.
- `seaweedfs`: S3 API against the SeaweedFS single container, for the full
  compose topology (`docker compose --profile s3 up`).

Both backends share the same key scheme: `artifacts/{project}/{env}/{run}/...`.
1.0 implements and verifies `local` first; the `seaweedfs` backend lands with T6.

## A. Contract & Mock Foundation

- [x] **T1 Workspace skeleton + gRPC contract + server skeleton with mock mode**
  pnpm workspace; `proto/hpath.proto` defining all 1.0 services (ListProjects, CreateProject, ListEnvs, UpsertEnv, DeleteEnv, ParsePRD, ListCases, GetCase, ReviewCase, RunCase, ListRuns, GetRun, DownloadArtifact); generated TS types; server skeleton serving echo impls plus `--mock` mode: in-memory seed data (1 demo project with metadata repo_url, envs `dev`+`staging`, 5 example cases: 4 approved (two scripted-outcome probes: hard-limit, alignment-drift) + 1 pending agent draft, 2 finished sample runs: 1 passed + 1 failed), scripted RunCase event stream, synthetic artifacts (small generated video/screenshot/trace placeholders).
  *Verify: `pnpm -r build` passes; grpcurl reflection lists services; `--mock` server answers ListProjects/RunCase with seed data and a scripted event stream.*
  Scope note (2026-09): the contract gained `UpdateProject` + `DeleteProject` (cascade delete with best-effort artifact purge) after the desktop projects page landed; T17 similarly extended the contract with the chat RPCs.

## B. Desktop First (built and verified against mock)

- [x] **T10 Desktop skeleton**
  Tauri 2 project (src-tauri Rust tonic client + IPC commands; React shell); project/env switchers wired; connection status.
  *Verify: `tauri dev` on macOS lists mock project/envs via Rust gRPC.*
  Scope note (2026-09): the desktop IA overhaul superseded the sidebar project/env switchers — project selection lives in the Projects page (list → workspace), env selection in the Cases run panel.

- [x] **T11 Management views**
  PRD management (upload/trigger/trace), case list (creator/status/last-run columns), case detail (info + review actions approve/reject/disable, env strip, run history), env management (CRUD), run trigger (approved only).
  *Verify: review a pending mock draft -> approved -> appears runnable; env CRUD works against mock.*

- [x] **T12 Live run panel**
  Streaming event feed (thinking/tool calls/screenshots/request records), hard-limit status bar, trigger from case detail. `run_case` forwards every stream event to the webview on the `run-event` channel (`RunEventDto`, tagged by kind) while still resolving with the final outcome; `download_artifact` IPC fetches artifact bytes (base64) so screenshot events render inline with click-to-zoom; the status bar shows live steps (tool starts) and elapsed time, plus the finished run's duration/token cost (max/budget columns wait for T8's real limits — the proto carries no budget fields). Mock live-run outcomes follow a title-keyword convention (`outcomeForTitle` in handlers.ts): the seeded probe cases demo the hard-limit and alignment-fail paths on any env.
  *Verify: trigger mock run from UI; panel renders scripted events live (20 events over ~8s); final verdict shown; the seeded drift case ends FAILED with mismatch evidence; the limit probe ends FAILED on `limit:max_steps`.*

- [x] **T13 Run detail (replay)**
  Inline webm player + screenshot timeline + agent transcript; trace.zip download with one-click `playwright show-trace`; re-run button.
  *Verify: replay the mock finished run through all three layers (synthetic artifacts).*

- [x] **T14 History view**
  Run list filtered by project/env/case/status/date; per-case health strip (last N results).
  *Verify: mock runs visible and filterable.*

- [x] **T16 Desktop packaging + release CI**
  Tauri bundler enabled (macOS `.app` + `.dmg`, unsigned); `make dist` builds the bundle locally. GitHub Actions workflow (`.github/workflows/release.yml`) builds the macOS dmg on release publish and attaches it to the release assets (workflow_dispatch runs the same build as a dry run). Server address is runtime-configurable: a `set_server_addr` IPC command validates and holds the address Rust-side (AppState); the input + Apply persists it client-side (localStorage) and no command hardcodes it.
  *Verify: `make dist` produces `.app`/`.dmg` under `src-tauri/target/release/bundle/`; publishing a release attaches the dmg; `tauri dev` smoke connects with a custom server address applied from the TopBar.*
  Scope note (2026-09): the server-address input moved from the TopBar into the Settings view (Server section); the TopBar is breadcrumb-only.

- [x] **T17 Chat / system status view (default home)**
  Conversational landing page (default view on launch). Free-text questions and quick-query chips ("system overview", "what is running now", "recent runs", "case health", "env overview") are answered by the server-side status chat: the LLM answers from a live system snapshot embedded in its system prompt (projects / cases by status / envs / recent runs), streamed as markdown deltas with live token metrics. Sessions are persisted server-side (SQLite): lazy session creation on first question, session switcher with delete in the header, multi-turn context (recent history joins the prompt). This pulls the minimal 1.1 status-agent forward (chat.ts + the `Chat` RPC and the chat-session RPCs in the contract) — the original 1.0 plan (client-side aggregation, no new contract) was superseded.
  *Verify: `tauri dev` launches into the Chat view; quick queries render live mock/real data; sessions survive tab switches and app restarts.*

## C. Real Server Topology

- [x] **T2 Docker compose topology**
  `docker/compose.yaml` with services: `hpath-server` (slim Node image for the spike; switches to the Playwright base + `--ipc=host` when T7b lands; artifact store `local`), `demo-app-dev`, `demo-app-staging`; optional `seaweedfs` service (single container: master+volume+S3 gateway) under the `s3` compose profile, started with `docker compose --profile s3 up`. Server Dockerfile.
  *Verify: `docker compose up -d` -> all healthy; demo apps serve pages; with `--profile s3` the S3 endpoint responds.*

- [x] **T4 demo-app (three-way aligned SUT)**
  Login + dashboard (balance card); HTTP `GET /api/balance`; gRPC `BalanceService.GetBalance` — all three serve the same seeded value; dev and staging instances use different seed data (so env switching is observable). Public image or source in `fixtures/demo-app/`.
  *Verify: manual curl + grpcurl + page check return the same number per env.*

## D. Server Core (replace mock internals behind the same contract)

- [x] **T5 SQLite data model + CRUD**
  Tables: projects, envs, cases (creator, status workflow draft/pending/approved/disabled, version+changelog, source_prd_ref), runs, events, artifacts, prds. Migrations; repository layer.
  *Verify: repository unit tests; foreign-key namespace checks (project/env/run).*

- [x] **T3 Seed data (SQLite-backed)**
  On first server start (non-mock): demo project (with metadata repo_url), envs `dev` + `staging`, 5 example cases (4 approved + 1 pending agent draft), 2 finished sample runs (1 passed + 1 failed), 3 sample PRDs (md/docx/pdf) bundled under `fixtures/prds/`.
  *Verify: fresh boot -> ListProjects/ListEnvs/ListCases return seed data from SQLite.*

- [x] **T6 Artifact storage client (local first, S3 optional)**
  One `ArtifactStore` interface, two backends selected by `HPATH_ARTIFACT_STORE`: `local` (default; filesystem under `HPATH_ARTIFACT_DIR`) and `s3` (aws-sdk-js against SeaweedFS). putObject/getObject streaming, artifact index bookkeeping, shared key scheme `artifacts/{project}/{env}/{run}/...`.
  *Verify: round-trip upload/download integration test for the `local` backend (covered by artifact-store.test.ts and exercised end to end by T8 acceptance); `s3` backend round-trip against the compose `s3` profile SeaweedFS still pending a live check.*

- [x] **T7a Agent kernel**
  AgentRegistry + AgentDefinition interface; ToolProviderRegistry; shared run pipeline: fresh session per run, env-bound injection, event recording (pi hooks), hard limits (maxSteps/tokenBudget/timeoutMs with evidence preserved), structured verdict channel.
  *Verify: a stub AgentDefinition runs through the pipeline end to end in tests.*

- [x] **T7b execute-agent + built-in ToolProviders**
  browser (navigate/click/fill/read_page/screenshot/wait via Playwright), http (http_request), grpc (grpc_call), evidence (record_evidence/finish_verdict). Verdict schema validates three-way alignment entries.
  *Verify: agent executes seed case against demo-app dev; verdict pass with all three sides evidenced.*

- [x] **T8 Run event streaming + evidence recording (real)**
  RunCase server-streaming backed by the real pipeline; per-run: video.webm, trace.zip, per-step screenshots, request records -> the artifact store (local by default); events + artifact index -> SQLite; limit breaches -> failed with evidence retained.
  *Verify: RunCase over gRPC yields ordered events; run artifacts complete in the artifact store; failed-on-limit run keeps evidence.*

- [x] **T9 analyze-agent**
  PRD ingest (md direct, docx via mammoth, pdf via pdf-parse) -> case drafts (status pending) with creator `{type:agent}`, source_prd_ref; drafts appear in ListCases pending review.
  *Verify: all three PRD formats produce schema-valid pending drafts.*
  Scope note: landed in two passes. The analyze-agent kernel side (definition + prd-analysis provider + ingest, covered by tests) and real-mode `ReviewCase` wiring landed first (2026-09-07); real-mode `ParsePRD` gRPC wiring completed the task (2026-09-08): the handler (grpc/prd-analysis.ts) validates (project/empty content/20 MB cap/format inference), stores the raw PRD bytes in the artifact store under `artifacts/{project}/-/prd/{uuid}-{name}` (content_ref, best-effort; not in the run-scoped artifacts index), runs the registered analyze-agent through the shared kernel with a synthetic env binding, maps kernel events to ParseEvents (thinking/progress, mock-parity cadence), persists the verdict's stamped drafts only on PASSED, and closes a FAILED run (hard-limit breach included) with a structured error — failure drafts stay in the stream as evidence but never reach the cases table. Model-compat hardening found by live smoke (ekreke gateway, step-3.7-flash): write_case_draft coerces JSON-stringified `alignments` / whole-argument strings before the strict schema check (same quirk class as the T8 finish_verdict unwrap), and finish_verdict completes an analyze-style verdict's missing `drafts` field from the run's recorded stamped-draft evidence plus a shape-neutral error hint. Verify smoke: ParsePRD over gRPC on `--real` produced 3 schema-valid pending drafts from fixtures/prds/payment.md; approve through ReviewCase bumped version + changelog; raw bytes round-trip from the artifact store; the desktop PRD view (all five ParseEvent branches incl. error) needed no changes.

- [x] **T19 Manual case management (CreateCase / UpdateCase / DeleteCase)**
  Contract extension (same pattern as the UpdateProject/DeleteProject additions): `CreateCase` lands a human-created case in PENDING (creator `{type:human}`, empty `source_prd_ref`, version 1 + changelog), `UpdateCase` replaces title/goal/alignments of unapproved cases only (APPROVED must be disabled first; version bump + changelog, creator/source_prd_ref preserved — so agent drafts can be hand-corrected before approval), `DeleteCase` refuses cases referenced by runs (ALREADY_EXISTS), mirroring DeleteEnv. Implemented in mock + real handlers, `CaseRepository.update`, desktop Rust commands + `CaseFormModal` (list-header New button; detail-page Edit/Delete actions), i18n en/zh.
  *Verify: `make test` unit suite + smoke cover create/update/delete and all guards; manual flow: create case -> visible PENDING in list -> edit -> approve -> run -> delete blocked by run history.*

- [x] **T20 Run state machine: PauseRun / ResumeRun / CancelRun + minute-unit timeout override**
  Full run lifecycle: `RunStatus.PAUSED = 6` added to the contract with an enforced state machine (PENDING -> RUNNING ⇄ PAUSED -> PASSED/FAILED/CANCELLED); new unary RPCs `PauseRun` / `ResumeRun` / `CancelRun` (returns the refreshed Run; unknown id NOT_FOUND, not-active or invalid transition FAILED_PRECONDITION) wired in mock (in-flight controller registry in the scripted run) and real mode (`AgentKernel.runControl` registry; pause parks the pi loop at a turn boundary via an awaited listener gate — browser session/transcript stay alive; the wall-clock timer stops while paused and suspended time is excluded from `durationMs`; cancel aborts agent + run signal and settles CANCELLED with evidence retained; a `limit:` breach always wins). Run rows now persist PENDING first and follow in-flight RUNNING/PAUSED transitions via `RunRepository.updateStatus`. Desktop: `control_run` Tauri command, RunPanel live status follows stream run_status events with Pause/Resume/Stop buttons and a pause-aware elapsed clock, CANCELLED treated as finished everywhere, PAUSED tag variant + i18n.
   Timeout override re-unit: contract field `AgentLimits.timeout_ms` -> `timeout_min` (minutes, UI-capped 1440), SQLite migration `0006_env_timeout_minutes` renames the column and converts legacy ms values with ceil (never shortens a budget), converted to kernel-internal ms once at the env boundary (`buildEnvBinding`); failure reason `limit:timeout_ms` -> `limit:timeout`.
   *Verify: `make test` covers pause/resume/cancel at the kernel, handler and mock levels plus migration conversion; grpcurl smoke against `--mock`: PauseRun freezes the event stream, ResumeRun completes PASSED, CancelRun settles CANCELLED with fail_reason `cancelled`, control on settled/unknown runs -> FAILED_PRECONDITION / NOT_FOUND.*

- [x] **T21 Live browser view (WatchRun CDP screencast)**
  Contract extension: ephemeral `RunFrame` message + `rpc WatchRun(WatchRunRequest) returns (stream RunFrame)` — live browser frames for an in-flight run, streamed but never persisted as run evidence (events table / replay stay frame-free); the stream ends when the run settles. Server: per-run `RunFrameHub` (latest-wins backpressure, min-interval throttle, registry keyed by runId) closed on settle; optional `ToolContext.frames` injection; the browser provider drives CDP `Page.startScreencast` (jpeg q60, 800x600, ack-based flow control) into the hub on page init and stops it in `close()` (abort/cleanup paths reused); WatchRun handler: unknown run NOT_FOUND, settled/no-hub run ends the stream empty, mid-run subscribe supported, multiple observers allowed. Mock parity: synthetic jpeg frames on the scripted cadence until terminal status. Desktop: `watch_run` Tauri command forwarding frames over a Channel (`RunFrameDto`); RunPanel live-mode LiveView pane (latest-frame `<img>`, placeholder until first frame, auto-ends on terminal status).
  *Verify: `make test` covers hub broadcast/latest-wins/close, mid-run WatchRun subscribe + settle-ended stream, unknown-run NOT_FOUND, and mock frame parity; manual: `make mock` + `tauri dev` shows live frames during a scripted run and freezes on PauseRun; `make real` against demo-app shows the live page.*
  Scope note (2026-09): implemented end to end. Green: `make test` (268 tests / 263 pass / 5 skipped s3 baseline) — frames hub suite (broadcast in seq order, latest-wins skip, throttle trailing flush, close buffering + waiter wakeup, unsubscribe, onSubscribe, late subscriber, registry replace closes the old hub) and watchRun integration (real mid-run subscribe with settle-ended stream, no-hub empty stream, unknown-run NOT_FOUND; mock frame parity until terminal status) plus `cargo check` on the desktop `watch_run` command / `RunFrameDto`. Live grpcurl smoke against `--mock`: subscribed WatchRun mid-run (7 frames), PauseRun froze delivery across a 2.5s window (still 7), ResumeRun resumed (8), the stream closed when the run settled PASSED, unknown run id -> NotFound. Pending manual: the `tauri dev` LiveView walk (thin latest-frame `<img>` over the same verified channel; real-mode CDP frames need demo-app + a run).
- [~] **T22 Project asset library + proto API surface for agents**
  The Materials view (PrdView) becomes a typed asset library. Upload opens a modal form with an asset-type selector: PRD (streams the existing ParsePRD flow unchanged from the client's perspective) or PROTO (one upload = a self-contained bundle of one or more `.proto` files with `entry_filename` — server infers the entry file from "not imported by any other file" when omitted and rejects ambiguous bundles). Proto bundles are parsed server-side (protobufjs, imports resolved against the uploaded file set by name, comments kept) into: a markdown `api_doc` (services / methods / request-response message fields) and a structured `methods_json` method list. Contract extension (same pattern as T19/T20): `AssetType` enum, `Asset`/`AssetFile` messages, unary `UploadAsset` (repeated files), `ListAssets(project_id)`, `GetAsset` (carries `api_doc`), `DeleteAsset` (best-effort artifact purge, mirroring DeleteProject). Server: migration `0007_assets` replaces the write-only `prds` table (rows migrated, type=prd) with an `assets` table + AssetRepository; raw bytes stored in the artifact store under `artifacts/{project}/-/asset/{assetId}/{filename}`. Agent wiring: the project's method list renders a compact API-surface summary into the execute-agent system prompt (new `{{apiSurface}}` placeholder, ~4k char cap with truncation notice); a new `api-docs` ToolProvider (`list_apis` / `describe_api` tools) built per-run from the project's parsed surface; `grpc_call` is hard-validated — service/method not in the project surface is rejected with a structured error (usable methods listed) before any network I/O, when the project has a proto asset; the project's proto files are materialized to a per-run temp dir and joined into the grpc provider's proto paths (`HPATH_GRPC_PROTOS` stays as a server-level supplement; a project with no proto asset keeps current behavior). HTTP requests stay origin-fenced with the api doc as soft guidance only. Mock parity for all four RPCs; seed demo project ships a `balance.proto` asset.
  *Verify: `make test` covers multi-file import parsing (success / missing import / ambiguous entry), prds->assets migration, handler guards, and grpc_call rejection of an undefined method (asserting no network call); grpcurl smoke on all four new RPCs (mock + real); manual: upload balance.proto -> api_doc preview -> real-mode run shows the API surface in the prompt and describe_api works; `tauri dev` covers the upload modal, asset list, preview and delete flows.*
  Scope note (2026-09): implemented end to end. Green: server unit suite (22 new T22 tests: parser incl. base-name import matching + caps + duplicate detection, migration upgrade path, grpc_call allowlist rejection with no network I/O, real + mock handler round-trips, and RunCase injection of apiSurface/projectApi into the kernel run with protoDir cleanup), mock smoke extended with the asset section (upload/get/delete + PRD rejection), and an isolated real-mode smoke (seeded balance.proto with parsed api_doc, multi-file import upload, delete purge) against a fresh `--real` instance. Pending manual checks: a live real-mode RunCase (prompt surface + describe_api with an LLM key) and the `tauri dev` UI walk (upload modal / list / preview / delete — `cargo check` + `vite build` pass, commands registered).

- [x] **T23 Browser pool (settings-configurable warm chromium pool)**
  Contract extension: `AppSettings.browser_pool_size` (uint32; 0 = pool disabled, server-capped at 4 via `MAX_BROWSER_POOL`, default 1) + `make proto`. Server: new `BrowserPool` (agents/providers/browser-pool.ts) prewarms idle chromium processes; `BrowserSession` acquires from the pool (falls back to a fresh launch when the pool is empty/disabled or the pooled instance died — checked via isConnected) and releases the browser back after context close instead of killing it; every run still creates its own fresh BrowserContext (video/trace/screencast semantics unchanged) so per-run isolation holds at the context level; `resize()` is driven by UpdateSettings without a restart; server shutdown closes every pooled instance. Settings: `SettingsDoc.browserPool` validated as an integer in [0..4], seeded to 1, persisted in settings.json. Desktop: Settings → Models gains a numeric input (0–4) with an i18n hint on per-instance memory (~0.6–1 GB headless chromium; less in the playwright docker image); Rust `SettingsDto` + TS `AppSettings` type extended; mock parity (in-memory default 1). Concurrency beyond the pool size launches ephemeral browsers (current behavior) — no queuing.
  *Verify: `make test` covers pool prewarm/acquire/release/resize, dead-instance eviction, disabled-pool passthrough, settings bounds (reject >4 / non-integer) and the t7b provider launch stubs; manual: `--real` runs two cases back to back — the second shows no chromium launch delay; changing the pool size in Settings applies without a restart; pool=0 restores launch-per-run.*
  Scope note (2026-09): landed in one pass. Server: browser-pool.ts (prewarm/acquire/release/resize/close + lazy dead-instance eviction), BrowserSession pool borrow/return (context creation failure on a borrowed browser goes back through release; no pool wired = unchanged launch-per-run for tests), settings validation/seed/normalize, UpdateSettings-driven resize, boot prewarm + shutdown drain. Desktop: Settings numeric input (clamped 0-4 server- and client-side, error snaps back), i18n en/zh, Rust DTO + TS type. Gates: `make test` green (268 tests: 8 pool units, 5 new settings bounds, 2 t7b pool integration — reuse + no-pool regression; 263 pass / 5 skipped baseline) plus live `--real` smoke (boot prewarm 1 instance, resize 1→2→0 via UpdateSettings with process counts verified, >4 rejected with INVALID_ARGUMENT, pool=0 passthrough). Pending: the back-to-back RunCase pair against demo-app (needs an LLM key; the pool path itself is covered by the t7b integration test that asserts a second run reuses the same chromium launch).

## E. Wrap-up

- [x] **T15 E2E demo script + README**
  `make demo`: builds & starts the compose stack (mock server + demo-app dev/staging), waits for gRPC health, then runs `packages/server/scripts/demo.ts` — a guided, deterministic walk of the full user story: connect (seed project/envs) -> ParsePRD (`fixtures/prds/payment.md`, pending agent draft) -> ReviewCase approve (version bump + changelog) -> RunCase on dev (PASSED) and on staging -> the drift case failing with a mismatch-verdict and `match=false` alignment evidence -> runtime control of a live run (PauseRun freezes the event stream, ResumeRun completes PASSED, CancelRun settles CANCELLED, settled runs reject control with FAILED_PRECONDITION) -> GetRun replay (transcript matches the stream, artifacts >= 4, video bytes stream intact) -> ListRuns history with env and status filters. Shared gRPC client helpers extracted to `scripts/client.ts` (smoke + demo). Root `README.md` (English): pitch, repo layout, quickstart (guided demo / desktop / local mock / real mode), docs pointers, env-var table (`OPENAI_API_KEY`, `HPATH_*`, S3/SeaweedFS). Also fixed the pre-existing smoke failure (`updateCase` sent empty alignments — rejected by the T19 `assertAlignments` guard), restoring `make test`/`make verify` to green.
  *Verify: script runs green on a clean checkout: `make install && make demo` (compose builds from source, no local build or model key required; verified end to end — all 9 steps assert exact mock-mode expectations).*
  Scope note: the demo runs against the compose stack's mock-mode server on purpose — deterministic and key-less; a real-mode walkthrough (live LLM) stays a manual exercise documented in the README quickstart.

- [~] **T18 Desktop dogfooding — the platform tests its own client**
  Prove the SUT model generalizes beyond web apps by pointing the execute-agent at HPath's own desktop client (Tauri 2, macOS). Three observation layers: UI logic via the existing browser provider against the vite dev URL (same code + same server, equivalent rendering); shell state (connectionStatus, selected project/env, active view) via a debug-only HTTP bridge inside the desktop app (`#[cfg(debug_assertions)]` for the server, loopback-only, read-only surface: GET /health, /state, /screenshot; the webview pushes its state through a dev-guarded `debug_push_state` command; the ephemeral port is published to `<tmpdir>/hpath-debug-bridge.json`); true-window visual evidence via macOS window screenshots (CGWindowList window-id + `screencapture`, one-time Screen Recording permission) recorded through the kernel screenshot event by a minimal env-driven `desktop` ToolProvider (`shell_state` + `capture_window`, materializes no tools unless the bridge is discoverable — the SPEC's original "no new ToolProvider" claim was amended to this one read-only provider so the bytes land in the artifact store). The http provider additionally accepts env-driven allowed origins (`hpath_allowed_origins`). One seeded dogfood project ("HPath Desktop (dogfood)": env `local` → vite dev URL + the local gRPC server, one approved case, and the repo's own `hpath.proto` as the project's proto asset — ListProjects is prompt-injected and grpc_call hard-validated against it; the run path learns to materialize seeded repo-relative proto refs from the checkout when the artifact store has no object).
  *Verify: `make test` covers the desktop provider (no-bridge no-tools, bridge_url/port-file resolution, shell_state read, capture_window → kernel screenshot event, bridge errors as tool errors) and the env-origins fence; `cargo check` green for debug AND release (the bridge compiles out of release); debug bridge absent in release builds; the dogfood case ends PASSED with all three sides evidenced; killing and restarting the server flips the bridge-reported connection status offline -> connected.*
  Scope note (2026-09): server + desktop implemented and green (`make test` 271 pass incl. 8 new T18 tests; `cargo check` debug+release; `vite build`; `pnpm -r build`). Seed carries the dogfood project only into fresh databases (existing DBs: use a fresh `HPATH_DB_PATH`). Pending manual checks (one dev session): run the dogfood case end to end (`make real` + `tauri dev`, LLM key required, grant Screen Recording once) and the offline -> connected flip; those are documented in TODO.md.

---

## Out of Scope (1.0) — tracked in milestones.md 1.1

MCP facade, external MCP/skills ToolProviders, extra agents via registry, container-per-run, credential injection via env vars, scheduled runs, SUT source-aware agents.

**status-agent (minimal version landed early with T17):** the server-side chat (`Chat(ChatRequest) returns (stream ChatResponse)` + chat-session RPCs) answers natural-language questions about system state from a live snapshot in the system prompt, with sessions persisted in SQLite. What remains for 1.1: registered `AgentDefinition` form with `read_*` tools instead of the static snapshot, richer query coverage (e.g. per-run drill-down), and cost/context tuning.

## Verification Matrix (per testing-stage)

| Task type | Verification |
|-----------|--------------|
| Docs (Phase 0) | Read-through, terminology consistency with this SPEC |
| Contract/mock (T1) | pnpm build, grpcurl reflection, mock endpoint probes |
| Desktop (T10-T14, T17, T21, T23) | `tauri dev` smoke against mock + manual checklist per view |
| Infra (T2, T4) | compose health checks, port probes, curl/grpcurl checks |
| Server code (T5-T9, T19-T23) | pnpm build + unit/integration tests listed per task |
| E2E (T15) | demo script green run |
