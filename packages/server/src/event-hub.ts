export interface StreamEvent {
  readonly cursor: number;
  readonly kind: string;
  readonly detail: string;
  readonly atMs: number;
}

/**
 * Resumable fan-out for dashboard clients.
 *
 * Cursors start at the boot timestamp, so they keep increasing across daemon restarts. A tab that
 * reconnects with a cursor from before a restart is therefore sent everything since, instead of
 * silently waiting for the new process to count past its old position.
 */
export class EventHub {
  private cursorSeq: number;
  private readonly history: StreamEvent[] = [];
  private readonly subscribers = new Set<(event: StreamEvent) => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly capacity = 500,
  ) {
    this.cursorSeq = now();
  }

  get cursor(): number {
    return this.cursorSeq;
  }

  /** Oldest cursor still replayable. A client behind this must reload full state. */
  get oldestCursor(): number {
    return this.history[0]?.cursor ?? this.cursorSeq;
  }

  publish(kind: string, detail: string): StreamEvent {
    const event: StreamEvent = { cursor: ++this.cursorSeq, kind, detail, atMs: this.now() };
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A closed stream must not stop delivery to the others.
      }
    }
    return event;
  }

  replayAfter(cursor: number): ReadonlyArray<StreamEvent> {
    return this.history.filter((event) => event.cursor > cursor);
  }

  subscribe(subscriber: (event: StreamEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
