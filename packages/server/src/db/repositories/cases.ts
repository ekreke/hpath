// Case repository (T5): CRUD + review workflow over the cases table, with
// alignments and changelog as child tables. Mirrors the mock handler's
// transition rules so T3+ wiring behaves identically to mock mode.

import type { DatabaseSync } from "node:sqlite";
import type { Alignment, Case, ChangeLogEntry, Creator } from "@hpath/contract";
import { CaseStatus, CreatorType, ReviewAction } from "@hpath/contract";
import { withTransaction } from "../database.js";
import {
  ConflictError,
  ForeignKeyError,
  InvalidTransitionError,
  NotFoundError,
  translateConstraintError,
} from "../errors.js";

interface CaseRow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  creator_type: number;
  creator_name: string;
  creator_run_ref: string;
  status: number;
  source_prd_ref: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AlignmentRow {
  case_id: string;
  idx: number;
  api_path: string;
  ui_anchor: string;
  rule: string;
}

interface ChangelogRow {
  case_id: string;
  version: number;
  author: string;
  comment: string;
  changed_at: string;
}

function toCreator(row: CaseRow): Creator {
  return {
    type: row.creator_type as Creator["type"],
    name: row.creator_name,
    runRef: row.creator_run_ref,
  };
}

function toAlignment(row: AlignmentRow): Alignment {
  return {
    apiPath: row.api_path,
    uiAnchor: row.ui_anchor,
    rule: row.rule,
  };
}

function toChangelogEntry(row: ChangelogRow): ChangeLogEntry {
  return {
    version: row.version,
    author: row.author,
    comment: row.comment,
    changedAt: row.changed_at,
  };
}

/** Review transitions: action -> allowed source statuses and target status. */
const TRANSITIONS: Partial<Record<ReviewAction, { from: CaseStatus[]; to: CaseStatus }>> = {
  [ReviewAction.REVIEW_ACTION_APPROVE]: {
    from: [
      CaseStatus.CASE_STATUS_DRAFT,
      CaseStatus.CASE_STATUS_PENDING,
      CaseStatus.CASE_STATUS_DISABLED,
    ],
    to: CaseStatus.CASE_STATUS_APPROVED,
  },
  [ReviewAction.REVIEW_ACTION_REJECT]: {
    from: [CaseStatus.CASE_STATUS_PENDING],
    to: CaseStatus.CASE_STATUS_DRAFT,
  },
  [ReviewAction.REVIEW_ACTION_DISABLE]: {
    from: [CaseStatus.CASE_STATUS_APPROVED],
    to: CaseStatus.CASE_STATUS_DISABLED,
  },
};

