// The prd-analysis ToolProvider (T9): the analyze-agent's tool surface from
// docs/overview/agent-design.md — read_prd, list_existing_cases and the
// schema-validated write_case_draft. The run is finished through the kernel's
// structured verdict channel (finish_verdict), which the pipeline auto-injects.
//
// Nothing here is agent-specific wiring: it is a normal ToolProvider bound to
// the analyze-agent via AgentDefinition.toolBindings.

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CaseStatus, CreatorType } from "@hpath/contract";
import {
  CASE_DRAFT_SCHEMA,
  DRAFT_INPUT_SCHEMA,
  ANALYZE_AGENT_ID,
} from "../analyze-agent.js";
import { assertSchema } from "../schema.js";
import type { ToolProvider, ToolContext } from "../tools.js";
import { ingestPrd, prdFormatFromFilename } from "../prd.js";
import type { PrdFormat } from "../prd.js";
import type { Verdict } from "../types.js";

/** Options for the prd-analysis provider. */
export interface PrdAnalysisToolProviderOptions {
  /** Cap on the text returned by read_prd (default 200k chars, from ./prd.ts). */
  // (Truncation lives in ingestPrd; no provider-level options in 1.0.)
}

/** The run input shape this provider reads (validated by the definition). */
export interface AnalyzeRunInput {
  projectId: string;
  filename: string;
  format: PrdFormat;
  contentBase64: string;
  existingCases?: { title: string; goal: string }[];
}

/** A full, kernel-stamped case draft — the proto Case shape (camelCase). */
export interface CaseDraft extends Record<string, unknown> {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  alignments: { apiPath: string; uiAnchor: string; rule: string }[];
  creator: { type: CreatorType; name: string; runRef: string };
  status: CaseStatus;
  sourcePrdRef: string;
  version: number;
  changelog: { version: number; author: string; comment: string; changedAt: string }[];
  createdAt: string;
  updatedAt: string;
}

function runInput(context: ToolContext): AnalyzeRunInput {
  return context.input as AnalyzeRunInput;
}

/** The kernel-stamped draft: proto Case shape, pending, agent-created. */
function stampDraft(context: ToolContext, proposal: Record<string, unknown>): CaseDraft {
  const input = runInput(context);
  const now = new Date().toISOString();
  const alignments = (proposal.alignments as Record<string, unknown>[]).map((alignment) => ({
    apiPath: typeof alignment.apiPath === "string" ? alignment.apiPath : "",
    uiAnchor: typeof alignment.uiAnchor === "string" ? alignment.uiAnchor : "",
    rule: alignment.rule as string,
  }));
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    title: proposal.title as string,
    goal: proposal.goal as string,
    alignments,
    creator: {
      type: CreatorType.CREATOR_TYPE_AGENT,
      name: ANALYZE_AGENT_ID,
      runRef: `analyze-run#${context.runId}`,
    },
    status: CaseStatus.CASE_STATUS_PENDING,
    sourcePrdRef: proposal.sourcePrdRef as string,
    version: 1,
    changelog: [
      {
        version: 1,
        author: ANALYZE_AGENT_ID,
        comment: "Drafted from PRD by analyze-agent",
        changedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

/** The analyze-agent's `read_prd` tool: PRD bytes -> extracted plain text. */
export function createReadPrdTool(context: ToolContext): AgentTool {
  return {
    name: "read_prd",
    label: "Read PRD",
    description:
      "Read the PRD under analysis. Returns the extracted plain text regardless of "
        + "the container format (markdown is read directly, docx via mammoth, pdf via pdf-parse).",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      const input = runInput(context);
      // Defence in depth: the input schema already pins format to md|docx|pdf.
      const format = prdFormatFromFilename(input.filename) ?? input.format;
      const ingested = await ingestPrd(Buffer.from(input.contentBase64, "base64"), format);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            filename: input.filename,
            format: ingested.format,
            chars: ingested.chars,
            text: ingested.text,
          }),
        }],
        details: { format: ingested.format, chars: ingested.chars },
      };
    },
  };
}

/** The analyze-agent's `list_existing_cases` tool: coverage already present. */
export function createListExistingCasesTool(context: ToolContext): AgentTool {
  return {
    name: "list_existing_cases",
    label: "List existing cases",
    description:
      "List the test cases that already exist in the project, so new drafts do not duplicate them.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async () => {
      const existing = runInput(context).existingCases ?? [];
      return {
        content: [{ type: "text", text: JSON.stringify({ count: existing.length, cases: existing }) }],
        details: { count: existing.length },
      };
    },
  };
}

/**
 * The analyze-agent's `write_case_draft` tool. Validates the proposal against
 * DRAFT_INPUT_SCHEMA, stamps the full pending agent draft (proto Case shape)
 * and records it as run evidence — drafts survive limit breaches. The run is
 * still only finished through finish_verdict.
 */
export function createWriteCaseDraftTool(context: ToolContext): AgentTool {
  return {
    name: "write_case_draft",
    label: "Write case draft",
    description:
      "Record one test-case draft derived from the PRD. Provide title, goal, alignments "
        + "(rule, and where the PRD names them apiPath and uiAnchor) and sourcePrdRef. "
        + "The kernel stamps id, project, pending status, agent creator, version and "
        + "changelog, and returns the full draft; include exactly these stamped drafts "
        + "in your final finish_verdict.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_toolCallId, params) => {
      assertSchema(params, DRAFT_INPUT_SCHEMA, "case draft");
      const draft = stampDraft(context, params as Record<string, unknown>);
      // The stamped draft must itself be schema-valid — a kernel bug would
      // surface here instead of producing broken cases.
      assertSchema(draft, CASE_DRAFT_SCHEMA, "stamped case draft");
      context.evidence.record(draft as Verdict);
      context.events.append({ kind: "case_draft_recorded", draft: draft as Verdict });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ recorded: true, total: context.evidence.entries.length, draft }),
        }],
        details: { recorded: true, total: context.evidence.entries.length },
      };
    },
  };
}

/** The built-in prd-analysis ToolProvider (analyze-agent tool surface). */
export function createPrdAnalysisToolProvider(
  _options: PrdAnalysisToolProviderOptions = {},
): ToolProvider {
  return {
    id: "prd-analysis",
    description:
      "Analyze-agent tools: read_prd (md/docx/pdf ingest), list_existing_cases and "
        + "the schema-validated write_case_draft (kernel-stamped pending drafts).",
    createTools: (context) => [
      createReadPrdTool(context),
      createListExistingCasesTool(context),
      createWriteCaseDraftTool(context),
    ],
  };
}
