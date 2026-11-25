/**
 * The SQLite host's own contract: the connection lock, the journal, and alarms driven by a wall-clock ticker.
 * Crash tests are in crash.test.ts; behaviour shared with the in-memory host is in conformance.test.ts.
 */
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { openConnection } from "../src/host/connection.ts";
import { layerSqlite, SqliteHost } from "../src/host/sqlite.ts";
import { bigDepositsLive, Ledger, LedgerApi } from "./fixtures/ledger.model.ts";
import { movableClock, tempDir, waitFor } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const plain = <T extends object | undefined>(value: T) => (value === undefined ? undefined : { ...value });
const row = (db: import("node:sqlite").DatabaseSync, key: string) => plain(db.prepare("SELECT v FROM t WHERE k = ?").get(key));

describe("the connection lock", () => {
  const setup = () => {
    const connection = openConnection(join(tempDir("lock"), "db.sqlite"));
    connection.db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    return connection;
  };

  test("two transactions on different owners, one rolled back: the other's acknowledged write survives", async () => {
    const connection = setup();
    const program = Effect.gen(function* () {
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // A opens a transaction, writes, and waits while B works; then A fails and rolls back.
      const a = yield* Effect.forkChild(
        connection
          .transaction(
            "Model.AAggregate/a",
            Effect.gen(function* () {
              yield* connection.use((db) => db.prepare("INSERT INTO t VALUES ('a', 'from a')").run(), "Model.AAggregate/a");
              yield* Deferred.succeed(holding, undefined);
              yield* Deferred.await(release);
              return yield* Effect.fail("a gives up");
            }),
          )
          .pipe(Effect.flip),
      );
      yield* Deferred.await(holding);
      // B: a transaction of its own, and a plain write. Neither may join A's transaction.
      const b = yield* Effect.forkChild(
        connection.transaction(
          "Model.BAggregate/b",
          connection.use((db) => db.prepare("INSERT INTO t VALUES ('b', 'from b')").run(), "Model.BAggregate/b"),
        ),
      );
      const plain = yield* Effect.forkChild(connection.use((db) => db.prepare("INSERT INTO t VALUES ('c', 'plain')").run()));
      yield* Effect.sleep("50 millis");
      // While A holds the transaction, B's writes wait: they are not acknowledged yet.
      expect(b.pollUnsafe()).toBe(undefined);
      expect(plain.pollUnsafe()).toBe(undefined);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(a)).toBe("a gives up");
      yield* Fiber.join(b);
      yield* Fiber.join(plain);
    });
    await Effect.runPromise(program);
    expect(row(connection.db, "a")).toBe(undefined);
    expect(row(connection.db, "b")).toEqual({ v: "from b" });
    expect(row(connection.db, "c")).toEqual({ v: "plain" });
  });

  test("the owner's nested transaction is a savepoint: its failure undoes only its own writes", async () => {
    const connection = setup();
    const owner = "Model.AAggregate/a";
    const write = (k: string) => connection.use((db) => db.prepare("INSERT INTO t VALUES (?, 'x')").run(k), owner);
    await Effect.runPromise(
      connection.transaction(
        owner,
        Effect.gen(function* () {
          yield* write("outer");
          yield* connection.transaction(owner, Effect.andThen(write("inner"), Effect.fail("no"))).pipe(Effect.ignore);
          yield* write("after");
        }),
      ),
    );
    expect(row(connection.db, "outer")).toEqual({ v: "x" });
    expect(row(connection.db, "inner")).toBe(undefined);
    expect(row(connection.db, "after")).toEqual({ v: "x" });
  });

  test("an interrupted transaction rolls back and releases the lock", async () => {
    const connection = setup();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          connection.transaction(
            "o",
            Effect.andThen(
              connection.use((db) => db.prepare("INSERT INTO t VALUES ('gone', 'x')").run(), "o"),
              Effect.never,
            ),
          ),
        );
        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
        yield* connection.atomically((db) => db.prepare("INSERT INTO t VALUES ('next', 'x')").run());
      }),
    );
    expect(row(connection.db, "gone")).toBe(undefined);
    expect(row(connection.db, "next")).toEqual({ v: "x" });
  });
});

/** The ledger model on the SQLite host, with a clock the test can move. */
const hosted = (file: string, remindAfter: Duration.Input, clock: Clock.Clock) =>
  Layer.mergeAll(Ledger.layer(bigDepositsLive(remindAfter))).pipe(
    Layer.provideMerge(layerSqlite({ file, tickMs: 250 })),
    Layer.provide(Layer.succeed(Clock.Clock, clock)),
  );

