# Milestones

## 1.0 (active) — End-to-End Spike

Goal: prove the full pipeline of the AI testing platform end to end.

- Desktop client (macOS, Tauri 2) talks to a containerized server over gRPC.
- Two built-in agents (analyze / execute) built on the pi agent framework.
- Executor agent autonomously verifies three-way alignment (PRD logic ↔ frontend display ↔ backend output) with hard limits.
- Every run produces evidence: per-step screenshots, video, trace, structured verdict.
- Server-side storage: SQLite (projects / envs / cases / runs / events, source of truth for cases) + SeaweedFS (binary artifacts).
- Deployable with a single `docker compose up` (server + seaweedfs + demo-app dev/staging).

Exit criteria: all checkboxes in `docs/1.0/SPEC.md` are complete and the end-to-end demo script (T15) runs successfully.

## 1.1 (planned, design reserved in 1.0 docs)

- Platform MCP Server facade (streamable HTTP): parse_prd / list_cases / run_case / get_run / get_run_artifacts.
- Executor ToolProviders for external MCP servers and pi skills.
- Additional agents registered through AgentRegistry (diagnose-agent, optimize-agent, custom agents via config/MCP).
- Failure diagnosis agent that analyzes run evidence and drafts case fixes.
- Container-per-run execution isolation.
- Credential injection via environment variables (placeholder syntax in env config).
