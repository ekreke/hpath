// Structured verdict channel (kernel-owned).
//
// A run may only succeed through the channel: the agent submits a verdict via
// the kernel's `finish_verdict` tool, the kernel validates it against the
// definition's outputSchema, and the pipeline treats a recorded verdict as the
// sole success path. The kernel-owned "evidence" ToolProvider carries the
// channel; T7b extends it with `record_evidence` / richer execute-agent
// verdict tooling.

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonSchemaValue, Verdict } from "./types.js";
import { assertSchema } from "./schema.js";
import type { ToolProvider } from "./tools.js";
import type { AgentEventSink } from "./events.js";
import type { RunEvidence } from "./evidence.js";

export class VerdictChannel {
  private recorded?: Verdict;

  constructor(readonly outputSchema: JsonSchemaValue) {}

  get isRecorded(): boolean {
    return this.recorded !== undefined;
  }

  get value(): Verdict | undefined {
    return this.recorded;
  }

  /**
   * Validate a candidate verdict against the definition's outputSchema and
   * record it. Throws on schema violations or a double submission.
   */
  record(candidate: unknown): Verdict {
    if (this.recorded !== undefined) {
      throw new Error("verdict already recorded for this run");
    }
    assertSchema(candidate, this.outputSchema, "verdict");
    this.recorded = candidate as Verdict;
    return this.recorded;
  }
}

/**
 * Loose-but-explicit parameter schemas. An empty `Type.Object({})` advertises
 * no properties to the provider, and some OpenAI-compatible models then send
 * an empty arguments object (the tool call arrives with keys [none]). Naming
 * the commonly submitted fields as optional keeps the channel untyped while
 * telling the model what it may pass. `additionalProperties: true` preserves
 * the "any shape" contract; strict validation stays in the VerdictChannel.
 */
const FINISH_VERDICT_PARAMS = Type.Object(
  {
    status: Type.Optional(Type.String({ description: '"pass" or "fail"' })),
    summary: Type.Optional(Type.String({ description: "One-paragraph human-readable outcome" })),
    alignments: Type.Optional(
      Type.Array(Type.Record(Type.String(), Type.Unknown()), {
        description: "One entry per alignment: {rule, api, ui, match, notes?}",
      }),
    ),
    verdict: Type.Optional(Type.Unknown({ description: "Alternative: the whole verdict object as this single field" })),
  },
  { additionalProperties: true },
);

const RECORD_EVIDENCE_PARAMS = Type.Object(
  {
    rule: Type.Optional(Type.String({ description: "PRD logic that must hold" })),
    api: Type.Optional(Type.String({ description: "Observed backend output" })),
    ui: Type.Optional(Type.String({ description: "Observed frontend display" })),
    match: Type.Optional(Type.Boolean({ description: "True when all three sides agree" })),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

/**
 * The kernel's `finish_verdict` tool. Arguments pass through the tool layer
 * untyped (loose schema) so each AgentDefinition can define its own output
 * shape; strict validation happens in the VerdictChannel against the
 * definition's outputSchema.
 *
 * Real models occasionally wrap the verdict instead of passing it flat — a
 * single JSON-encoded string, or `{ verdict: {...} }`. The tool unwraps both
 * transparently and, on schema failure, reports the received shape so the
 * model can self-correct instead of retrying blind.
 */
function unwrapVerdictParams(params: unknown): unknown {
  if (typeof params === "string") {
    try {
      return JSON.parse(params);
    } catch {
      return params;
    }
  }
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    const record = params as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "verdict" && typeof record.verdict === "object" && record.verdict !== null) {
      return record.verdict;
    }
  }
  return params;
}

export function createFinishVerdictTool(options: {
  channel: VerdictChannel;
  events: AgentEventSink;
}): AgentTool {
  return {
    name: "finish_verdict",
    label: "Finish with verdict",
    description:
      "Submit the final structured verdict for this run. Pass the verdict fields "
        + "as flat named parameters (status, summary, alignments), not as a JSON "
        + "string or a nested object. The verdict is validated against the agent's "
        + "output schema; a valid verdict is the only way to finish the run "
        + "successfully. Call this exactly once.",
    parameters: FINISH_VERDICT_PARAMS,
    execute: async (_toolCallId, rawParams) => {
      const params = unwrapVerdictParams(rawParams);
      try {
        const verdict = options.channel.record(params);
        options.events.append({ kind: "verdict", verdict });
        return {
          content: [{ type: "text", text: "verdict recorded; run finished" }],
          details: { recorded: true },
          // Hint the loop to stop after this tool batch: the verdict is the
          // terminal action of a run.
          terminate: true,
        };
      } catch (err) {
        const shape =
          typeof params === "object" && params !== null
            ? `object with keys [${Object.keys(params as Record<string, unknown>).join(", ") || "none"}]`
            : typeof params;
        throw new Error(
          `${(err as Error).message}. Received ${shape}; pass flat named parameters: `
            + `status ("pass"|"fail"), summary (string), alignments (array of {rule, api, ui, match}).`,
        );
      }
    },
  };
}

/**
 * The kernel's `record_evidence` tool (T7b). Records one structured
 * observation (e.g. a three-way alignment entry) into the run's evidence
 * store and the event stream. Evidence recorded here is preserved even if
 * the run later fails or hits a hard limit. Unlike `finish_verdict`, this
 * tool may be called any number of times.
 */
export function createRecordEvidenceTool(options: {
  evidence: RunEvidence;
  events: AgentEventSink;
}): AgentTool {
  return {
    name: "record_evidence",
    label: "Record evidence",
    description:
      "Record one structured evidence observation for this run (for example a "
        + "three-way alignment entry with rule, api, ui, match, notes). Observations "
        + "are preserved even if the run fails later. The final verdict is still "
        + "submitted separately via finish_verdict.",
    parameters: RECORD_EVIDENCE_PARAMS,
    execute: async (_toolCallId, entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("evidence entry must be a JSON object");
      }
      options.evidence.record(entry as Verdict);
      options.events.append({ kind: "evidence_recorded", entry: entry as Verdict });
      return {
        content: [{ type: "text", text: "evidence recorded" }],
        details: { recorded: true, total: options.evidence.entries.length },
      };
    },
  };
}

/**
 * Kernel-owned evidence provider: the structured verdict channel
 * (`finish_verdict`) plus evidence recording (`record_evidence`). Auto-injected
 * by the pipeline unless a definition binds its own evidence provider.
 */
export function createEvidenceToolProvider(): ToolProvider {
  return {
    id: "evidence",
    description:
      "Kernel evidence tools: structured verdict channel (finish_verdict) "
        + "and evidence recording (record_evidence).",
    createTools: (context) => [
      createFinishVerdictTool({ channel: context.verdict, events: context.events }),
      createRecordEvidenceTool({ evidence: context.evidence, events: context.events }),
    ],
  };
}
