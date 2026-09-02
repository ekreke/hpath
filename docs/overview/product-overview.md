# Product Overview

## Problem

A system under test has a frontend. Today every test case must be verified by a human clicking through it. Humans are the bottleneck. HPath replaces manual verification with autonomous agents that drive a headless browser and call real interfaces, then leave behind reviewable evidence.

## Core Model: Three-Way Alignment

A case passes only when three sources agree:

```
PRD logic (expectation)  <->  frontend display (actual UI)  <->  backend output (actual API/gRPC response)
```

The executor agent must collect evidence for all three sides and produce a structured verdict explaining how they align (or where they diverge).

## Human Role Shift

Humans move from *executing* cases to *reviewing* them:

- The analyze agent drafts cases from PRDs; cases enter a review workflow (`pending` -> `approved`) in the desktop client before they can run.
- Humans review run evidence (video, screenshots, agent transcript, trace) instead of clicking through the app.

## Key Concepts

| Concept | Definition |
|---------|------------|
| Project | Top-level grouping. Holds cases, PRDs, envs. Optionally records the SUT repo URL as metadata (1.0 never reads it). |
| Env | A named target of a project (dev / staging / ...): web base URL, gRPC address, variables, credentials (plaintext in 1.0 spike). Managed server-side, edited in the client. |
| Case | A structured *definition* (not a step script): goal, alignments (relative API paths + UI anchors + rules), context. Lives in server SQLite — the source of truth. Has creator, status workflow, version history, PRD traceability. |
| Run | One execution of a case against one env by the executor agent. Fresh agent session per run. Produces events + artifacts + verdict. |
| Evidence / Artifacts | Per-step screenshots, session video (webm), Playwright trace.zip, request/response records, agent transcript. Binaries in SeaweedFS. |

## Architecture

```
+----------------------------------+
| hpath-desktop (macOS .app)       | Tauri 2: React UI + Rust tonic gRPC
| project/env switchers, PRD mgmt, |
| case mgmt + review, run triggers,|
| live panel, replay, history      |
+----------------+-----------------+
                 | gRPC (server-streaming events)
+----------------v------------------+     +------------------+
| hpath-server (Docker)             |---->| SeaweedFS (1 box)|
| gRPC API (+ MCP facade in 1.1)    |     | S3 API: video /  |
| AgentRegistry: analyze / execute  |     | trace / screenshots|
| ToolProviders: browser/http/grpc  |     +------------------+
| SQLite: projects/envs/cases/runs  |     +------------------+
| PRD ingest: md / docx / pdf       |---->| demo-app x2      |
+-----------------------------------+     | (dev/staging SUT)|
 docker compose up = full stack           +------------------+
```

Layer rules (protected in every iteration):

- Desktop: display + triggers only. No execution orchestration.
- Server: owns API, orchestration, persistence, scheduling, agent lifecycle.
- Execution isolation: every run gets its own browser context + workspace + artifact namespace. (Container-per-run is a 2.0 evolution.)

## Storage Ownership

| Store | Owns |
|-------|------|
| Server SQLite | Source of truth for projects, envs, cases (with versions + review status), runs, events, artifact index |
| SeaweedFS | Binary artifacts only, keyed by `(project, env, run)` |
| Desktop | Nothing persistent; pure client |

## Non-Goals in 1.0

- No git-backed case storage (cases are server-side by decision).
- No agent access to SUT source code (repo_url is metadata only).
- No platform MCP facade, no external MCP/skill tool providers (interfaces reserved).
- No scheduling beyond manual/agent-triggered runs.
