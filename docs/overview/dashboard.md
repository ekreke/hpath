# Dashboard (Desktop Client)

Tauri 2 desktop app for macOS. React UI; Rust layer hosts a tonic gRPC client. UI never talks to the server directly; it calls Tauri IPC commands, Rust executes gRPC, and streaming responses are forwarded to the webview as Tauri events.

## Global Navigation

- **Sidebar** (collapsible to a 48px icon rail via the brand-row toggle): brand wordmark, three top-level destinations — **Chat** (default home), **Projects**, **Settings** — and a connection footer (server reachable / offline).
- **Top bar**: breadcrumb only, built from segments; earlier segments are clickable (e.g. "Projects" inside a project workspace returns to the project list).

## Projects (two-level flow)

Clicking **Projects** in the sidebar always lands on the project list first:

1. **Project list** — search box (filters by name / repo URL), table of projects (name / repository / created date) with clickable rows, a per-row delete action, and a create-project modal (name + optional repo URL; creating refreshes the list and opens the new project).
2. **Project workspace** (opened by clicking a row) — master-detail layout, same pattern as Settings: a sticky sub-nav (Cases / Run History / PRD Docs / Envs, with counts; active tab persisted) on the left and the active sub-view on the right. The sub-nav ends with a **Project details** entry: metadata, an edit form (name + repo URL, backed by `UpdateProject`), and a danger zone (cascade delete, backed by `DeleteProject`).

**Deletion is a cascade**: deleting a project removes its envs, cases (with alignments/changelog), runs (with events + artifact records), and PRDs in one server-side transaction; artifact bytes are purged from the artifact store best-effort after the commit. The UI requires typing the exact project name before the delete button enables.

## Views

Sections 1–7 live inside the project workspace (see "Projects" above); each renders under the workspace sub-nav with its own header.

### 0. Chat / System Status (default home)
Conversational landing page launched on startup. Free-text questions and quick-query chips ("system overview", "what is running now", "recent runs", "case health", "env overview") are answered by the server-side status chat: the LLM answers from a live system snapshot embedded in its system prompt (projects / cases by status / envs / recent runs), streamed as markdown deltas with live token metrics. Sessions are persisted server-side (SQLite): lazy session creation on the first question, session switcher with delete in the header, multi-turn context (recent history joins the prompt). (The original 1.0 plan — client-side aggregation with no NLP and no new contract — was superseded by this server-side chat; the richer registered-agent form stays in 1.1.)

### 1. PRD Management
- Upload PRD files (md / docx / pdf), list PRDs of the current project.
- Trigger analyze-agent; watch parse progress (streaming events).
- Open produced drafts with PRD traceability (`source_prd_ref`).

### 2. Case List (per project)
Columns: title/id, creator (human name or `agent-run#<id>` linking to the analyze run), status (draft/pending/approved/disabled), latest run result (pass/fail + when), version, updated_at.

### 3. Case Detail
Three blocks:
1. **Info** — goal, alignments, source PRD link, creator, version history/changelog, status with review actions (approve / reject / disable) for `pending` cases.
2. **Run** — run panel entry: target env Select (filters nothing else; the chosen env is the run target), "Run now" button (approved cases only). When the project has no envs yet, the panel offers a jump to the workspace Envs tab.
3. **Run History** — table: time, env, result, duration, trigger (manual/agent), token cost; row click opens Run Detail.

### 4. Live Run Panel
- Opened on run trigger (or from Run History for a finished run, in replay mode).
- Streaming event feed: agent thinking, tool calls, screenshots inline (thumbnails, click to enlarge), request/response records.
- Live browser view (T21): while a run executes, the panel shows the page as the agent sees it — the server drives a CDP screencast (jpeg frames, throttled + latest-wins backpressure) and the desktop subscribes via `watch_run` as soon as the run id is known. Frames are ephemeral (never persisted); a run that never touches the browser shows "no live frames".
- Hard-limit status bar: steps used / max, tokens used / budget, elapsed / timeout.
- Runtime control: Pause (⏸) / Resume (▶) / Stop (■) buttons while a run is live. The live status pill follows the stream's `run_status` events (RUNNING ⇄ PAUSED → terminal); the elapsed clock skips paused spans.

### 5. Run Detail (replay, three layers)
- **Watch** — inline webm video player + screenshot timeline + full agent transcript (thoughts and tool calls, step by step).
- **Time travel** — download trace.zip and open with `npx playwright show-trace` (client offers a one-click action).
- **Re-run** — trigger a new run of the same case on the same env; compare runs via history (agent is non-deterministic; evidence comparison is the source of truth).

### 6. History
Run list filterable by project/env/case/status/date; aggregate health per case (last N results dots).

### 7. Env Management
Per project: list envs, create/edit (name, web URL, gRPC address, variables, credentials — plaintext in 1.0; optional agent-limit overrides: maxSteps, tokenBudget, timeout in **minutes**, capped at 1440), delete with run-existence guard.

## Tauri IPC Surface (mirror of gRPC)

| Command | gRPC |
|---------|------|
| list_projects / create_project / update_project / delete_project | ListProjects / CreateProject / UpdateProject / DeleteProject |
| list_envs / upsert_env / delete_env | ListEnvs / UpsertEnv / DeleteEnv |
| upload_prd / parse_prd (stream) | ParsePRD |
| list_cases / get_case / review_case | ListCases / GetCase / ReviewCase |
| run_case (events stream) | RunCase |
| control_run (pause/resume/cancel) | PauseRun / ResumeRun / CancelRun |
| watch_run (frame channel) | WatchRun |
| list_runs / get_run | ListRuns / GetRun |
| download_artifact (progress events) | DownloadArtifact |
| get_settings / update_settings | GetSettings / UpdateSettings |
| chat (stream) | Chat |
| create_chat_session / list_chat_sessions / list_chat_messages / delete_chat_session | CreateChatSession / ListChatSessions / ListChatMessages / DeleteChatSession |

Streaming: Rust side forwards tonic response streams as Tauri events on fixed channels — `parse-prd-event` for PRD parsing and `run-event` for runs (the server assigns the run id, so the webview cannot subscribe per-id before the first event arrives; consumers filter by the payload's `runId`). Fallback polling if event delivery fails.

Plus `set_server_addr` — a client settings command with no gRPC counterpart: it validates the address and holds it Rust-side (AppState); every IPC command reads the address from that state. The UI lives in the Settings view (Server section): input + Apply persists it client-side in localStorage. (Originally this input sat in the TopBar; the TopBar is breadcrumb-only since the 2026-09 desktop IA overhaul.)

Other client-only helpers with no gRPC counterpart: `save_artifact` (persists downloaded artifact bytes to a local path, e.g. trace.zip) and `show_trace` (launches `playwright show-trace` on the saved trace).

## Design Constraints

- Desktop holds no persistent state beyond UI preferences in localStorage (server address, UI language, sidebar collapsed flag, last project tab); refresh = re-query.
- All reads go through the gRPC contract; no direct SQLite/FS access.
- Binary artifacts stream through Rust (tonic) to a temp cache dir for playback; cache eviction is size-capped.
