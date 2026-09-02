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

Iteration order: **T1 -> T10 -> T11 -> T12 -> T13 -> T14 -> T2 -> T4 -> T5 -> T6 -> T7a -> T7b -> T8 -> T9 -> T3 -> T15.**

---

## A. Contract & Mock Foundation

- [x] **T1 Workspace skeleton + gRPC contract + server skeleton with mock mode**
  pnpm workspace; `proto/hpath.proto` defining all 1.0 services (ListProjects, CreateProject, ListEnvs, UpsertEnv, DeleteEnv, ParsePRD, ListCases, GetCase, ReviewCase, RunCase, ListRuns, GetRun, DownloadArtifact); generated TS types; server skeleton serving echo impls plus `--mock` mode: in-memory seed data (1 demo project with metadata repo_url, envs `dev`+`staging`, 3 example cases: 2 approved + 1 pending agent draft, 2 finished sample runs: 1 passed + 1 failed), scripted RunCase event stream, synthetic artifacts (small generated video/screenshot/trace placeholders).
  *Verify: `pnpm -r build` passes; grpcurl reflection lists services; `--mock` server answers ListProjects/RunCase with seed data and a scripted event stream.*

## B. Desktop First (built and verified against mock)

- [ ] **T10 Desktop skeleton**
  Tauri 2 project (src-tauri Rust tonic client + IPC commands; React shell); project/env switchers wired; connection status.
  *Verify: `tauri dev` on macOS lists mock project/envs via Rust gRPC.*

- [ ] **T11 Management views**
  PRD management (upload/trigger/trace), case list (creator/status/last-run columns), case detail (info + review actions approve/reject/disable, env strip, run history), env management (CRUD), run trigger (approved only).
  *Verify: review a pending mock draft -> approved -> appears runnable; env CRUD works against mock.*

- [ ] **T12 Live run panel**
  Streaming event feed (thinking/tool calls/screenshots/request records), hard-limit status bar, trigger from case detail.
  *Verify: trigger mock run from UI; panel renders scripted events live; final verdict shown.*

- [ ] **T13 Run detail (replay)**
  Inline webm player + screenshot timeline + agent transcript; trace.zip download with one-click `playwright show-trace`; re-run button.
  *Verify: replay the mock finished run through all three layers (synthetic artifacts).*

- [ ] **T14 History view**
  Run list filtered by project/env/case/status/date; per-case health strip (last N results).
  *Verify: mock runs visible and filterable.*

## C. Real Server Topology

- [ ] **T2 Docker compose topology**
  `docker/compose.yaml` with services: `hpath-server` (Playwright base image, `--ipc=host`), `seaweedfs` (single container: master+volume+S3 gateway), `demo-app-dev`, `demo-app-staging`. Server Dockerfile.
  *Verify: `docker compose up -d` -> all healthy; S3 responds; demo apps serve pages.*

- [ ] **T4 demo-app (three-way aligned SUT)**
  Login + dashboard (balance card); HTTP `GET /api/balance`; gRPC `BalanceService.GetBalance` — all three serve the same seeded value; dev and staging instances use different seed data (so env switching is observable). Public image or source in `fixtures/demo-app/`.
  *Verify: manual curl + grpcurl + page check return the same number per env.*

## D. Server Core (replace mock internals behind the same contract)

- [ ] **T5 SQLite data model + CRUD**
  Tables: projects, envs, cases (creator, status workflow draft/pending/approved/disabled, version+changelog, source_prd_ref), runs, events, artifacts, prds. Migrations; repository layer.
  *Verify: repository unit tests; foreign-key namespace checks (project/env/run).*

- [ ] **T3 Seed data (SQLite-backed)**
  On first server start (non-mock): demo project (with metadata repo_url), envs `dev` + `staging`, 3 example cases (2 approved + 1 pending agent draft), 2 finished sample runs (1 passed + 1 failed), 3 sample PRDs (md/docx/pdf) bundled under `fixtures/prds/`.
  *Verify: fresh boot -> ListProjects/ListEnvs/ListCases return seed data from SQLite.*

- [ ] **T6 SeaweedFS artifact client**
  S3 API client (aws-sdk-js): putObject/getObject streaming, artifact index bookkeeping, key scheme `artifacts/{project}/{env}/{run}/...`.
  *Verify: round-trip upload/download in integration test.*

- [ ] **T7a Agent kernel**
  AgentRegistry + AgentDefinition interface; ToolProviderRegistry; shared run pipeline: fresh session per run, env-bound injection, event recording (pi hooks), hard limits (maxSteps/tokenBudget/timeoutMs with evidence preserved), structured verdict channel.
  *Verify: a stub AgentDefinition runs through the pipeline end to end in tests.*

- [ ] **T7b execute-agent + built-in ToolProviders**
  browser (navigate/click/fill/read_page/screenshot/wait via Playwright), http (http_request), grpc (grpc_call), evidence (record_evidence/finish_verdict). Verdict schema validates three-way alignment entries.
  *Verify: agent executes seed case against demo-app dev; verdict pass with all three sides evidenced.*

- [ ] **T8 Run event streaming + evidence recording (real)**
  RunCase server-streaming backed by the real pipeline; per-run: video.webm, trace.zip, per-step screenshots, request records -> SeaweedFS; events + artifact index -> SQLite; limit breaches -> failed with evidence retained.
  *Verify: RunCase over gRPC yields ordered events; run artifacts complete in SeaweedFS; failed-on-limit run keeps evidence.*

- [ ] **T9 analyze-agent**
  PRD ingest (md direct, docx via mammoth, pdf via pdf-parse) -> case drafts (status pending) with creator `{type:agent}`, source_prd_ref; drafts appear in ListCases pending review.
  *Verify: all three PRD formats produce schema-valid pending drafts.*

## E. Wrap-up

- [ ] **T15 E2E demo script + README**
  Script: compose up -> parse sample PRD -> review draft -> run case on dev vs staging -> replay run -> browse history. README (English): quickstart, architecture pointer to docs/, env vars (`OPENAI_API_KEY`).
  *Verify: script runs green on a clean checkout.*

---

## Out of Scope (1.0) — tracked in milestones.md 1.1

MCP facade, external MCP/skills ToolProviders, extra agents via registry, container-per-run, credential injection via env vars, scheduled runs, SUT source-aware agents.

## Verification Matrix (per testing-stage)

| Task type | Verification |
|-----------|--------------|
| Docs (Phase 0) | Read-through, terminology consistency with this SPEC |
| Contract/mock (T1) | pnpm build, grpcurl reflection, mock endpoint probes |
| Desktop (T10-T14) | `tauri dev` smoke against mock + manual checklist per view |
| Infra (T2, T4) | compose health checks, port probes, curl/grpcurl checks |
| Server code (T5-T9) | pnpm build + unit/integration tests listed per task |
| E2E (T15) | demo script green run |
