// Test helpers: scripted LLM stream functions and stub definitions for the
// agent kernel pipeline tests. No network, no API keys.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type { AgentDefinition, EnvBinding } from "../../src/agents/index.js";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Stub model descriptor; only the fields the kernel touches are meaningful. */
export const STUB_MODEL: Model<"openai-completions"> = {
  id: "stub-model",
  name: "Stub Model",
  api: "openai-completions",
  provider: "stub",
  baseUrl: "http://localhost:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 1_000_000,
};

export const STUB_ENV: EnvBinding = {
  projectId: "proj-1",
  envId: "env-dev",
  name: "dev",
  baseUrl: "http://dev.example.test",
  variables: { token: "dev-secret" },
};

let callCounter = 0;

export function assistantTextMessage(text: string, usage: Usage = ZERO_USAGE): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "stub",
    model: STUB_MODEL.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function assistantToolCallMessage(
  toolName: string,
  args: Record<string, unknown>,
  usage: Usage = ZERO_USAGE,
): AssistantMessage {
  callCounter += 1;
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call_${callCounter}`, name: toolName, arguments: args }],
    api: "openai-completions",
    provider: "stub",
    model: STUB_MODEL.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

export interface StreamCallRecord {
  systemPrompt: string;
  /** Message roles the model saw for this call (fresh-session assertions). */
  roles: string[];
  messages: Context["messages"];
}

type Script = (context: Context, call: number) => AssistantMessage | Promise<AssistantMessage>;

/**
 * A StreamFn driven by a script; records each call so tests can assert on
 * env-bound injection (systemPrompt) and session isolation (message counts).
 *
 * Honors the abort signal like real providers do: an aborted request yields
 * an "aborted" stream so kernel limit breaches actually stop the loop.
 */
export function scriptedStreamFn(script: Script, calls?: StreamCallRecord[]): StreamFn {
  let call = 0;
  return async (_model, context, options) => {
    if (options?.signal?.aborted) {
      return abortedStream();
    }
    call += 1;
    calls?.push({
      systemPrompt: context.systemPrompt ?? "",
      roles: context.messages.map((message) => message.role),
      messages: context.messages,
    });
    const message = await script(context, call);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred",
        message,
      });
    }
    return stream;
  };
}

/** A streamFn that hangs until aborted, then reports the abort (timeout test). */
export function hangingStreamFn(): StreamFn {
  return (_model, _context, options) =>
    new Promise((resolve) => {
      const signal = options?.signal;
      if (signal?.aborted) {
        resolve(abortedStream());
        return;
      }
      signal?.addEventListener("abort", () => resolve(abortedStream()), { once: true });
    });
}

function abortedStream(): AssistantMessageEventStream {
  const message: AssistantMessage = {
    ...assistantTextMessage(""),
    stopReason: "aborted",
    errorMessage: "aborted by signal",
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "aborted", error: message });
  return stream;
}

/** Minimal stub definition, per-test overrides via `overrides`. */
export function stubDefinition(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    id: "stub-agent",
    role: "pipeline test stub",
    systemPromptTemplate:
      "You test {{env.name}} at {{env.baseUrl}} for case {{input.goal}}. Token: {{env.variables.token}}.",
    toolBindings: [],
    model: STUB_MODEL.id,
    hardLimits: { maxSteps: 5, tokenBudget: 100_000, timeoutMs: 5_000 },
    inputSchema: {
      type: "object",
      required: ["goal"],
      properties: { goal: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["status", "summary"],
      properties: {
        status: { enum: ["pass", "fail"] },
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
    ...overrides,
  };
}

export const VALID_VERDICT = { status: "pass", summary: "all good" };
