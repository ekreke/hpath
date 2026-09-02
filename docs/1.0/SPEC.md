# SPEC 1.0 — End-to-End Spike

Active version: **1.0** (see `milestones.md`). This file is the single source of truth for scope and progress. One checkbox = one dev-workflow iteration (progress-tracker -> implement -> testing-stage -> checkpoint).

Status legend: `[ ]` todo, `[x]` done, `[~]` in progress.

## Architecture Invariants (protected every iteration)

- Desktop (Tauri) is display + triggers only; server owns orchestration, persistence, scheduling.
- Every run is isolated: fresh agent session, own Playwright context, own `(project, env, run)` storage namespace.
- Agents are registered `AgentDefinition`s (AgentRegistry), never hardcoded branches; tools come from ToolProviders.
- All docs and code comments in English.

---

## A. Foundation

- [ ] **T1 Workspace skeleton + gRPC contract**
  pnpm workspace; `proto/hpath.proto` defining all 1.0 services (ListProjects, CreateProject, ListEnvs, UpsertEnv, DeleteEnv, ParsePRD, ListCases, GetCase, ReviewCase, RunCase, ListRuns, GetRun, DownloadArtifact); server skeleton serving echo impls; generated TS types.
  *Verify: `pnpm -r build` passes; grpcurl reflection lists services.*

- [ ] **T2 Docker compose topology**
  `docker/compose.yaml` with services: `hpath-server` (Playwright base image, `--ipc=host`), `seaweedfs` (single container: master+volume+S3 gateway), `demo-app-dev`, `demo-app-staging`. Server Dockerfile.
  *Verify: `docker compose up -d` -> all healthy; S3 responds; demo apps serve pages.*

- [ ] **T3 Seed data**
  On first server start: demo project (with metadata repo_url), envs `dev` + `staging`, 2 example cases (approved), 3 sample PRDs (md/docx/pdf) bundled under `fixtures/prds/`.
  *Verify: fresh boot -> ListProjects/ListEnvs/ListCases return seed data.*

## B. System Under Test (fixtures)

- [ ] **T4 demo-app (three-way aligned SUT)**
  Login + dashboard (balance card); HTTP `GET /api/balance`; gRPC `BalanceService.GetBalance` — all three serve the same seeded value; dev and staging instances use different seed data (so env switching is observable). Public image or source in `fixtures/demo-app/`.
  *Verify: manual curl + grpcurl + page check return the same number per env.*

## C. Server Core

- [ ] **T5 SQLite data model + CRUD**
  Tables: projects, envs, cases (creator, status workflow draft/pending/approved/disabled, version+changelog, source_prd_ref), runs, events, artifacts, prds. Migrations; repository layer.
  *Verify: repository unit tests; foreign-key namespace checks (project/env/run).*

- [ ] **T6 SeaweedFS artifact client**
  S3 API client (aws-sdk-js): putObject/getObject streaming, artifact index bookkeeping, key scheme `artifacts/{project}/{env}/{run}/...`.
  *Verify: round-trip upload/download in integration test.*

- [ ] **T7a Agent kernel**
  AgentRegistry + AgentDefinition interface; ToolProviderRegistry; shared run pipeline: fresh session per run, env-bound injection, event recording (pi hooks), hard limits (maxSteps/tokenBudget/timeoutMs with evidence preserved), structured verdict channel.
  *Verify: a stub AgentDefinition runs through the pipeline end to end in tests.*

- [ ] **T7b execute-agent + built-in ToolProviders**
  browser (navigate/click/fill/read_page/screenshot/wait via Playwright), http (http_request), grpc (grpc_call), evidence (record_evidence/finish_verdict). Verdict schema validates three-way alignment entries.
  *Verify: agent executes seed case T-001 against demo-app dev; verdict pass with all three sides evidenced.*

- [ ] **T8 Run event streaming + evidence recording**
  RunCase server-streaming; per-run: video.webm, trace.zip, per-step screenshots, request records -> SeaweedFS; events + artifact index -> SQLite; limit breaches -> failed with evidence retained.
  *Verify: RunCase over gRPC yields ordered events; run artifacts complete on disk (S3); failed-on-limit run keeps evidence.*

- [ ] **T9 analyze-agent**
  PRD ingest (md direct, docx via mammoth, pdf via pdf-parse) -> case drafts (status pending) with creator `{type:agent}`, source_prd_ref; drafts appear in ListCases pending review.
  *Verify: all three PRD formats produce schema-valid pending drafts.*

## D. Desktop (Tauri 2)

- [ ] **T10 Desktop skeleton**
  Tauri 2 project (src-tauri Rust tonic client + IPC commands; React shell); project/env switchers wired; connection status.
  *Verify: `tauri dev` on macOS lists seed project/envs via Rust gRPC.*

- [ ] **T11 Management views**
  PRD management (upload/trigger/trace), case list (creator/status/last-run columns), case detail (info + review actions approve/reject/disable, env strip, run history), env management (CRUD), run trigger (approved only).
  *Verify: review a pending draft from T9 -> approved -> appears runnable.*

- [ ] **T12 Live run panel**
  Streaming event feed (thinking/tool calls/screenshots/request records), hard-limit status bar, trigger from case detail.
  *Verify: run seed case from UI; panel renders events live; final verdict shown.*

- [ ] **T13 Run detail (replay)**
  Inline webm player + screenshot timeline + agent transcript; trace.zip download with one-click `playwright show-trace`; re-run button.
  *Verify: replay a completed run through all three layers.*

- [ ] **T14 History view**
  Run list filtered by project/env/case/status/date; per-case health strip (last N results).
  *Verify: runs from T12/T13 visible and filterable.*

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
| Infra (T2) | compose health checks, port probes |
| Server code (T5-T9) | pnpm build + unit/integration tests listed per task |
| Desktop (T10-T14) | `tauri dev` smoke + manual checklist per view |
| E2E (T15) | demo script green run |
