# HPath Documentation

HPath is an AI-driven testing platform. It replaces manual click-through verification of test cases with autonomous agents that verify **three-way alignment**: PRD logic ↔ frontend display ↔ backend output.

## Layout

- `overview/` — architecture-level docs that stay relevant across versions:
  - `product-overview.md` — problem, core model, concepts, system architecture.
  - `agent-design.md` — agent runtime: AgentRegistry, AgentDefinition, ToolProviders, isolation, limits, evidence.
  - `dashboard.md` — desktop client: views, navigation, gRPC contract mapping, replay/history UX.
- `1.0/` — the single active version:
  - `SPEC.md` — source of truth for scope and progress (checkboxes).
  - `TODO.md` — current iteration working notes.

## Process

Development follows the dev-workflow pipeline. One sub-task from `docs/1.0/SPEC.md` per iteration:

1. **progress-tracker** — pick the next incomplete checkbox, validate actual repo state.
2. **implement** — implement against SPEC + overview docs.
3. **testing-stage** — verify per the verification matrix in SPEC.
4. **checkpoint** — tick the checkbox, update notes.

Rules: SPEC is the single source of truth; protect the desktop/server split; per-run execution isolation is mandatory in every design that touches execution.
