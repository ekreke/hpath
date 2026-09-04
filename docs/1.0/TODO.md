# TODO — Current Iteration

Iteration target: **T8 real RunCase wiring + T7a/T7b/T8 checkpoint** (done; human acceptance passed)

## Working notes

- Desktop IA & brand overhaul (2026-09-05, desktop-only; no contract/server changes, no SPEC checkbox impact):
  - Brand: sidebar wordmark is now "HappyPath" (per-character rainbow sampled from the new logo: H purple, "appy" white, "Path" warm ramp); logo assets live in `docs/desigin/` (`logo-dark.png` + previews); Tauri app icons replaced (black rounded square + rainbow H, macOS transparent padding, regenerated icns + png set in `src-tauri/icons/`).
  - Sidebar: three top-level destinations only — Chat / Projects / Settings (Settings merged into the main nav); the project switcher box is gone; collapse toggle sits in the brand row (collapsed = 48px icon rail, persisted in localStorage); sidebar fonts bumped (brand 18px, items 15px).
  - Projects page: two-level flow — project list (`views/ProjectsView.tsx`: search + name/repo/created table + create modal) → workspace master-detail (Cases / History / PRD / Envs sub-nav, active tab persisted). TopBar is a segmented breadcrumb; the "Projects" segment is clickable and returns to the list.
  - Env selection moved from the removed sidebar env tree into the Cases run panel as a Select; env CRUD stays in the workspace Envs tab.
  - Settings page switched from horizontal seg tabs to the same master-detail sub-nav pattern; global font size +1px (body 14.5px).
  - Gates: `tsc -b` + `vite build` green. SPEC "Next up" (T9/T15/T6-s3/T18) unaffected.
- T8 landed (2026-09-04), one pass on `develop`:
  - New `grpc/run-execution.ts`: real-mode `RunCase` (validate APPROVED -> run row RUNNING -> kernel executes `execute-agent` while events stream mapped to proto `Event`, gapless seq; screenshots upload to the artifact store and stream as `screenshot{artifact_id}`; video/trace upload after settle; `runs.finish` writes verdict/tokens/duration/failReason; kernel crash settles a stranded RUNNING run as failed). Real-mode `GetRun` + `DownloadArtifact` (64 KiB chunks) wired too.
  - Kernel hardening found by live acceptance:
    - Seed env credentials now match the demo-app (`demo/demo1234` in mock + real seeds; the old `test/123456` burned agent steps on failed logins).
    - `finish_verdict`/`record_evidence` advertise explicit optional parameter fields (an empty properties schema made GLM send an empty arguments object) and `finish_verdict` unwraps JSON-string / `{verdict:...}` shapes, reporting the received shape on schema failure so the model self-corrects.
  - Kernel additions: `RunEvidence.pendingArtifacts` (browser registers `session.webm` + `trace.zip` after context close; Playwright recordVideo + tracing are always on), `AgentRunResult.pendingArtifacts`, and a `request_record` event kind appended by the http/grpc providers (desktop request panel shows real traffic).
  - Chat persistence (same pass, desktop-driven): chat sessions + messages persist server-side (SQLite `0004_chat`, repositories, 4 session RPCs + `Chat` carries `session_id`); the desktop Chat view no longer auto-asks the LLM on mount (welcome state + lazy session creation) and keeps multi-turn context (last 10 messages join the prompt).
- T8 acceptance (live, `--real` + compose demo-app dev): RunCase over gRPC yielded 44 ordered events ending PASSED with a three-way match verdict (UI ¥1,337.50 = HTTP = gRPC); artifacts complete in the store (screenshot PNG + 1.1 MB session.webm + 443 KB trace.zip); a failed run keeps its evidence; GetRun/DownloadArtifact verified (zip magic correct).
- Gates (all green): `pnpm build`, `pnpm --filter @hpath/server test` (171 tests), SPEC checkboxes ticked: T5, T3, T6 (s3 round-trip pending a live check), T7a, T7b, T8, T11, T13, T14, T17 (description revised: server-side LLM chat + session persistence superseded the client-side-only plan).

## Next up

- T9 analyze-agent: real-mode `ParsePRD` gRPC wiring (kernel side + tests already exist). Same iteration: real-mode `ReviewCase` wiring (review workflow is mock-only right now).
- T15 E2E demo script + README (no README yet).
- T6 leftover: `s3` backend round-trip against the compose `s3` profile SeaweedFS.
- T18 desktop dogfooding (SPEC E section): debug bridge in the desktop app + one seeded dogfood case; schedule after T9/T15.

## Blockers

None.
