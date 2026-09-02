// Run repository (T5): CRUD over the runs table. The composite foreign keys
// on (env_id, project_id) and (case_id, project_id) enforce the run namespace
// at the database level: an env or case from another project is rejected.

import type { DatabaseSync } from "node:sqlite";
import type { Run, Verdict } from "@hpath/contract";
import { RunStatus } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

interface RunRow {
  id: string;
  project_id: string;
  env_id: string;
  case_id: string;
  status: number;
  trigger_kind: number;
  verdict_json: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  token_cost: number;
  fail_reason: string;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    envId: row.env_id,
    caseId: row.case_id,
    status: row.status as RunStatus,
    trigger: row.trigger_kind as Run["trigger"],
    verdict: row.verdict_json
      ? (JSON.parse(row.verdict_json) as Verdict)
      : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    tokenCost: row.token_cost,
    failReason: row.fail_reason,
  };
}

/** Filters for list(); empty/undefined fields are ignored, mirroring the RPC. */
export interface RunFilter {
  projectId: string;
  envId?: string;
  caseId?: string;
  status?: RunStatus;
  /** ISO-8601 lower bound on started_at (inclusive). */
  from?: string;
  /** ISO-8601 upper bound on started_at (inclusive). */
  to?: string;
}

/** Terminal-state patch applied when a run finishes. */
export interface RunFinishPatch {
  status: RunStatus;
  verdict?: Verdict;
  finishedAt: string;
  durationMs: number;
  tokenCost: number;
  failReason?: string;
}

export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert a run. Rejected with ForeignKeyError when the project, env or case
   * is unknown — or when env/case belong to a different project than the run.
   */
  create(run: Run): Run {
    try {
      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, env_id, case_id, status, trigger_kind,
                             verdict_json, started_at, finished_at, duration_ms, token_cost, fail_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.projectId,
          run.envId,
          run.caseId,
          run.status,
          run.trigger,
          run.verdict ? JSON.stringify(run.verdict) : null,
          run.startedAt,
          run.finishedAt,
          run.durationMs,
          run.tokenCost,
          run.failReason,
        );
    } catch (err) {
      throw translateConstraintError(err, `create run ${run.id}`);
    }
    return run;
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row as unknown as RunRow) : undefined;
  }

  getRequired(id: string): Run {
    const run = this.get(id);
    if (!run) {
      throw new NotFoundError(`run not found: ${id}`);
    }
    return run;
  }

  /**
   * Move a run to a terminal state (or update in place): status, verdict,
   * timing, token cost and fail reason.
   */
  finish(id: string, patch: RunFinishPatch): Run {
    const info = this.db
      .prepare(
        `UPDATE runs
         SET status = ?, verdict_json = ?, finished_at = ?, duration_ms = ?, token_cost = ?, fail_reason = ?
         WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.verdict ? JSON.stringify(patch.verdict) : null,
        patch.finishedAt,
        patch.durationMs,
        patch.tokenCost,
        patch.failReason ?? "",
        id,
      );
    if (Number(info.changes) === 0) {
      throw new NotFoundError(`run not found: ${id}`);
    }
    return this.getRequired(id);
  }

  /** Run history for filters, most recent first. */
  list(filter: RunFilter): Run[] {
    const conditions: string[] = ["project_id = ?"];
    const params: (string | number)[] = [filter.projectId];
    if (filter.envId) {
      conditions.push("env_id = ?");
      params.push(filter.envId);
    }
    if (filter.caseId) {
      conditions.push("case_id = ?");
      params.push(filter.caseId);
    }
    if (filter.status !== undefined && filter.status !== RunStatus.RUN_STATUS_UNSPECIFIED) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.from) {
      conditions.push("started_at >= ?");
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push("started_at <= ?");
      params.push(filter.to);
    }
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE ${conditions.join(" AND ")} ORDER BY started_at DESC, id`)
      .all(...params);
    return rows.map((row) => toRun(row as unknown as RunRow));
  }
}
