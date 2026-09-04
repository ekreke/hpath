# Agents.md — Orientation for AI Coding Agents

This file orients AI coding agents (and new contributors) working in the **HPath** repository. It is a rolling summary of what the project is, how the code is organized, and the rules that must hold across every change. Authoritative detail lives in `docs/` (see pointers below); this file tells you where to look and what not to break.

> Repo convention: all docs and code comments are written in **English**. Keep this file in English to match.

## What HPath is

HPath is an AI-driven testing platform. It replaces manual click-through test verification with autonomous agents that verify **three-way alignment** for each case:

```
PRD logic (expectation)  <->  frontend display (actual UI)  <->  backend output (actual API/gRPC response)
```

Two built-in agents do the work:

- **analyze-agent** — ingests a PRD (md / docx / pdf) and drafts structured `Case` definitions (status `pending`, awaiting human approval).
- **execute-agent** — autonomously runs an approved case against an env, driving a headless browser + real HTTP/gRPC, and emits a structured verdict with evidence for all three sides.

Humans shift from *executing* cases to *reviewing* run evidence (video, screenshots, agent transcript, Playwright trace).

## Repository layout

pnpm monorepo (`packages/*`), Node >= 22.19.0, TypeScript throughout.

```
hpath/
├── proto/hpath/v1/hpath.proto   # gRPC contract — single source of truth for the API
├── packages/
│   ├── contract/                # @hpath/contract — generated TS + descriptor set shared by both sides
│   ├── desktop/                 # @hpath/desktop — Tauri 2 macOS app (React UI + Rust tonic gRPC client)
│   └── server/                  # @hpath/server — gRPC API, agent kernel, persistence, artifact store
├── docs/
│   ├── README.md                # doc index + dev-workflow process
│   ├── overview/                # version-stable architecture docs (read these first)
│   │   ├── product-overview.md  # problem, core model, concepts, architecture, storage ownership
│   │   ├── agent-design.md      # AgentRegistry / ToolProviders / isolation / hard limits / evidence
│   │   └── dashboard.md         # desktop client views + Tauri IPC ↔ gRPC mapping
│   └── 1.0/
│       ├── SPEC.md              # SOURCE OF TRUTH for 1.0 scope + progress (checkboxes = iterations)
│       └── TODO.md              # current-iteration working notes
├── docker/compose.yaml          # full stack: server + demo-app(dev/staging) + optional SeaweedFS(s3 profile)
├── fixtures/demo-app/           # three-way aligned system-under-test (SUT)
├── data/                        # local artifact store + SQLite (default; see ArtifactStore below)
├── scripts/                     # gen-proto.sh and helpers
├── Makefile                     # developer workflow targets (install/proto/build/mock/real/test/up/...)
└── milestones.md                # version plan (what's in 1.0 vs 1.1)
```

## gRPC contract (the spine of the system)

Defined in `proto/hpath/v1/hpath.proto` (`service Hpath`). Key RPCs:

- Projects/Envs: `ListProjects`, `CreateProject`, `ListEnvs`, `UpsertEnv`, `DeleteEnv`
- PRDs: `ParsePRD` (server-streaming `ParseEvent`)
- Cases: `ListCases`, `GetCase`, `ReviewCase`
- Runs: `RunCase` (server-streaming `Event`), `ListRuns`, `GetRun`
- Artifacts: `DownloadArtifact` (server-streaming `BytesChunk`)
- Settings/Chat: `GetSettings`/`UpdateSettings`, `Chat`, `CreateChatSession`, `ListChatSessions`, `ListChatMessages`, `DeleteChatSession`

The contract was finalized once up front (T1). The desktop and server share generated types from `@hpath/contract`. **Do not change behavior the client depends on without touching the contract deliberately** — mock and real modes implement the *identical* contract so the desktop never reworks.

## Architecture invariants (protected every iteration)

These must hold across all changes — they are the most common way to break the build:

