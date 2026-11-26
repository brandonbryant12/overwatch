/**
 * Time. Wall time is for display and for deadlines in the outside world; monotonic time is for elapsed durations
 * (back-off, freshness, run budgets). Neither decides order: `events.seq` does. Under the test descriptor both are
 * set by the test, together.
 */
import { Effect } from "effect";
import { performance } from "node:perf_hooks";
import { Expired } from "./errors.ts";

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

export { Expired };

/**
 * The work's result, or Expired once the service's monotonic clock reaches the deadline, whichever comes first. The
 * clock is checked every 50 ms, so a deadline moved by the test descriptor is noticed; the loser is interrupted.
 */
export const bounded = <A, E, R>(work: Effect.Effect<A, E, R>, deadline: number): Effect.Effect<A, E | Expired, R> =>
  Effect.raceFirst(
    work,
    Effect.gen(function* () {
      do yield* Effect.sleep("50 millis");
      while (clock.mono() < deadline);
      return yield* new Expired();
    }),
  );
