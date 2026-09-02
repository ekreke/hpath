# hPath Desktop (Tauri 2)

T10 work in progress.

## Install note

`@tauri-apps/cli` has a postinstall binary step; if you hit permission issues during install, run `pnpm approve-builds` (the workspace `pnpm-workspace.yaml` already sets `onlyBuiltDependencies` for it).

First install: `pnpm install` (may need `pnpm approve-builds` for @tauri-apps/cli). Dev: `pnpm dev` (opens Tauri window).

## Build note

Building the Rust side (`src-tauri`) requires `protoc` (protobuf compiler) on your PATH. Install it via your package manager, e.g. `brew install protobuf` (macOS) or `apt install protobuf-compiler` (Debian/Ubuntu).
