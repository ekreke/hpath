// In-flight run control (PauseRun / ResumeRun / CancelRun).
//
// The kernel registers a controller for every active run and removes it when
// the run settles. RPC handlers look a run up here to pause, resume or cancel
// it — the actual gate/abort machinery lives inside the kernel pipeline, so
// shared orchestration stays in one place. An unknown run id (never started,
// already settled) simply has no entry: handlers translate that into
// FAILED_PRECONDITION ("run is not active").

import { InvalidTransitionError } from "../db/errors.js";

/** Control handle for one active run, implemented by the kernel pipeline. */
export interface RunController {
  /** RUNNING -> PAUSED. Throws InvalidTransitionError otherwise. */
  pause(): void;
  /** PAUSED -> RUNNING. Throws InvalidTransitionError otherwise. */
  resume(): void;
  /** -> CANCELLED (via the kernel's settle path). Idempotent. */
  cancel(): void;
}

/** Registry of controllers for active runs, keyed by run id. */
export class RunControlRegistry {
  private readonly controllers = new Map<string, RunController>();

  register(runId: string, controller: RunController): void {
    this.controllers.set(runId, controller);
  }

  unregister(runId: string): void {
    this.controllers.delete(runId);
  }

  /** The controller of an active run, or undefined when the run is not
   * in-flight (unknown id, already settled). */
  get(runId: string): RunController | undefined {
    return this.controllers.get(runId);
  }
}

export { InvalidTransitionError };
