/**
 * Time. Wall time is for display and for deadlines in the outside world; monotonic time is for elapsed durations
 * (back-off, freshness, run budgets). Neither decides order: `events.seq` does. Under the test descriptor both are
 * set by the test, together.
 */
import { performance } from "node:perf_hooks";

let manual: { now: number; mono: number } | null = null;
// When this process's clocks began: at load, or at the test's first setting. Deadlines carried over a restart are
// bounded from here, so time that passed before the first look at them still counts.
let start = { now: Date.now(), mono: performance.now() };

export const clock = {
  now: (): number => manual?.now ?? Date.now(),
  mono: (): number => manual?.mono ?? performance.now(),
  set(now: number, mono: number) {
    if (!manual) start = { now, mono };
    manual = { now, mono };
  },
  get start(): { readonly now: number; readonly mono: number } {
    return start;
  },
  get manual() {
    return manual !== null;
  },
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