describe("the journal", () => {
  test("every committed event is a journal row, written in the commit's transaction, in commit order", async () => {
    const file = join(tempDir("journal"), "db.sqlite");
    const { clock } = movableClock();
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LedgerApi.clientInProcess;
        yield* api.Deposit("a-1", { amount: 10 });
        yield* api.Deposit("a-2", { amount: 20 });
        yield* api.Deposit("a-1", { amount: 30 });
        yield* api.Deposit("a-1", { amount: 99_999 }).pipe(Effect.ignore);
      }).pipe(Effect.scoped, Effect.provide(hosted(file, "1 hour", clock))),
    );
    const connection = openConnection(file);
    const rows = connection.db.prepare("SELECT position, stream, version, type, data FROM journal ORDER BY position").all();
    expect(rows.map((r) => [r.position, r.stream, r.version, r.type, JSON.parse(String(r.data)).amount])).toEqual([
      [1, "Account/a-1", 1, "Deposited", 10],
      [2, "Account/a-2", 1, "Deposited", 20],
      [3, "Account/a-1", 2, "Deposited", 30],
    ]);
    // The journal and the aggregate's own events agree.
    const stored = connection.db.prepare("SELECT count(*) AS n FROM objects WHERE key LIKE 'event:%'").get();
    expect(plain(stored)).toEqual({ n: 3 });
  });
});

describe("alarms and sleep", () => {
  test("move the clock forward as a sleep would: an overdue scheduled command fires within 15 seconds", async () => {
    const file = join(tempDir("sleep"), "db.sqlite");
    const time = movableClock();
    const waited = await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LedgerApi.clientInProcess;
        yield* api.Deposit("a-1", { amount: 700 });
        // The policy schedules a reminder in an hour. Nothing fires before then.
        yield* waitFor(api.AuditView.get("a-1"), (v) => v?.flags === 1);
        yield* Effect.sleep("1 second");
        expect((yield* api.Summary.get("a-1"))?.reminders ?? 0).toBe(0);
        // The laptop sleeps for an hour and a minute: timers did not run, the wall clock moved.
        time.advance("61 minutes");
        const { ms } = yield* waitFor(api.Summary.get("a-1"), (v) => v?.reminders === 1, 15_000);
        return ms;
      }).pipe(Effect.scoped, Effect.provide(hosted(file, "1 hour", time.clock))),
    );
    expect(waited).toBeLessThan(15_000);
  });

  test("an alarm a month away neither fires early nor overflows a timer, and fires once its time comes", async () => {
    const file = join(tempDir("far"), "db.sqlite");
    const time = movableClock();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const api = yield* LedgerApi.clientInProcess;
          yield* api.Deposit("a-1", { amount: 900 });
          yield* waitFor(api.AuditView.get("a-1"), (v) => v?.flags === 1);
          const host = yield* SqliteHost;
          const pending = yield* host.connection.use((db) => db.prepare("SELECT count(*) AS n FROM objects WHERE key LIKE 'cb:%' AND json_extract(value, '$.due') > ?").get(Date.now() + 29 * 86_400_000));
          expect(plain(pending)).toEqual({ n: 1 });
          yield* Effect.sleep("1 second");
          expect((yield* api.Summary.get("a-1"))?.reminders ?? 0).toBe(0);
          time.advance("31 days");
          yield* waitFor(api.Summary.get("a-1"), (v) => v?.reminders === 1, 15_000);
        }).pipe(Effect.scoped, Effect.provide(hosted(file, "30 days", time.clock))),
      );
    } finally {
      process.off("warning", onWarning);
    }
    expect(warnings.filter((name) => name === "TimeoutOverflowWarning")).toEqual([]);
  });

  test("work that fell due while the service was stopped is drained at start", async () => {
    const file = join(tempDir("start"), "db.sqlite");
    const time = movableClock();
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LedgerApi.clientInProcess;
        yield* api.Deposit("a-1", { amount: 800 });
        yield* waitFor(api.AuditView.get("a-1"), (v) => v?.flags === 1);
      }).pipe(Effect.scoped, Effect.provide(hosted(file, "1 hour", time.clock))),
    );
    time.advance("2 hours");
    await Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* LedgerApi.clientInProcess;
        yield* waitFor(api.Summary.get("a-1"), (v) => v?.reminders === 1, 15_000);
      }).pipe(Effect.scoped, Effect.provide(hosted(file, "1 hour", time.clock))),
    );
  });
});
