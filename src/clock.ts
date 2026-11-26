/**
 * Time. Wall time is for display and for deadlines in the outside world; monotonic time is for elapsed durations
 * (back-off, freshness, run budgets). Neither decides order: `events.seq` does. Under the test descriptor both are
 * set by the test, together.
 */
import { performance } from "node:perf_hooks";

let manual: { now: number; mono: number } | null = null;

export const clock = {
  now: (): number => manual?.now ?? Date.now(),
  mono: (): number => manual?.mono ?? performance.now(),
  set(now: number, mono: number) {
    manual = { now, mono };
  },
  get manual() {
    return manual !== null;
  },
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
