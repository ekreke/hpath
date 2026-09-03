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
 * The kernel's `finish_verdict` tool. Arguments pass through the tool layer
 * untyped (loose schema) so each AgentDefinition can define its own output
 * shape; strict validation happens in the VerdictChannel against the
 * definition's outputSchema.
 */
export function createFinishVerdictTool(options: {
  channel: VerdictChannel;
  events: AgentEventSink;
}): AgentTool {
  return {
    name: "finish_verdict",
    label: "Finish with verdict",
    description:
      "Submit the final structured verdict for this run. The verdict is validated "
        + "against the agent's output schema; a valid verdict is the only way to "
        + "finish the run successfully. Call this exactly once.",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: async (_toolCallId, params) => {
      const verdict = options.channel.record(params);
      options.events.append({ kind: "verdict", verdict });
      return {
        content: [{ type: "text", text: "verdict recorded; run finished" }],
        details: { recorded: true },
        // Hint the loop to stop after this tool batch: the verdict is the
        // terminal action of a run.
        terminate: true,
      };
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
    parameters: Type.Object({}, { additionalProperties: true }),
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
