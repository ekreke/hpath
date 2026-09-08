// Live-view frame hub (T21): the ephemeral broadcast channel between the
// browser provider's CDP screencast (or the mock's synthetic frames) and the
// WatchRun gRPC stream(s).
//
// Frames are never run evidence: nothing here touches SQLite or the artifact
// store. The hub only lives for the duration of one run — it is created by the
// RunCase handler, looked up by runId from the WatchRun handler, and closed
// when the run settles (its streams then end).
//
// Backpressure model: latest-wins per subscriber. A slow observer holds at
// most one undelivered frame; a newer publish replaces it, so memory stays
// bounded and observers always converge on the newest page state. A
// min-interval throttle with a trailing flush keeps the client-side frame rate
// bounded while still guaranteeing the final state of a burst is delivered.

export interface RunFrameMessage {
  seq: number;
  mime: string;
  data: Uint8Array;
  timestampMs: number;
}

export interface RunFrameHubOptions {
  runId: string;
  /** Minimum interval between accepted frames in ms (0 disables the throttle). Default 100. */
  minIntervalMs?: number;
  /** Clock for frame timestamps and throttle windows; injectable for tests. */
  now?: () => number;
}

export interface RunFrameSubscription {
  /**
   * Resolves with the next frame, or undefined once the hub has closed (or the
   * subscription ended) and any buffered frame has been delivered. One
   * consumer loop per subscription: do not call next() concurrently.
   */
  next(): Promise<RunFrameMessage | undefined>;
  /** Stop receiving frames; an in-flight next() drains the buffer then ends. */
  unsubscribe(): void;
}

/** Per-subscriber mailbox: at most one pending frame, newest wins. */
class Subscription implements RunFrameSubscription {
  private buffer?: RunFrameMessage;
  private detached = false;
  private readonly waiters: Array<(frame: RunFrameMessage | undefined) => void> = [];

  constructor(private readonly hub: RunFrameHub) {}

  push(frame: RunFrameMessage): void {
    if (this.detached) return;
    this.buffer = frame;
    this.wake();
  }

  end(): void {
    this.detached = true;
    this.wake();
  }

  async next(): Promise<RunFrameMessage | undefined> {
    if (this.buffer) {
      const frame = this.buffer;
      this.buffer = undefined;
      return frame;
    }
    if (this.detached) return undefined;
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  unsubscribe(): void {
    this.detached = true;
    this.hub.remove(this);
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) {
      if (this.buffer) {
        const frame = this.buffer;
        this.buffer = undefined;
        resolve(frame);
      } else {
        resolve(undefined);
      }
    }
  }
}

export class RunFrameHub {
  readonly runId: string;

  private closed = false;
  private nextSeq = 1;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly subscriptions = new Set<Subscription>();
  private trailing?: { data: Uint8Array; mime: string };
  private trailingTimer?: ReturnType<typeof setTimeout>;

  /** Fired on every new subscribe. The browser provider assigns this to push
   * an immediate captureScreenshot snapshot, so a fresh observer sees the
   * current page without waiting for the next repaint. */
  onSubscribe?: () => void;

  constructor(options: RunFrameHubOptions) {
    this.runId = options.runId;
    this.minIntervalMs = options.minIntervalMs ?? 100;
    this.now = options.now ?? (() => Date.now());
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Publish one encoded frame to all subscribers. Dropped (returns undefined)
   * when the hub is closed, the frame is empty, or the throttle window has not
   * elapsed — in the throttled case the frame is kept as the trailing update
   * and flushed at the end of the window, so the newest state is never lost.
   * Returns the assigned seq when the frame was fanned out.
   */
  publish(data: Uint8Array, mime = "image/jpeg"): number | undefined {
    if (this.closed || data.byteLength === 0) return undefined;
    const at = this.now();
    const elapsed = at - this.lastAcceptedAt;
    if (this.minIntervalMs > 0 && elapsed < this.minIntervalMs) {
      this.trailing = { data, mime };
      this.scheduleTrailingFlush(this.minIntervalMs - elapsed);
      return undefined;
    }
    return this.emit(data, mime, at);
  }

  subscribe(): RunFrameSubscription {
    const subscription = new Subscription(this);
    this.subscriptions.add(subscription);
    this.onSubscribe?.();
    return subscription;
  }

  /** Close the hub: publishes are ignored, subscribers drain then end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.trailingTimer !== undefined) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = undefined;
    }
    this.trailing = undefined;
    for (const subscription of [...this.subscriptions]) {
      subscription.end();
    }
  }

  remove(subscription: Subscription): void {
    this.subscriptions.delete(subscription);
  }

  private emit(data: Uint8Array, mime: string, at: number): number {
    this.lastAcceptedAt = at;
    this.trailing = undefined;
    const frame: RunFrameMessage = {
      seq: this.nextSeq++,
      mime,
      data,
      timestampMs: at,
    };
    for (const subscription of [...this.subscriptions]) {
      subscription.push(frame);
    }
    return frame.seq;
  }

  private scheduleTrailingFlush(delayMs: number): void {
    if (this.trailingTimer !== undefined) return; // already pending; trailing replaced
    const timer = setTimeout(() => {
      this.trailingTimer = undefined;
      if (this.closed || !this.trailing) return;
      const trailing = this.trailing;
      this.emit(trailing.data, trailing.mime, this.now());
    }, delayMs);
    // A pending flush must not keep the server process alive on shutdown.
    timer.unref?.();
  }
}

/** Registry of in-flight run frame hubs: the RunCase handler creates the hub
 * for its run, the WatchRun handler looks it up by run id. Mirrors the
 * kernel's runControl registry pattern. */
export class RunFrameHubRegistry {
  private readonly hubs = new Map<string, RunFrameHub>();

  /** Create (or replace) the hub for a run. A replaced hub is closed so its
   * subscribers end instead of leaking. */
  create(runId: string, options?: Omit<RunFrameHubOptions, "runId">): RunFrameHub {
    this.hubs.get(runId)?.close();
    const hub = new RunFrameHub({ runId, ...options });
    this.hubs.set(runId, hub);
    return hub;
  }

  get(runId: string): RunFrameHub | undefined {
    return this.hubs.get(runId);
  }

  remove(runId: string): void {
    this.hubs.delete(runId);
  }
}
