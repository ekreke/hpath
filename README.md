# HPath

HPath is an AI-driven testing platform. It replaces manual click-through verification of test cases with autonomous agents that verify **three-way alignment** for every case:

```
PRD logic (expectation)  <->  frontend display (actual UI)  <->  backend output (actual API/gRPC response)
```

Two built-in agents do the work:

- **analyze-agent** — ingests a PRD (md / docx / pdf) and drafts structured test cases (status `pending`, awaiting human approval).
- **execute-agent** — autonomously runs an approved case against an environment, driving a headless browser plus real HTTP/gRPC, and emits a structured verdict with evidence for all three sides (video, trace, screenshots, request records).

Humans shift from *executing* test cases to *reviewing* run evidence.

## Repository layout

```
proto/hpath/v1/hpath.proto   # gRPC contract — single source of truth for the API
packages/
  contract/                  # @hpath/contract — generated TS types + descriptor set
  desktop/                   # @hpath/desktop — Tauri 2 macOS app (React UI + Rust tonic client)
  server/                    # @hpath/server — gRPC API, agent kernel, persistence, artifacts
docker/compose.yaml          # full stack: server + demo app (dev/staging) + optional SeaweedFS
fixtures/demo-app/           # three-way aligned system-under-test used by the demo
fixtures/prds/               # sample PRDs for the analyze agent
docs/                        # architecture docs + the 1.0 SPEC (scope & progress)
scripts/                     # proto generation helpers
Makefile                     # developer workflow targets
```

## Quickstart

Prerequisites: **Node >= 22.19**, **pnpm**, **Docker** (compose). `grpcurl` is optional (health checks).

### Guided demo (compose stack, no LLM key needed)

```bash
make install   # pnpm install
make demo      # builds & starts the compose stack, then walks the full user story:
               # parse PRD -> approve draft -> run on dev/staging -> failure verdict
               # -> pause/resume/cancel a live run -> replay -> history
```

The stack runs the server in **mock mode**: deterministic seeded data and scripted agent runs, so the demo is repeatable and needs no model credentials. The stack keeps running afterwards — connect the desktop app to explore the replay UI, and stop it with `make down`.

### Desktop app (macOS)

```bash
make dist                                  # .app/.dmg under packages/desktop/src-tauri/target/release/bundle
# or for development:
pnpm --filter @hpath/desktop dev
```

Apply the server address (`127.0.0.1:50051` for the compose stack) in the app's Settings view.

### Local server without Docker

```bash
make mock        # mock-mode server on 127.0.0.1:50051 (in-memory seed + scripted runs)
make real        # real mode: SQLite persistence + the actual agent kernel (needs a model key)
```

### Real-mode runs (live LLM + real system under test)

```bash
export OPENAI_API_KEY=sk-...     # or any OpenAI-compatible gateway configured in Settings
make up                          # demo-app dev/staging stay useful as the SUT
make real                        # real-mode server with the execute/analyze agents
```

In real mode the agent settings (provider baseUrl/apiKey/models) live in the desktop Settings view and persist server-side (`HPATH_SETTINGS_PATH`).

## Documentation

- [`docs/README.md`](docs/README.md) — documentation index + dev workflow
- [`docs/overview/product-overview.md`](docs/overview/product-overview.md) — problem, core model, concepts, architecture
- [`docs/overview/agent-design.md`](docs/overview/agent-design.md) — agents, tool providers, hard limits, run state machine, evidence
- [`docs/overview/dashboard.md`](docs/overview/dashboard.md) — desktop views and the Tauri IPC ↔ gRPC mapping
- [`docs/1.0/SPEC.md`](docs/1.0/SPEC.md) — 1.0 scope and progress (checkboxes)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Model access for real-mode agent runs and status chat (mock mode ignores it) |
| `HPATH_HOST` / `HPATH_PORT` | `127.0.0.1` / `50051` | gRPC listen address |
| `HPATH_ARTIFACT_STORE` | `local` | `local` filesystem store or `seaweedfs` (S3 API) |
| `HPATH_ARTIFACT_DIR` | `data/artifacts` | Local artifact store directory |
| `HPATH_SETTINGS_PATH` | `data/settings.json` | Model provider settings (real mode) |
| `HPATH_S3_ENDPOINT` (`SEAWEED_S3_ENDPOINT`) | `http://127.0.0.1:8333` | S3 endpoint for the `seaweedfs` backend |
| `HPATH_S3_BUCKET` / `HPATH_S3_REGION` | `hpath-artifacts` / `us-east-1` | S3 bucket settings |
| `HPATH_S3_ACCESS_KEY_ID` / `HPATH_S3_SECRET_ACCESS_KEY` | `hpath` | S3 credentials |

`HPATH_PORT` also maps the compose stack's server port (`make up` publishes it 1:1).

## Development

```bash
make proto   # regenerate TS types + descriptor from proto/ (after editing hpath.proto)
make build   # build all workspace packages
make test    # build + start mock server + unit tests + smoke client
make verify  # build + smoke against an already-running server
make cloc    # count lines of business code
```

All docs and code comments are in English.
