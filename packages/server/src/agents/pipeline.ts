// Shared agent run pipeline (T7a agent kernel).
//
// Every agent run — regardless of which AgentDefinition is executing — goes
// through the same pipeline:
//   1. resolve the registered AgentDefinition (agents are never hardcoded),
//   2. validate the run input against the definition's inputSchema,
//   3. render the system prompt from the template with the CURRENT env binding
//      only (env-bound injection; other envs are invisible),
//   4. materialize tools from ToolProviders (plus the kernel verdict channel),
//   5. create a FRESH pi Agent session (no cross-run or cross-env memory),
//   6. record events through pi hooks while enforcing the definition's hard
//      limits (maxSteps / tokenBudget / timeoutMs). On breach: stop, preserve
//      all collected evidence, mark the run failed with reason `limit:<kind>`,
//   7. settle through the structured verdict channel: a run succeeds only by
//      recording a schema-valid verdict via `finish_verdict`.

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Models,
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { RunStatus } from "@hpath/contract";
import type { AgentEventSink } from "./events.js";
import { InMemoryEventSink } from "./events.js";
import { RunEvidence } from "./evidence.js";
import type { MutableModels } from "@earendil-works/pi-ai";
import { createCatalogModelResolver, createDefaultModels } from "./model.js";
import { assertSchema } from "./schema.js";
import { renderTemplate } from "./template.js";
import { AgentRegistry } from "./registry.js";
import type { ToolProviderRegistry } from "./tools.js";
import { VerdictChannel, createEvidenceToolProvider } from "./verdict.js";
import type {
  AgentRunFailureReason,
  AgentRunResult,
  EnvBinding,
  ModelResolver,
  Verdict,
} from "./types.js";

export interface RunAgentInput {
  agentId: string;
  input: unknown;
  env: EnvBinding;
  /** Optional externally assigned run id (defaults to a fresh UUID). */
  runId?: string;
  /** Optional sink; defaults to an in-memory sink scoped to this run. */
  sink?: AgentEventSink;
}

export interface AgentKernelOptions {
  agents: AgentRegistry;
  toolProviders: ToolProviderRegistry;
  /** Override the LLM stream function (tests inject scripted models). */
  streamFn?: StreamFn;
  /** Override model resolution (tests inject stub model descriptors). */
  resolveModel?: ModelResolver;
  /** Clock used for timestamps and durations. */
  now?: () => Date;
}

/** Result summary text cap for tool_finished events. */
const SUMMARY_MAX_CHARS = 500;

function summarizeToolResult(content: unknown): string {
  const text = Array.isArray(content)
    ? content
      .filter((block): block is TextContent => block?.type === "text")
      .map((block) => block.text)
      .join("\n")
    : JSON.stringify(content) ?? "";
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
}

function tokensOf(message: AssistantMessage): number {
  const usage = message.usage;
  if (!usage) return 0;
  return (usage.input ?? 0) + (usage.output ?? 0);
}

/**
 * The agent kernel: binds the two registries and executes the shared run
 * pipeline. One kernel instance serves the whole server; each `run()` call is
 * fully isolated.
 */
export class AgentKernel {
  readonly agents: AgentRegistry;
  readonly toolProviders: ToolProviderRegistry;

  private readonly streamFn: StreamFn;
  private readonly resolveModel: ModelResolver;
  private readonly now: () => Date;
  private defaultModels?: MutableModels;

  constructor(options: AgentKernelOptions) {
    this.agents = options.agents;
    this.toolProviders = options.toolProviders;
    this.now = options.now ?? (() => new Date());
    this.resolveModel = options.resolveModel ?? ((modelId) => {
      this.defaultModels ??= createDefaultModels();
      return createCatalogModelResolver(this.defaultModels)(modelId);
    });
    this.streamFn =
      options.streamFn
      ?? ((model, context, streamOptions) => {
        this.defaultModels ??= createDefaultModels();
        return this.defaultModels.streamSimple(model, context, streamOptions);
      });
  }

