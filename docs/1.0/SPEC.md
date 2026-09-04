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

Iteration order: **T1 -> T10 -> T16 -> T11 -> T17 -> T12 -> T13 -> T14 -> T2 -> T4 -> T5 -> T6 -> T7a -> T7b -> T8 -> T9 -> T3 -> T15.**

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

## B. Desktop First (built and verified against mock)

- [x] **T10 Desktop skeleton**
  Tauri 2 project (src-tauri Rust tonic client + IPC commands; React shell); project/env switchers wired; connection status.
  *Verify: `tauri dev` on macOS lists mock project/envs via Rust gRPC.*

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
  Tauri bundler enabled (macOS `.app` + `.dmg`, unsigned); `make dist` builds the bundle locally. GitHub Actions workflow (`.github/workflows/release.yml`) builds the macOS dmg on release publish and attaches it to the release assets (workflow_dispatch runs the same build as a dry run). Server address is runtime-configurable: a `set_server_addr` IPC command validates and holds the address Rust-side (AppState); the TopBar input + Apply persists it client-side (localStorage) and no command hardcodes it.
  *Verify: `make dist` produces `.app`/`.dmg` under `src-tauri/target/release/bundle/`; publishing a release attaches the dmg; `tauri dev` smoke connects with a custom server address applied from the TopBar.*

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

- [ ] **T9 analyze-agent**
  PRD ingest (md direct, docx via mammoth, pdf via pdf-parse) -> case drafts (status pending) with creator `{type:agent}`, source_prd_ref; drafts appear in ListCases pending review.
  *Verify: all three PRD formats produce schema-valid pending drafts.*
  Scope note: the analyze-agent kernel side (definition + prd-analysis provider + ingest, covered by tests) is done; what remains is the real-mode `ParsePRD` gRPC wiring. Also in this iteration's scope: real-mode `ReviewCase` wiring (the review workflow currently works in mock only).

## E. Wrap-up

- [ ] **T15 E2E demo script + README**
  Script: compose up -> parse sample PRD -> review draft -> run case on dev vs staging -> replay run -> browse history. README (English): quickstart, architecture pointer to docs/, env vars (`OPENAI_API_KEY`).
  *Verify: script runs green on a clean checkout.*

---

## Out of Scope (1.0) — tracked in milestones.md 1.1

MCP facade, external MCP/skills ToolProviders, extra agents via registry, container-per-run, credential injection via env vars, scheduled runs, SUT source-aware agents.

**status-agent (minimal version landed early with T17):** the server-side chat (`Chat(ChatRequest) returns (stream ChatResponse)` + chat-session RPCs) answers natural-language questions about system state from a live snapshot in the system prompt, with sessions persisted in SQLite. What remains for 1.1: registered `AgentDefinition` form with `read_*` tools instead of the static snapshot, richer query coverage (e.g. per-run drill-down), and cost/context tuning.

## Verification Matrix (per testing-stage)

| Task type | Verification |
|-----------|--------------|
| Docs (Phase 0) | Read-through, terminology consistency with this SPEC |
| Contract/mock (T1) | pnpm build, grpcurl reflection, mock endpoint probes |
| Desktop (T10-T14, T17) | `tauri dev` smoke against mock + manual checklist per view |
| Infra (T2, T4) | compose health checks, port probes, curl/grpcurl checks |
| Server code (T5-T9) | pnpm build + unit/integration tests listed per task |
| E2E (T15) | demo script green run |
