// Per-run evidence collection (T7b).
//
// `RunEvidence` is the run-scoped store behind the kernel `record_evidence`
// tool and the disposal point for run-scoped resources (the browser provider
// registers its Playwright cleanup here). Evidence recorded through it is
// preserved even when the run later fails or hits a hard limit — the pipeline
// disposes resources only after the agent loop has stopped, and never lets a
// disposal error mask the run outcome.

import type { Verdict } from "./types.js";

export type CleanupFn = () => Promise<void> | void;

export class RunEvidence {
  /** Structured observations recorded via `record_evidence`, in order. */
  readonly entries: Verdict[] = [];

  private readonly cleanups: CleanupFn[] = [];
  private disposed = false;

  /** Record one structured evidence observation. */
  record(entry: Verdict): void {
    this.entries.push(entry);
  }

  /** Register a run-scoped cleanup (idempotent cleanups are fine). */
  registerCleanup(fn: CleanupFn): void {
    this.cleanups.push(fn);
  }

  /**
   * Run registered cleanups in reverse registration order. Errors are
   * swallowed: cleanup must never mask the run outcome.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const fn of [...this.cleanups].reverse()) {
      try {
        await fn();
      } catch {
        // Swallowed deliberately (see module comment).
      }
    }
    this.cleanups.length = 0;
  }
}
