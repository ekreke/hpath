# TODO — Current Iteration

Iteration target: **Review fixes for T13/T14** (both lane tasks committed; hardening pass from the code review)

## Working notes

- Review-fix run (2026-09-03), one commit on `lane/desktop`:
  - CasesView: the live panel badge now shows the env the run was actually triggered with (`runEnvId`), fixing the misleading TopBar-env label on replay re-runs; `openReplay` gained a ticket guard so rapid clicks cannot let a stale `get_run` response win.
  - RunPanel: timeline screenshots now consume the download progress channel (percent when `sizeBytes` is known); `useArtifactDataUrl` surfaces download failures as an error state with a retry button (video no longer sticks at "loading… 0%"); thumbnail/video caches are capped (100 entries).
  - HistoryView: table + health strip + cases load through one ticket-guarded loader (stale responses dropped on rapid filter changes; refresh button also refreshes the strip; no duplicate ListRuns on mount); wired to `refreshKey` so re-runs show up without a manual refresh; end-of-day filter bound is `23:59:59.999` (was dropping the last 999 ms of a day).
  - global.css: health-strip dots now mirror RunStatusTag fill semantics (fail = solid, pass = outline).
  - Rust `show_trace`: a launch only succeeds if the child survives a ~1.5 s probe (early non-zero exits surface with stderr); the `hpath-traces` temp dir prunes zips older than a day.
  - i18n: `runPanel.videoFailed` / `runPanel.retry` added to en + zh.
- Gates (all green at the fix commit): `pnpm build`, `cargo check` (src-tauri), `make test` (SMOKE PASS), `tsc --noEmit` (desktop package).
- Still deferred to human acceptance: manual `make run` smoke on macOS for replay + history (unchanged from T14).

## Prior iteration notes

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