  /**
   * Run an agent through the shared pipeline. Throws only on caller errors
   * (unknown agent id); every other outcome is reported as a run result.
   */
  async run(options: RunAgentInput): Promise<AgentRunResult> {
    const definition = this.agents.require(options.agentId);
    const runId = options.runId ?? crypto.randomUUID();
    const sink = options.sink ?? new InMemoryEventSink({ runId, now: this.now });
    const startedAt = this.now();

    // Mutable run state. Declared before `settle` so failure paths taken
    // before the agent starts still settle correctly.
    let tokenCost = 0;
    let steps = 0;
    let breach: AgentRunFailureReason | "" = "";
    let errorMessage: string | undefined;
    let promptFailed = false;
    const channel = new VerdictChannel(definition.outputSchema);
    // Declared before `settle` because the early failure paths below settle
    // before the tools (and their run evidence) are materialized.
    const evidence = new RunEvidence();

    const settle = (failReason: AgentRunFailureReason | ""): AgentRunResult => {
      const verdict: Verdict | undefined = channel.isRecorded ? channel.value : undefined;
      let status: RunStatus;
      let reason: AgentRunFailureReason | "";
      if (!breach && verdict !== undefined) {
        // The structured verdict channel is the only success path.
        status = RunStatus.RUN_STATUS_PASSED;
        reason = "";
      } else {
        status = RunStatus.RUN_STATUS_FAILED;
        // Hard-limit breaches override everything; a recorded verdict does
        // not rescue a breached run (its evidence is still attached).
        reason = breach || failReason;
        if (!reason) {
          reason = errorMessage ? "agent_error" : "no_verdict";
        }
      }
      const finishedAt = this.now();
      sink.append({ kind: "run_status", status, reason });
      return {
        runId,
        agentId: definition.id,
        status,
        verdict,
        failReason: reason,
        tokenCost,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        events: sink.events(),
        // Disposal has already run by the time settle is reached, so providers
        // (browser video/trace) have registered their by-products.
        pendingArtifacts: [...evidence.pendingArtifacts],
      };
    };

    // 1. Input validation against the definition's schema.
    try {
      assertSchema(options.input, definition.inputSchema, "run input");
    } catch (err) {
      sink.append({ kind: "error", errorKind: "input_schema", message: (err as Error).message });
      return settle("input_schema");
    }

    // 2. Env-bound system prompt injection (current env only).
    let systemPrompt: string;
    try {
      systemPrompt = renderTemplate(definition.systemPromptTemplate, {
        env: options.env,
        input: options.input,
      });
    } catch (err) {
      sink.append({ kind: "error", errorKind: "template", message: (err as Error).message });
      return settle("template");
    }

    // 3. Model resolution.
    let model;
    try {
      model = this.resolveModel(definition.model);
    } catch (err) {
      sink.append({ kind: "error", errorKind: "model", message: (err as Error).message });
      return settle("agent_error");
    }

    // 4. Tools from ToolProviders + the kernel verdict channel. Run-scoped
    //    resources (the browser provider's Playwright session, ...) register
    //    their cleanup on the run's evidence store.
    // Run-level abort: firing interrupts provider-side in-flight work (fetch,
    // playwright, grpc calls) through ToolContext.signal, so the wall-clock
    // limit stays hard even when a tool call never returns on its own.
    const runAbort = new AbortController();
    const context = {
      runId,
      agentId: definition.id,
      env: options.env,
      input: options.input,
      events: sink,
      verdict: channel,
      evidence,
      signal: runAbort.signal,
    };
    const tools: AgentTool[] = [];
    for (const binding of definition.toolBindings) {
      try {
        tools.push(...this.toolProviders.require(binding).createTools(context));
      } catch (err) {
        sink.append({ kind: "error", errorKind: "tool_provider", message: (err as Error).message });
        return settle("agent_error");
      }
    }
    if (!definition.toolBindings.includes("evidence")) {
      // The structured verdict channel is pipeline machinery: always present
      // unless the definition binds its own evidence provider.
      tools.push(...createEvidenceToolProvider().createTools(context));
    }

    // 5. Fresh agent session — no cross-run or cross-env memory.
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        messages: [],
      },
      streamFn: this.streamFn,
      sessionId: runId,
    });

    agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          sink.append({ kind: "run_status", status: RunStatus.RUN_STATUS_RUNNING, reason: "" });
          break;
        case "tool_execution_start":
          sink.append({
            kind: "tool_started",
            tool: event.toolName,
            argsJson: JSON.stringify(event.args) ?? "",
          });
          break;
        // tool_execution_end fires on EVERY completion path — executed calls,
        // argument-validation failures, unknown tools, aborted/truncated
        // batches — so every tool_started is paired with a tool_finished.
        case "tool_execution_end":
          sink.append({
            kind: "tool_finished",
            tool: event.toolName,
            ok: !event.isError,
            resultSummary: summarizeToolResult(event.result?.content),
          });
          break;
        case "message_end": {
          const message = event.message as AssistantMessage;
          if (message.role !== "assistant") break;
          const text = message.content
            .filter((block): block is TextContent => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (text) sink.append({ kind: "agent_text", text });
          const thinking = message.content
            .filter((block): block is ThinkingContent => block.type === "thinking")
            .map((block) => block.thinking)
            .join("");
          if (thinking) sink.append({ kind: "agent_thinking", text: thinking });
          tokenCost += tokensOf(message);
          if (tokenCost > definition.hardLimits.tokenBudget) {
            breach ||= "limit:token_budget";
            agent.abort();
            runAbort.abort();
          }
          break;
        }
        case "turn_end": {
          // One assistant turn == one step.
          const message = event.message as AssistantMessage;
          if (message.role !== "assistant") break;
          steps += 1;
          // Reaching the cap is legal when the agent used it to submit its
          // verdict; continuing past it without a verdict is a breach.
          if (!channel.isRecorded && steps >= definition.hardLimits.maxSteps) {
            breach ||= "limit:max_steps";
            agent.abort();
            runAbort.abort();
          }
          break;
        }
        case "agent_end":
          if (agent.state.errorMessage) {
            errorMessage = agent.state.errorMessage;
          }
          break;
      }
    });

    // Hard limit: wall clock. Firing aborts the agent AND the run signal (the
    // latter interrupts in-flight tool work); evidence already in the sink is
    // preserved.
    const timer = setTimeout(() => {
      breach ||= "limit:timeout_ms";
      agent.abort();
      runAbort.abort();
    }, definition.hardLimits.timeoutMs);

    try {
      const userMessage = typeof options.input === "string" ? options.input : JSON.stringify(options.input);
      await agent.prompt(userMessage);
    } catch (err) {
      promptFailed = true;
      errorMessage = (err as Error).message;
      sink.append({ kind: "error", errorKind: "agent_error", message: errorMessage });
    } finally {
      clearTimeout(timer);
      // Release stragglers the loop no longer waits for (no-op when a breach
      // already aborted), then release run-scoped resources (browser, pages,
      // ...). Disposal errors never mask the run outcome and evidence already
      // in the sink/channel is preserved.
      runAbort.abort();
      await evidence.dispose();
    }

    // 6. Settle through the structured verdict channel (see `settle`).
    return settle(promptFailed ? "agent_error" : "");
  }
}
