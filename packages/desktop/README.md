# hPath Desktop (Tauri 2)

T10 work in progress.

## Install note

`@tauri-apps/cli` has a postinstall binary step; if you hit permission issues during install, run `pnpm approve-builds` (the workspace `pnpm-workspace.yaml` already sets `onlyBuiltDependencies` for it).

First install: `pnpm install` (may need `pnpm approve-builds` for @tauri-apps/cli). Dev: `pnpm dev` (opens Tauri window).

## Build note

Building the Rust side (`src-tauri`) requires `protoc` (protobuf compiler) on your PATH. Install it via your package manager, e.g. `brew install protobuf` (macOS) or `apt install protobuf-compiler` (Debian/Ubuntu).

## Packaging (macOS)

- `make dist` (repo root) builds the release bundle: `.app` and `.dmg` land under `packages/desktop/src-tauri/target/release/bundle/`.
- Bundles are unsigned in 1.0: on first launch, right-click the app and choose Open, or clear the quarantine flag with `xattr -cr /Applications/HPath.app`.
- Releases: publishing a GitHub release triggers `.github/workflows/release.yml`, which builds the macOS dmg and attaches it to the release assets. `workflow_dispatch` runs the same build as a dry run (artifacts attach to the workflow run instead).
- The server address is set in-app: Settings → Server (input + Apply, validated and held by the Rust side, persisted locally). The input defaults to `127.0.0.1:50051` but nothing is hardcoded at call time.
