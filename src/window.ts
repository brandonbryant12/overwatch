/**
 * "Since it last checked" planning. Pure: no clock, no I/O.
 *
 * A watcher never queries a fixed recent window. It starts at its checkpoint (minus a small overlap that
 * de-duplication absorbs), or `initial` back for a brand-new watcher, never further back than `max`, and walks
 * long gaps in slices, oldest first. The checkpoint only advances past a slice that succeeded.
 */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

export interface WindowPlan {
  readonly windows: ReadonlyArray<TimeWindow>;
  /** Set when the lookback cap cut coverage short: nothing between `requestedFrom` and `coveredFrom` is checked. */
  readonly truncated?: { readonly requestedFrom: number; readonly coveredFrom: number };
}

export interface WindowInput {
  readonly now: number;
  /** End of the last successfully checked window, if any. */
  readonly checkpoint?: number;
  readonly initialMs: number;
  readonly maxMs: number;
  readonly overlapMs: number;
  readonly sliceMs: number;
}

export function planWindows(input: WindowInput): WindowPlan {
  const { now, checkpoint, initialMs, maxMs, overlapMs, sliceMs } = input;
  const requestedFrom = checkpoint === undefined ? now - initialMs : Math.min(checkpoint, now) - overlapMs;
  const floor = now - maxMs;
  const from = Math.max(requestedFrom, floor);
  const windows: TimeWindow[] = [];
  const step = Math.max(1, sliceMs);
  for (let start = from; start < now; start += step) {
    windows.push({ from: start, to: Math.min(now, start + step) });
  }
  return requestedFrom < floor ? { windows, truncated: { requestedFrom, coveredFrom: floor } } : { windows };
}
