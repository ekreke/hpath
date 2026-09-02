# Dashboard (Desktop Client)

Tauri 2 desktop app for macOS. React UI; Rust layer hosts a tonic gRPC client. UI never talks to the server directly; it calls Tauri IPC commands, Rust executes gRPC, and streaming responses are forwarded to the webview as Tauri events.

## Global Navigation

Top bar, always visible:

- **Project switcher** — scopes everything below it.
- **Env switcher** — scopes execution and history views.
- Connection status (server reachable / offline).

## Views

### 0. Chat / System Status (default home)
Conversational landing page launched on startup. Renders a system overview (projects, cases by status, envs, run summary) and answers quick queries as chat messages: what is running now (RUNNING runs), recent runs, per-case health (last-N results), env overview. 1.0 aggregates existing gRPC endpoints client-side via the IPC surface (no NLP, no new contract); a free-text input maps common phrases to the same queries. The server-side `status-agent` (natural-language answers over the same data) is reserved for 1.1.

### 1. PRD Management
- Upload PRD files (md / docx / pdf), list PRDs of the current project.
- Trigger analyze-agent; watch parse progress (streaming events).
- Open produced drafts with PRD traceability (`source_prd_ref`).

### 2. Case List (per project)
Columns: title/id, creator (human name or `agent-run#<id>` linking to the analyze run), status (draft/pending/approved/disabled), latest run result per current env (pass/fail + when), version, updated_at.

### 3. Case Detail
Three blocks:
1. **Info** — goal, alignments, source PRD link, creator, version history/changelog, status with review actions (approve / reject / disable) for `pending` cases.
2. **Envs** — env switcher (filters the history block), last result per env comparison strip.
3. **Run History** — table: time, env, result, duration, trigger (manual/agent), token cost; row click opens Run Detail. "Run now" button (approved cases only).

### 4. Live Run Panel
- Opened on run trigger (or from Run History for a finished run, in replay mode).
- Streaming event feed: agent thinking, tool calls, screenshots inline (thumbnails, click to enlarge), request/response records.
- Hard-limit status bar: steps used / max, tokens used / budget, elapsed / timeout.

### 5. Run Detail (replay, three layers)
- **Watch** — inline webm video player + screenshot timeline + full agent transcript (thoughts and tool calls, step by step).
- **Time travel** — download trace.zip and open with `npx playwright show-trace` (client offers a one-click action).
- **Re-run** — trigger a new run of the same case on the same env; compare runs via history (agent is non-deterministic; evidence comparison is the source of truth).

### 6. History
Run list filterable by project/env/case/status/date; aggregate health per case (last N results dots).

### 7. Env Management
Per project: list envs, create/edit (name, web URL, gRPC address, variables, credentials — plaintext in 1.0), delete with run-existence guard.

## Tauri IPC Surface (mirror of gRPC)

| Command | gRPC |
|---------|------|
| list_projects / create_project | ListProjects / CreateProject |
| list_envs / upsert_env / delete_env | ListEnvs / UpsertEnv / DeleteEnv |
| upload_prd / parse_prd (stream) | ParsePRD |
| list_cases / get_case / review_case | ListCases / GetCase / ReviewCase |
| run_case (events stream) | RunCase |
| list_runs / get_run | ListRuns / GetRun |
| download_artifact (progress events) | DownloadArtifact |

Streaming: Rust side forwards tonic response streams as Tauri events on fixed channels — `parse-prd-event` for PRD parsing and `run-event` for runs (the server assigns the run id, so the webview cannot subscribe per-id before the first event arrives; consumers filter by the payload's `runId`). Fallback polling if event delivery fails.

Plus `set_server_addr` — a client settings command with no gRPC counterpart: it validates the address and holds it Rust-side (AppState); every IPC command reads the address from that state. The UI (TopBar input + Apply) persists it client-side in localStorage.

## Design Constraints

- Desktop holds no persistent state beyond settings (server address); refresh = re-query.
- All reads go through the gRPC contract; no direct SQLite/FS access.
- Binary artifacts stream through Rust (tonic) to a temp cache dir for playback; cache eviction is size-capped.
