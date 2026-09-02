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

/** Kernel-owned evidence provider. Extended with recording tools in T7b. */
export function createEvidenceToolProvider(): ToolProvider {
  return {
    id: "evidence",
    description: "Kernel evidence tools: structured verdict channel (finish_verdict).",
    createTools: (context) => [
      createFinishVerdictTool({ channel: context.verdict, events: context.events }),
    ],
  };
}