export class CaseRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert a fully-formed case together with its alignments and changelog,
   * in one transaction.
   */
  create(kase: Case): Case {
    try {
      withTransaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO cases (id, project_id, title, goal, creator_type, creator_name,
                                creator_run_ref, status, source_prd_ref, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            kase.id,
            kase.projectId,
            kase.title,
            kase.goal,
            kase.creator?.type ?? CreatorType.CREATOR_TYPE_UNSPECIFIED,
            kase.creator?.name ?? "",
            kase.creator?.runRef ?? "",
            kase.status,
            kase.sourcePrdRef,
            kase.version,
            kase.createdAt,
            kase.updatedAt,
          );
        const insertAlignment = this.db.prepare(
          `INSERT INTO case_alignments (case_id, idx, api_path, ui_anchor, rule)
           VALUES (?, ?, ?, ?, ?)`,
        );
        (kase.alignments ?? []).forEach((alignment, idx) => {
          insertAlignment.run(kase.id, idx, alignment.apiPath, alignment.uiAnchor, alignment.rule);
        });
        const insertEntry = this.db.prepare(
          `INSERT INTO case_changelog (case_id, version, author, comment, changed_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        (kase.changelog ?? []).forEach((entry) => {
          insertEntry.run(kase.id, entry.version, entry.author, entry.comment, entry.changedAt);
        });
      });
    } catch (err) {
      throw translateConstraintError(err, `create case "${kase.title}"`);
    }
    return kase;
  }

  get(id: string): Case | undefined {
    const row = this.db.prepare("SELECT * FROM cases WHERE id = ?").get(id);
    if (!row) {
      return undefined;
    }
    const caseRow = row as unknown as CaseRow;
    const alignments = this.db
      .prepare("SELECT * FROM case_alignments WHERE case_id = ? ORDER BY idx")
      .all(id)
      .map((r) => toAlignment(r as unknown as AlignmentRow));
    const changelog = this.db
      .prepare("SELECT * FROM case_changelog WHERE case_id = ? ORDER BY version")
      .all(id)
      .map((r) => toChangelogEntry(r as unknown as ChangelogRow));
    return {
      id: caseRow.id,
      projectId: caseRow.project_id,
      title: caseRow.title,
      goal: caseRow.goal,
      alignments,
      creator: toCreator(caseRow),
      status: caseRow.status as CaseStatus,
      sourcePrdRef: caseRow.source_prd_ref,
      version: caseRow.version,
      changelog,
      createdAt: caseRow.created_at,
      updatedAt: caseRow.updated_at,
    };
  }

  getRequired(id: string): Case {
    const kase = this.get(id);
    if (!kase) {
      throw new NotFoundError(`case not found: ${id}`);
    }
    return kase;
  }

  /** Cases of one project, optionally filtered by review status. */
  listByProject(projectId: string, status?: CaseStatus): Case[] {
    const filterByStatus =
      status !== undefined && status !== CaseStatus.CASE_STATUS_UNSPECIFIED;
    const rows = filterByStatus
      ? this.db
          .prepare("SELECT id FROM cases WHERE project_id = ? AND status = ? ORDER BY created_at, id")
          .all(projectId, status)
      : this.db
          .prepare("SELECT id FROM cases WHERE project_id = ? ORDER BY created_at, id")
          .all(projectId);
    // Alignments/changelog per case need their own queries; hydrate via get().
    return rows.map((row) => this.getRequired(String(row.id)));
  }

  /**
   * Apply a review transition (approve/reject/disable). Bumps the version and
   * appends a changelog entry, in one transaction. Throws NotFoundError for
   * unknown cases and InvalidTransitionError for illegal source statuses.
   */
  review(
    id: string,
    action: ReviewAction,
    options?: { author?: string; comment?: string },
  ): Case {
    const kase = this.getRequired(id);
    const transition = TRANSITIONS[action];
    if (!transition) {
      throw new InvalidTransitionError(
        `review action is required (got ${ReviewAction[action] ?? action})`,
      );
    }
    if (!transition.from.includes(kase.status)) {
      throw new InvalidTransitionError(
        `cannot ${ReviewAction[action]?.toLowerCase() ?? action} a case in status ${CaseStatus[kase.status]}`,
      );
    }
    const version = kase.version + 1;
    const changedAt = new Date().toISOString();
    try {
      withTransaction(this.db, () => {
        this.db
          .prepare("UPDATE cases SET status = ?, version = ?, updated_at = ? WHERE id = ?")
          .run(transition.to, version, changedAt, id);
        this.db
          .prepare(
            `INSERT INTO case_changelog (case_id, version, author, comment, changed_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            version,
            options?.author ?? "reviewer",
            options?.comment && options.comment !== ""
              ? options.comment
              : `${ReviewAction[action] ?? "review"} via review`,
            changedAt,
          );
      });
    } catch (err) {
      throw translateConstraintError(err, `review case ${id}`);
    }
    return this.getRequired(id);
  }

  /**
   * Delete a case. Throws NotFoundError for unknown ids and ConflictError when
   * runs reference the case: run history must keep pointing at a valid case
   * definition.
   */
  delete(id: string): void {
    let info;
    try {
      // Alignments and changelog entries go with the case (ON DELETE CASCADE).
      info = this.db.prepare("DELETE FROM cases WHERE id = ?").run(id);
    } catch (err) {
      const translated = translateConstraintError(err, `delete case ${id}`);
      if (translated instanceof ForeignKeyError) {
        throw new ConflictError(`case has runs and cannot be deleted: ${id}`);
      }
      throw translated;
    }
    if (Number(info.changes) === 0) {
      throw new NotFoundError(`case not found: ${id}`);
    }
  }
}
