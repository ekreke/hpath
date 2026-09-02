# Agent Design

All agents run on the pi agent framework: `@earendil-works/pi-agent-core` (Agent runtime, tool calling, hooks) + `@earendil-works/pi-ai` (multi-provider LLM API, OpenAI configured in 1.0).

## Two Extension Layers

Agents are *registered definitions*, never hardcoded branches. Two registries compose:

```
AgentRegistry (agent-level extension entry)
  AgentDefinition = {
    id, role, systemPromptTemplate,
    toolBindings: ToolProviderId[],
    model, hardLimits {maxSteps, tokenBudget, timeoutMs},
    inputSchema, outputSchema
  }
  1.0 built-ins: analyze-agent, execute-agent
  1.1+: diagnose-agent, optimize-agent, config/MCP-injected custom agents

ToolProviderRegistry (tool-level extension entry)
  1.0 built-ins: browser, http, grpc, evidence
  1.1+ reserved: mcp/<external-server>, skills/<name>
```

The server kernel only knows `AgentDefinition`. Adding an agent = registering a definition; orchestration (triggering, event streaming, evidence recording, hard limits) is shared and unchanged.

## Built-in Agents (1.0)

### analyze-agent (PRD -> case drafts)

- Input: PRD file (md read directly; docx via mammoth; pdf via pdf-parse) + existing case list.
- Output: one or more case drafts with status `pending` (require human approval in the client before they can run).
- Tools: `read_prd`, `list_existing_cases`, `write_case_draft` (schema-validated), `finish`.
- Each draft records: creator `{type: "agent", run}`, `source_prd_ref`, version.

### execute-agent (autonomous case execution)

- Input: case definition + relevant PRD section + current env config.
- Mode: pure autonomous. The case states *what to verify and what counts as pass* (goal + alignments); the agent decides *how* (pages to open, buttons to click, APIs to call).
- Verdict: structured three-way alignment evidence per alignment entry:
  `{api: observed response, ui: observed display, rule, match: bool, notes}`.
- Tools:

| Provider | Tools |
|----------|-------|
| browser | navigate, click, fill, read_page, screenshot, wait |
| http | http_request |
| grpc | grpc_call |
| evidence (kernel) | record_evidence, finish_verdict |

## Isolation Rules

- Every run = a fresh pi Agent session. No cross-run or cross-env memory.
- Env binding: system prompt + tool config contain only the current env's targets/variables. Other envs are invisible.
- Storage namespace: runs / events / artifacts keyed by `(project, env, run)`.
- Execution isolation: one Playwright chromium context per run; `recordVideo` + `tracing.start(screenshots, snapshots, sources)` + per-step screenshots.

## Hard Limits

Configured per AgentDefinition, enforced by the kernel:

- `maxSteps` — stop and fail with evidence preserved.
- `tokenBudget` — cumulative input+output token cap.
- `timeoutMs` — wall-clock cap.

On limit breach: status `failed`, reason `limit:<kind>`, all collected evidence retained.

## Evidence Pipeline (shared by all agents)

Every agent run streams events through the same pipe:

- Event types: agent text/thinking, tool_call started/finished, screenshot captured, request/response recorded, verdict produced, error.
- Events persist to SQLite (`events` table) and stream to clients over gRPC server-streaming.
- Binary evidence uploads to SeaweedFS; metadata (key, kind, sha256) persists in `artifacts` table.
- pi hooks used for recording: `afterToolCall` (capture tool results), before/after run (session boundaries).

## OpenAI Access

- Provider configured via `pi-ai` with an OpenAI API key from server env (`OPENAI_API_KEY`).
- Model id configurable per AgentDefinition; defaults set in server config.
