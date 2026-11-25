/**
 * Conformance: the same command, receipt and view fixtures, run through the in-process Api client against
 * Alchemy's in-memory host and the SQLite host. Both must give the same transcript. Alchemy's `Story` always builds
 * the in-memory host, so it cannot test ours; this suite is the gate for upgrading Alchemy Domain.
 */
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerSqlite } from "../src/host/sqlite.ts";
import { bigDepositsLive, Ledger, LedgerApi } from "./fixtures/ledger.model.ts";
import { tempDir, waitFor } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

/** A step: a command to send and what must come back, or a read and what it must show once the model settles. */
type Step =
  | { readonly send: { readonly target: string; readonly amount: number; readonly commandId?: string }; readonly expect: unknown }
  | { readonly read: "Summary" | "AuditView"; readonly key: string; readonly expect: unknown };

const FIXTURES: ReadonlyArray<Step> = [
  { send: { target: "a-1", amount: 100, commandId: "c-1" }, expect: { reply: { balance: 100 }, stream: "Account/a-1", version: 1 } },
  // The same command id again: the same receipt, nothing committed twice.
  { send: { target: "a-1", amount: 100, commandId: "c-1" }, expect: { reply: { balance: 100 }, stream: "Account/a-1", version: 1 } },
  { send: { target: "a-1", amount: 99_999 }, expect: { rejected: "TooLarge", max: 10_000 } },
  { send: { target: "a-1", amount: 600, commandId: "c-2" }, expect: { reply: { balance: 700 }, stream: "Account/a-1", version: 2 } },
  { send: { target: "a-2", amount: 50 }, expect: { reply: { balance: 50 }, stream: "Account/a-2", version: 1 } },
  // The policy flags the big deposit on another aggregate and schedules a reminder, which fires.
  { read: "AuditView", key: "a-1", expect: { flags: 1, amounts: [600] } },
  { read: "Summary", key: "a-1", expect: { deposits: 2, total: 700, reminders: 1 } },
  { read: "Summary", key: "a-2", expect: { deposits: 1, total: 50, reminders: 0 } },
  { read: "AuditView", key: "a-2", expect: null },
];

const run = (platform: Layer.Layer<Domain.Platform | import("effect/crypto/SecureRandom").SecureRandom>) =>
  Effect.gen(function* () {
    const api = yield* LedgerApi.clientInProcess;
    const transcript: unknown[] = [];
    for (const step of FIXTURES) {
      if ("send" in step) {
        const { target, amount, commandId } = step.send;
        const result = yield* api.Deposit(target, { amount }, commandId === undefined ? undefined : { commandId }).pipe(
          Effect.map((receipt) => receipt as unknown),
          Effect.catchTag("TooLarge", (rejection) => Effect.succeed({ rejected: rejection._tag, max: rejection.max })),
        );
        transcript.push(result);
      } else {
        const read = step.read === "Summary" ? api.Summary.get(step.key) : api.AuditView.get(step.key);
        const { value } = yield* waitFor(read as Effect.Effect<unknown, unknown>, (v) => JSON.stringify(v) === JSON.stringify(step.expect), 10_000).pipe(
          Effect.catchCause(() => Effect.map(read as Effect.Effect<unknown, unknown>, (v) => ({ value: v }))),
        );
        transcript.push(value);
      }
    }
    return transcript;
  }).pipe(Effect.scoped, Effect.provide(Ledger.layer(bigDepositsLive("300 millis")).pipe(Layer.provideMerge(platform))));

describe("conformance: the same fixtures on both hosts", () => {
  const expected = FIXTURES.map((step) => step.expect);
  let inMemory: unknown[] = [];

  test("in-memory host", async () => {
    inMemory = await Effect.runPromise(run(Domain.InMemory));
    expect(inMemory).toEqual(expected);
  });

  test("SQLite host", async () => {
    const sqlite = await Effect.runPromise(run(layerSqlite({ file: join(tempDir("conformance"), "db.sqlite"), tickMs: 100 })));
    expect(sqlite).toEqual(expected);
    expect(sqlite).toEqual(inMemory);
  });

  test("SQLite host, the same fixtures after a restart: state survives, retries stay idempotent", async () => {
    const file = join(tempDir("conformance-restart"), "db.sqlite");
    await Effect.runPromise(run(layerSqlite({ file, tickMs: 100 })));
    const again = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LedgerApi.clientInProcess;
        const retried = yield* api.Deposit("a-1", { amount: 100 }, { commandId: "c-1" });
        const summary = yield* api.Summary.get("a-1");
        return { retried, summary };
      }).pipe(Effect.scoped, Effect.provide(Ledger.layer(bigDepositsLive("300 millis")).pipe(Layer.provideMerge(layerSqlite({ file, tickMs: 100 }))))),
    );
    expect(again).toEqual({
      retried: { reply: { balance: 100 }, stream: "Account/a-1", version: 1 },
      summary: { deposits: 2, total: 700, reminders: 1 },
    });
  });
});
