# TODO — Current Iteration

Iteration target: **T17 Chat / system status view (default home)**

## Working notes

- T11 views implemented against the mock (working tree): cases list/detail/review + minimal run trigger, env CRUD, PRD upload + live parse trace; shared `@hpath/contract` package extracted for TS types.
- T16 packaging + release CI added on top:
  - Tauri bundler enabled (macOS `.app`/`.dmg`, unsigned); full icon set generated via `tauri icon`; `make dist` builds the bundle.
  - `.github/workflows/release.yml` builds the macOS dmg on release publish and attaches it to the release; `workflow_dispatch` is a dry run (artifacts on the workflow run).
  - `set_server_addr` IPC command now actually exists (earlier T10 notes listed it as delivered, but it was missing): the address is validated and held Rust-side (`AppState`); the TopBar input + Apply persists it client-side (localStorage, default input value `127.0.0.1:50051`); all 10 gRPC commands read the address from state instead of taking an `addr` argument.
- T17 Chat / system status view (default home):
  - New `ChatView` as the default landing view (Sidebar first item, `ViewId` gains `chat`); renders a system overview + quick queries (running tasks, recent runs, case health, env overview) as chat messages.
  - Client-side only: aggregates existing IPC (list_projects/list_cases/list_runs/list_envs); free-text input maps common phrases to the same queries. No new gRPC contract, no Rust changes.
  - The server-side `status-agent` (natural-language answers + a `Chat` streaming endpoint) is reserved for 1.1 in SPEC Out of Scope.
- Automated gates (all green):
  - `pnpm build` (root) — contract + server + desktop build.
  - `cargo check` (src-tauri) — Rust side compiles, command macros resolve.
  - `make test` — full server smoke suite still green.
  - `make dist` — produces `.app`/`.dmg` locally.
- Manual gate (requires a macOS desktop session):
  - `make run` — window opens on the Chat view; quick queries render mock data; switching project re-queries.
  - First launch of a bundled (unsigned) build: right-click -> Open, or `xattr -cr` the app.
- Known follow-ups for T12+:
  - `run_case` currently collects the whole event stream and returns the final result; the live feed arrives in T12 (spawn task + `app.emit("run-event/<runId>", event)`); no contract change needed.
- Next up: T12 live run panel (mock-backed).

## Blockers

None.
