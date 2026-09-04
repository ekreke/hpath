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

/** A binary by-product a run leaves on local disk (e.g. Playwright video or
 * Playwright trace zip). The T8 wiring uploads these to the artifact store
 * after the run settles — video/trace files are only complete once the
 * browser context has closed. */
export interface PendingRunArtifact {
  /** Absolute path of the file on local disk. */
  path: string;
  /** ArtifactKind enum value from the contract (proto int). */
  kind: number;
  /** Object name under the run's artifact key namespace. */
  name: string;
  /** Directory to remove after upload (shared temp dir, e.g. video + trace). */
  cleanupDir?: string;
}

export class RunEvidence {
  /** Structured observations recorded via `record_evidence`, in order. */
  readonly entries: Verdict[] = [];
  /** Binary by-products produced this run, in registration order. */
  readonly pendingArtifacts: PendingRunArtifact[] = [];

  private readonly cleanups: CleanupFn[] = [];
  private disposed = false;

  /** Record one structured evidence observation. */
  record(entry: Verdict): void {
    this.entries.push(entry);
  }

  /** Register a binary by-product (video/trace/...) produced later on disk. */
  registerArtifact(artifact: PendingRunArtifact): void {
    this.pendingArtifacts.push(artifact);
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
