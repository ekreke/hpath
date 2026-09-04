// Status chat (minimal 1.1 status-agent, pulled forward): free-text questions
// answered by the settings' default multimodal model. The system prompt embeds
// a snapshot of the current system state (projects / cases by status / recent
// runs) so answers reflect live data without tools. Streams ChatResponse text
// deltas; failures surface on the error branch. Each turn is persisted into
// its session (chat_messages) and the most recent history joins the prompt so
// follow-up questions work; the title is derived from the first user message.

import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatResponse } from "@hpath/contract";
import { ChatRole } from "@hpath/contract";
import type { AssistantMessage, MutableModels, UserMessage } from "@earendil-works/pi-ai";
import type { HpathDb } from "./db/index.js";
import {
  createCatalogModelResolver,
  createDefaultModels,
  registerSettingsProviders,
} from "./agents/model.js";
import { CaseStatus } from "@hpath/contract";
import { RunStatus } from "@hpath/contract";
import type { SettingsStore } from "./settings.js";

const CASE_STATUS_LABELS: Record<number, string> = {
  [CaseStatus.CASE_STATUS_UNSPECIFIED]: "unspecified",
  [CaseStatus.CASE_STATUS_DRAFT]: "draft",
  [CaseStatus.CASE_STATUS_PENDING]: "pending review",
  [CaseStatus.CASE_STATUS_APPROVED]: "approved",
  [CaseStatus.CASE_STATUS_DISABLED]: "disabled",
};

const RUN_STATUS_LABELS: Record<number, string> = {
  [RunStatus.RUN_STATUS_UNSPECIFIED]: "unspecified",
  [RunStatus.RUN_STATUS_PENDING]: "pending",
  [RunStatus.RUN_STATUS_RUNNING]: "running",
  [RunStatus.RUN_STATUS_PASSED]: "passed",
  [RunStatus.RUN_STATUS_FAILED]: "failed",
};

/** Human-readable snapshot of the current system state for the system prompt. */
export function buildSystemSnapshot(db: HpathDb): string {
  const lines: string[] = [];
  const projects = db.projects.list();
  lines.push(`Projects (${projects.length}): ${projects.map((p) => p.name).join(", ") || "none"}`);
  for (const project of projects) {
    const envs = db.envs.listByProject(project.id);
    lines.push(`- ${project.name} envs (${envs.length}):`);
    for (const env of envs) {
      const vars = Object.keys(env.vars ?? {}).length;
      lines.push(
        `    ${env.name}: web ${env.webBaseUrl || "n/a"}, grpc ${env.grpcAddress || "n/a"}, ${vars} vars`,
      );
    }
    const cases = db.cases.listByProject(project.id);
    const byStatus = new Map<string, number>();
    for (const kase of cases) {
      const label = CASE_STATUS_LABELS[kase.status] ?? "unknown";
      byStatus.set(label, (byStatus.get(label) ?? 0) + 1);
    }
    lines.push(
      `  cases (${cases.length}): ${[...byStatus.entries()].map(([label, count]) => `${count} ${label}`).join(", ") || "none"}`,
    );
    for (const kase of cases) {
      lines.push(
        `    ${CASE_STATUS_LABELS[kase.status] ?? "unknown"} — ${kase.title}`,
      );
    }
    const runs = db.runs.list({ projectId: project.id }).slice(0, 10);
    if (runs.length > 0) {
      lines.push("  recent runs (newest first):");
      for (const run of runs) {
        const env = db.envs.get(run.envId)?.name ?? run.envId;
        const kase = (() => {
          try {
            return db.cases.getRequired(run.caseId).title;
          } catch {
            return run.caseId;
          }
        })();
        const duration = run.durationMs > 0 ? `${Math.round(run.durationMs / 1000)}s` : "n/a";
        lines.push(
          `    ${run.startedAt} ${RUN_STATUS_LABELS[run.status] ?? run.status} — ${kase} @ ${env} (${duration})`,
        );
      }
    } else {
      lines.push("  recent runs: none");
    }
  }
  return lines.join("\n");
}

const CHAT_SYSTEM_PROMPT = `You are HPath's assistant: a desktop AI-testing platform that reviews PRDs into cases, runs them with browser agents, and records evidence.
Answer questions about the current system state concisely using ONLY the snapshot below; never invent projects, cases, runs, or numbers.
Snapshot format per project: env list (web/grpc endpoints + var count), case count by status followed by one line per case ("<status> — <title>"), and up to 10 recent runs ("<ISO time> <status> — <case> @ <env> (<duration>)", newest first).
If the snapshot does not contain the answer, say what is missing. Reply in the language of the user's question.

Current system snapshot:
`;

/** Rough upward token estimate (~4 chars/token) so clients can show a live
 * prompt size before the provider reports exact usage at stream end. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** How many past turns (user + assistant) join the prompt for follow-ups. */
const CHAT_HISTORY_MESSAGES = 10;

