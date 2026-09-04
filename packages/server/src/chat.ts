// Status chat (minimal 1.1 status-agent, pulled forward): free-text questions
// answered by the settings' default multimodal model. The system prompt embeds
// a snapshot of the current system state (projects / cases by status / recent
// runs) so answers reflect live data without tools. Streams ChatResponse text
// deltas; failures surface on the error branch. Chat turns are not persisted
// in 1.0 — the desktop keeps the transcript in view state.

import type { ChatResponse } from "@hpath/contract";
import type { MutableModels } from "@earendil-works/pi-ai";
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

/** Resolves the runtime pieces once per server; injectable for tests. */
export class ChatService {
  private models?: MutableModels;

  constructor(
    private readonly db: HpathDb,
    private readonly settings: SettingsStore,
    private readonly modelsFactory: () => MutableModels = createDefaultModels,
  ) {}

  /**
   * Stream one chat turn as ChatResponse events. The settings provider set is
   * (re-)registered before resolving so a just-updated settings file applies
   * without a server restart.
   */
  async *respond(message: string): AsyncGenerator<ChatResponse> {
    const trimmed = message.trim();
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

    const context = {
      systemPrompt: CHAT_SYSTEM_PROMPT + buildSystemSnapshot(this.db),
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: trimmed }],
          timestamp: Date.now(),
        },
      ],
    };

    try {
      const model = createCatalogModelResolver(this.models)(modelId);
      const stream = this.models.streamSimple(model, context);
      for await (const event of stream) {
        if (event.type === "text_delta") {
          yield { textDelta: event.delta };
        } else if (event.type === "error") {
          const reason = event.error?.errorMessage ?? "model stream failed";
          yield { error: reason };
          return;
        } else if (event.type === "done") {
          return;
        }
      }
    } catch (err) {
      yield { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
