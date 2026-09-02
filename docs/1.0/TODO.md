# TODO — Current Iteration

Iteration target: **T13 Run detail (replay)**

## Working notes

- T12 Live run panel checkpointed (branch `feat/t12-live-run-panel`):
  - `run_case` now forwards every stream event to the webview on the fixed `run-event` channel (`RunEventDto`, tagged by kind, carries `runId`/`seq`/`timestamp`); the command still resolves with the final `RunResultDto` (invoke end = run end).
  - New `download_artifact` IPC command: collects the gRPC byte stream and returns base64 — screenshot events render inline in the panel with click-to-zoom (progress events deferred to T13's replay work).
  - New `RunPanel` component (replaces the old result modal; embedded inline in the case detail view between the header and the info grid): per-kind event feed (thinking/text/tool started-finished/request records with expandable JSON/errors/status changes), steps + elapsed status bar, final verdict via the extracted shared `VerdictPanel`. CasesView subscribes to `run-event` before invoking and filters events by the triggered run's id.
  - Status bar shows max/budget columns only as duration/token cost after completion — the proto carries no limit-budget fields; revisit when T8 wires real limits.
  - Mock: live run outcome follows a title-keyword convention (`outcomeForTitle` in handlers.ts): seeded probe cases `Limit probe hits the hard step budget` (limit script) and `Balance drift fails the alignment check` (fail script) demo the hard-limit and fail paths; other titles (incl. the smoke suite's Login case) pass on any env.
  - The panel's close does not cancel the server-side run (Tauri invoke has no cancellation in 1.0); replay of finished runs is T13.
- Automated gates (all green):
  - `pnpm build` (root) — contract + server + desktop build.
  - `cargo check` (src-tauri) — Rust side compiles, command macros resolve.
  - `make test` — full server smoke suite still green.
- Manual gate (requires a macOS desktop session):
  - `make run` — trigger the Login case: panel streams 20 events over ~8s and ends PASS; the drift probe ends FAILED with mismatch evidence; the limit probe ends FAILED on `limit:max_steps`.
- Next up: T13 run detail (replay) — webm player + screenshot timeline + transcript, trace.zip download, re-run.

## Blockers

None.
