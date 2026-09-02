# TODO — Current Iteration

Iteration target: **T10 Desktop skeleton** (Tauri 2 + Rust tonic client + React shell)

## Working notes

- T1 complete (checkpointed in SPEC). All SPEC verify items green:
  - `pnpm build` passes; grpcurl reflection lists all 13 RPCs (describe/list work).
  - Mock server serves seed data; RunCase streams 20 ordered scripted events ending in PASSED verdict; smoke suite (`pnpm --filter @hpath/server smoke`) fully green.
  - `--real` mode returns UNIMPLEMENTED as designed.
- Contract notes for desktop work (T10):
  - Proto is final: `proto/hpath/v1/hpath.proto`; Rust types come from tonic codegen on the same file.
  - Server default endpoint `127.0.0.1:50051` (`--port` flag, `HPATH_PORT` env).
  - Reflection is served from `gen/hpath-descriptor.pb` (regenerate with `pnpm gen:proto`).
  - Enum members carry full prefixes (`CASE_STATUS_APPROVED`, `RUN_TRIGGER_MANUAL`, ...).
- Server start for desktop dev: `pnpm mock` (repo root).
- Next up after T10: T11 management views (mock-backed).

## Blockers

None.
