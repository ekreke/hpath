// Event repository (T5): append-only run event log. The oneof payload of each
// event is stored as a JSON document; run_id/seq/timestamp are proper columns
// so ordering and per-run queries stay index-backed.

import type { DatabaseSync } from "node:sqlite";
import type { Event } from "@hpath/contract";
import { NotFoundError, translateConstraintError } from "../errors.js";

interface EventRow {
  run_id: string;
  seq: number;
  timestamp: string;
  payload_json: string;
}

function toEvent(row: EventRow): Event {
  const payload = JSON.parse(row.payload_json) as Partial<Event>;
  return {
    runId: row.run_id,
    seq: row.seq,
    timestamp: row.timestamp,
    ...payload,
  };
}

export class EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Append one event. Rejected with ForeignKeyError for unknown runs. */
  append(event: Event): Event {
    const { runId, seq, timestamp, ...payload } = event;
    try {
      this.db
        .prepare(
          "INSERT INTO events (run_id, seq, timestamp, payload_json) VALUES (?, ?, ?, ?)",
        )
        .run(runId, seq, timestamp, JSON.stringify(payload));
    } catch (err) {
      throw translateConstraintError(err, `append event ${seq} to run ${runId}`);
    }
    return event;
  }

  /** All events of a run, ordered by seq. */
  listForRun(runId: string): Event[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId);
    return rows.map((row) => toEvent(row as unknown as EventRow));
  }

  /**
   * Delete all events of a run (rarely used: cleanup of cancelled runs that
   * never produced evidence). Throws NotFoundError for unknown runs.
   */
  deleteForRun(runId: string): void {
    const info = this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
    if (Number(info.changes) === 0) {
      // Distinguish "run missing" from "run without events".
      const run = this.db.prepare("SELECT id FROM runs WHERE id = ?").get(runId);
      if (!run) {
        throw new NotFoundError(`run not found: ${runId}`);
      }
    }
  }
}
