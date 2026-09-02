# TODO — Current Iteration

Iteration target: **T11 Management views** (PRD management, case list/detail/review, env CRUD, run trigger)

## Working notes

- T10 checkpointed. Deliverables:
  - `packages/desktop/`: Tauri 2 scaffold (React + Vite + i18n with EN/中文).
  - `packages/desktop/src-tauri/`: Rust backend (tonic client -> mock gRPC; three IPC commands: `list_projects`, `list_envs`, `set_server_addr`).
  - `packages/desktop/src-tauri/build.rs` runs `tauri_build::build()` + `tonic_build::compile_protos` on the shared proto (single source of truth, same contract as the server).
  - Top bar: project/env switchers, connection status badge, language toggle, server-address input with Apply.
- Automated gates (both green):
  - `pnpm build` (root) — server + desktop both build.
  - `cargo check` (src-tauri) — Rust side compiles, tonic-build generates types, command macros resolve.
  - `make test` — full server smoke suite still green.
- Manual gate (requires a macOS desktop session):
  - `make mock` then `cd packages/desktop && pnpm tauri dev` — window opens, TopBar shows "Connected" against the mock server, env switcher populated with dev/staging, language toggle switches EN/中文.
- Known follow-ups for T11+:
  - Add `#[tauri::command] pub async fn run_case(...)` + a streaming pattern (spawn task that `app.emit("run-event/<runId>", event)`); no contract change needed.
  - Wire up projects (currently the frontend `projects` array is empty — `invoke_list_projects` isn't called yet; T11 will load it).
- Next up: T11 management views (mock-backed).

## Blockers

None.