/** Session titles derive from the first user question, truncated for display. */
function deriveTitle(message: string): string {
  return message.length > 40 ? `${message.slice(0, 40)}…` : message;
}

/** Shape a persisted turn as a pi-ai context message for history replay.
 * Assistant placeholders carry neutral bookkeeping fields — only the text
 * matters for prompting; usage/api values are never surfaced to the model. */
function toContextMessage(message: ChatMessage): UserMessage | AssistantMessage {
  const timestamp = Date.parse(message.createdAt) || Date.now();
  if (message.role === ChatRole.CHAT_ROLE_USER) {
    return {
      role: "user",
      content: [{ type: "text", text: message.content }],
      timestamp,
    };
  }
  const input = Number(message.inputTokens);
  const output = Number(message.outputTokens);
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "openai-completions",
    provider: "hpath-history",
    model: message.model || "unknown",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: message.costTotal },
    },
    stopReason: "stop",
    timestamp,
  };
}

/** Resolves the runtime pieces once per server; injectable for tests. */
export class ChatService {
  private models?: MutableModels;

  constructor(
    private readonly db: HpathDb,
    private readonly settings: SettingsStore,
    private readonly modelsFactory: () => MutableModels = createDefaultModels,
  ) {}

  /**
   * Stream one chat turn as ChatResponse events. The turn is attributed to
   * `sessionId`: the user message lands before streaming and the assistant
   * answer (with usage) after it, so a session survives reloads. The session's
   * most recent history joins the prompt for follow-ups. The settings provider
   * set is (re-)registered before resolving so a just-updated settings file
   * applies without a server restart.
   */
  async *respond(sessionId: string, message: string): AsyncGenerator<ChatResponse> {
    const trimmed = message.trim();
    if (!sessionId) {
      yield { error: "session_id is required" };
      return;
    }
    if (!trimmed) {
      yield { error: "message is empty" };
      return;
    }
    let modelId: string;
    try {
      this.models ??= this.modelsFactory();
      registerSettingsProviders(this.models, this.settings.get());
      modelId = this.settings.resolveDefaultModel().model.id;
    } catch (err) {
      yield { error: `chat is not configured: ${err instanceof Error ? err.message : String(err)}` };
      return;
    }

    const nowIso = () => new Date().toISOString();

    // Persist the user turn up front; an unknown session fails here (foreign
    // key) and surfaces as a stream error. touch() also adopts the derived
    // title while the session is still unnamed.
    this.db.chatMessages.insert({
      id: randomUUID(),
      sessionId,
      role: ChatRole.CHAT_ROLE_USER,
      content: trimmed,
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      costTotal: 0,
      createdAt: nowIso(),
    });
    this.db.chatSessions.touch(sessionId, nowIso(), deriveTitle(trimmed));

    // Replay the most recent history (minus the just-inserted question) so
    // follow-up questions see their context.
    const history = this.db.chatMessages
      .listBySession(sessionId)
      .slice(-CHAT_HISTORY_MESSAGES - 1, -1)
      .filter((m) => m.content.trim() !== "")
      .map(toContextMessage);

    const snapshot = buildSystemSnapshot(this.db);
    yield {
      status: {
        model: modelId,
        promptTokensEst: estimateTokens(CHAT_SYSTEM_PROMPT + snapshot + trimmed),
      },
    };

    const context = {
      systemPrompt: CHAT_SYSTEM_PROMPT + snapshot,
      messages: [
        ...history,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: trimmed }],
          timestamp: Date.now(),
        },
      ],
    };

    let answer = "";
    const persistAnswer = (usage?: { input: number; output: number; cost: number }): void => {
      if (!answer.trim()) return;
      this.db.chatMessages.insert({
        id: randomUUID(),
        sessionId,
        role: ChatRole.CHAT_ROLE_ASSISTANT,
        content: answer,
        model: modelId,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        costTotal: usage?.cost ?? 0,
        createdAt: nowIso(),
      });
      this.db.chatSessions.touch(sessionId, nowIso());
    };

    try {
      const model = createCatalogModelResolver(this.models)(modelId);
      const stream = this.models.streamSimple(model, context);
      for await (const event of stream) {
        if (event.type === "text_delta") {
          answer += event.delta;
          yield { textDelta: event.delta };
        } else if (event.type === "error") {
          const reason = event.error?.errorMessage ?? "model stream failed";
          persistAnswer();
          yield { error: reason };
          return;
        } else if (event.type === "done") {
          const usage = event.message?.usage;
          persistAnswer(
            usage
              ? { input: usage.input, output: usage.output, cost: usage.cost?.total ?? 0 }
              : undefined,
          );
          if (usage) {
            yield {
              usage: {
                inputTokens: usage.input,
                outputTokens: usage.output,
                costTotal: usage.cost?.total ?? 0,
              },
            };
          }
          return;
        }
      }
    } catch (err) {
      persistAnswer();
      yield { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