1. **Layer split.** Desktop = display + triggers only (no execution orchestration). Server = API, orchestration, persistence, scheduling, agent lifecycle. Desktop reads everything through gRPC; it never touches SQLite/FS directly (binary artifacts stream through Rust to a temp cache).
2. **Per-run isolation.** Every run = a fresh agent session + its own Playwright context + its own `(project, env, run)` storage namespace. No cross-run / cross-env memory.
3. **Registered agents, not hardcoded branches.** Agents are `AgentDefinition`s in an `AgentRegistry`; tools come from `ToolProviderRegistry`s. Adding an agent = registering a definition; shared orchestration (triggering, event streaming, evidence recording, hard limits) is unchanged.
4. **English docs & comments.**
5. **Mock-first / client-first.** The server skeleton ships `--mock` (in-memory seed + scripted event streams + synthetic artifacts). Desktop tasks are built and verified against mock; later tasks replace mock internals behind the same contract.

## Agent runtime (server)

Built on the **pi agent framework**: `@earendil-works/pi-agent-core` (runtime, tool calling, hooks) + `@earendil-works/pi-ai` (multi-provider LLM; OpenAI configured in 1.0, key from `OPENAI_API_KEY`). See `docs/overview/agent-design.md`.

- **Registries:** `AgentRegistry` (agent-level) and `ToolProviderRegistry` (tool-level). 1.0 built-in agents: `analyze-agent`, `execute-agent`. 1.0 built-in tool providers: `browser` (Playwright), `http`, `grpc`, `evidence` (kernel: `record_evidence`, `finish_verdict`).
- **Hard limits** per `AgentDefinition`: `maxSteps`, `tokenBudget`, `timeoutMs`. On breach → run status `failed`, reason `limit:<kind>`, evidence retained.
- **Evidence pipeline:** every run streams events (thinking / tool_call / screenshot / request-response / verdict / error) to SQLite (`events` table) and to clients over gRPC server-streaming; binaries go to the artifact store.

## Build, run, test

Use the Makefile / pnpm. Common targets:

- `make install` — install workspace deps (`pnpm install`).
- `make proto` — regenerate TS types + descriptor from `proto/` (`./scripts/gen-proto.sh`). Run after editing `.proto`.
- `make build` / `pnpm build` — build all packages (`pnpm -r build`).
- `make mock` — start the mock server in background (log `/tmp/hpath-server.log`), waits until healthy.
- `pnpm --filter @hpath/server dev` — dev server in mock mode (`tsx watch --mock`).
- `make test` / `pnpm --filter @hpath/server test` — run server tests.
- `make real` — start real-mode server (SQLite reads from T3; most RPCs still UNIMPLEMENTED until T8).
- `make up [PROFILE=s3]` — `docker compose up` the full stack (server + demo-app dev/staging; `s3` adds SeaweedFS).
- `make dist` — build the macOS desktop `.app`/`.dmg` (`packages/desktop/src-tauri/target/release/bundle`).
- `make verify` — combined gates (build + test).
- `make cloc` — count lines.

Artifact storage is selected by `HPATH_ARTIFACT_STORE`: `local` (default; `data/artifacts`, keyed `artifacts/{project}/{env}/{run}/...`) or `seaweedfs` (S3 API against SeaweedFS, compose `s3` profile).

## Dev workflow

One sub-task per iteration, from `docs/1.0/SPEC.md` (the single source of truth, with progress checkboxes):

1. **progress-tracker** — pick the next incomplete checkbox; validate actual repo state.
2. **implement** — implement against SPEC + overview docs.
3. **testing-stage** — verify per the verification matrix in SPEC.
4. **checkpoint** — tick the checkbox, update notes.

When editing, prefer the same isolation/registry discipline the codebase already enforces, and keep all prose in English.

## Where to look for things

- "What is this project / why?" → `docs/overview/product-overview.md`
- "How do agents/tools/limits/evidence work?" → `docs/overview/agent-design.md`
- "Desktop views & IPC↔gRPC mapping" → `docs/overview/dashboard.md`
- "Exact API shape" → `proto/hpath/v1/hpath.proto`
- "What's done / what's next" → `docs/1.0/SPEC.md` (checkboxes) + `milestones.md`
- "Shared generated types" → `packages/contract/src/gen`
- "Server internals" → `packages/server/src` (`grpc/`, `agents/`, `agents/providers/`, `db/`, `artifacts/`, `mock/`)
- "Desktop UI" → `packages/desktop/src` (`views/`, `components/`, `lib/`)
