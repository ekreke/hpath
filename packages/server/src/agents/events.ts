// Run event recording. Every agent run streams events through the same pipe;
// callers persist/stream them (T8 wires the SQLite + gRPC transport).

import type { AgentRunEvent, AgentRunEventPayload } from "./types.js";

export interface AgentEventSink {
  /** Record one event. Implementations assign seq and timestamp. */
  append(payload: AgentRunEventPayload): void;
  /** Events appended so far, in order. */
  events(): AgentRunEvent[];
}

export interface EventSinkOptions {
  runId: string;
  /** Clock for event timestamps; defaults to the system clock. */
  now?: () => Date;
}

/** Simple in-memory sink; also the default for pipeline runs. */
export class InMemoryEventSink implements AgentEventSink {
  readonly runId: string;

  private readonly collected: AgentRunEvent[] = [];
  private nextSeq = 1;
  private readonly now: () => Date;

  constructor(options: EventSinkOptions) {
    this.runId = options.runId;
    this.now = options.now ?? (() => new Date());
  }

  append(payload: AgentRunEventPayload): void {
    this.collected.push({
      runId: this.runId,
      seq: this.nextSeq++,
      timestamp: this.now().toISOString(),
      payload,
    });
  }

  events(): AgentRunEvent[] {
    return [...this.collected];
  }
}

/** Fan-out sink for callers that both collect and forward events. */
export class CompositeEventSink implements AgentEventSink {
  constructor(private readonly sinks: AgentEventSink[]) {}

  append(payload: AgentRunEventPayload): void {
    for (const sink of this.sinks) {
      sink.append(payload);
    }
  }

  events(): AgentRunEvent[] {
    return this.sinks[0]?.events() ?? [];
  }
}
