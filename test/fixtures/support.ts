/** Helpers shared by the host, conformance and crash tests. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/** A wall clock that can be moved forward, as a laptop's clock jumps after sleep. Timers are unaffected. */
export function movableClock() {
  let offset = 0;
  const base = Effect.runSync(Clock.clockWith(Effect.succeed));
  const millis = () => Date.now() + offset;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
    monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
    // Timers keep real time: sleeping is what the laptop does, not what the clock does.
    sleep: (duration: Duration.Duration) => base.sleep(duration),
  };
  return {
    clock,
    now: millis,
    advance: (input: Duration.Input) => {
      offset += Duration.toMillis(Duration.fromInputUnsafe(input));
    },
  };
}

/** Polls `read` until `ok` holds, or fails after `timeoutMs` with the last value it saw. */
export const waitFor = <A, E, R>(read: Effect.Effect<A, E, R>, ok: (value: A) => boolean, timeoutMs = 15_000) =>
  Effect.gen(function* () {
    const started = Date.now();
    let last: A | undefined;
    while (Date.now() - started < timeoutMs) {
      last = yield* read;
      if (ok(last)) return { value: last, ms: Date.now() - started };
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`));
  });

export const tempDir = (label: string) => mkdtempSync(join(tmpdir(), `overwatch-${label}-`));
