/**
 * A single-process Alchemy Domain host on one SQLite file.
 *
 * Alchemy Domain runs a model on any runtime that hosts Durable Objects: it needs a key-value store per object with
 * transactions, an exclusive section per object, background work, and one alarm per object
 * (`DurableObjects.makePlatform`). This module supplies those over `node:sqlite`, in one process.
 *
 * The contract it keeps (docs/plans/command-center.md, 3.3):
 *
 * - Every read and write goes through the connection's one lock, which knows which call owns the open transaction
 *   (`connection.ts`). The per-object exclusive gate is separate.
 * - An alarm is claimed, fired, then cleared. The claim is a row update that survives a crash; the clear removes
 *   the row only if nothing set the alarm again while it fired. A crash anywhere leaves the row, so it fires again.
 * - Alarms are driven by a short wall-clock ticker, not one long timer per alarm: a timer pauses while a laptop
 *   sleeps and overflows past about 24 days. Overdue alarms are drained in bounded batches at start and on wake.
 * - Every event an aggregate commits is also written to the journal, a table Overwatch owns, in the same
 *   transaction: `position` is the real commit order.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { alarmCallbacks, className, makePlatform, ObjectState, type ObjectStateShape, type ObjectStorage, type ListOptions } from "@alchemy.run/domain/DurableObjects";
import type { Platform } from "@alchemy.run/domain/Platform";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeInputGate, type InputGateShape } from "alchemy/Workers/InputGate";
import { faultsFromEnv, openConnection, type Connection, type Faults } from "./connection.ts";

export interface SqliteHostOptions {
  /** The database file, or `:memory:`. */
  readonly file: string;
  /** How often the ticker looks for due alarms. Short, so a sleep or a clock change is noticed quickly. */
  readonly tickMs?: number;
  /** How many due alarms one pass fires before it yields. */
  readonly batch?: number;
  readonly faults?: Faults;
  /** Called with what the host wants an operator to see (alarms re-fired after a crash, wake detected). */
  readonly log?: (message: string) => void;
}

/** The host's connection and controls, for the service's own tables and for tests. */
export interface SqliteHostShape {
  readonly connection: Connection;
  /** Fire every due alarm now, in bounded batches, and resolve when none is left. */
  readonly drainDue: Effect.Effect<number>;
  /** Stop the ticker and wait for alarms in flight. The connection stays open. */
  readonly stop: Effect.Effect<void>;
}

export class SqliteHost extends Context.Service<SqliteHost, SqliteHostShape>()("overwatch/host/SqliteHost") {}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS objects (
    object TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (object, key)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS alarms (
    object TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    gen INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS alarms_at ON alarms (at);
  CREATE TABLE IF NOT EXISTS journal (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL,
    version INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    at INTEGER NOT NULL,
    command_id TEXT NOT NULL,
    correlation_id TEXT,
    UNIQUE (stream, version)
  );
`;

/** A JSON round trip: what crosses an object boundary is data, never shared references. */
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Upper bound of the keys starting with `prefix`. */
const prefixEnd = (prefix: string) => prefix + "￿";

/**
 * Methods that write several keys without a transaction of their own and call no other object. On Cloudflare, writes
 * made without awaiting other I/O are coalesced into one atomic batch; here they would be separate commits, and a
 * crash between them could leave a schedule armed with no job behind it. The host runs these in a transaction.
 */
const ATOMIC_METHODS = new Set(["Aggregate.schedule", "Aggregate.unschedule"]);

/** `Aggregate`, `View`, `Policy`... from an object name like `Ledger.AccountAggregate/a-1`. */
const kindOf = (name: string) => /(Aggregate|View|Policy|Projection|Stream)(V\d+)?(Run)?\//.exec(name)?.[1] ?? "";

interface AlarmRow {
  readonly object: string;
  readonly at: number;
  readonly gen: number;
  readonly claimed_at: number | null;
}

interface Instance {
  readonly gate: InputGateShape;
  readonly record: Record<string, unknown>;
  readonly state: ObjectStateShape;
  readonly runtime: RuntimeContext["Service"];
  readonly fire: Effect.Effect<void>;
}

export const layerSqlite = (options: SqliteHostOptions): Layer.Layer<Platform | SqliteHost | SecureRandom.SecureRandom> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const connection = openConnection(options.file, options.faults ?? faultsFromEnv());
      const { use, transaction, faults } = connection;
      const log = options.log ?? (() => undefined);
      const tickMs = options.tickMs ?? 1_000;
      const batch = Math.max(1, options.batch ?? 32);
      connection.db.exec(SCHEMA);
      const db = connection.db;
      const q = {
        get: db.prepare("SELECT value FROM objects WHERE object = ? AND key = ?"),
        put: db.prepare(
          "INSERT INTO objects (object, key, value) VALUES (?, ?, ?) ON CONFLICT (object, key) DO UPDATE SET value = excluded.value",
        ),
        del: db.prepare("DELETE FROM objects WHERE object = ? AND key = ?"),
        journal: db.prepare(
          "INSERT INTO journal (stream, version, type, data, at, command_id, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ),
        alarmGet: db.prepare("SELECT at FROM alarms WHERE object = ?"),
        alarmSet: db.prepare(
          "INSERT INTO alarms (object, at, gen) VALUES (?, ?, 1) ON CONFLICT (object) DO UPDATE SET at = excluded.at, gen = alarms.gen + 1",
        ),
        alarmDue: db.prepare("SELECT object, at, gen, claimed_at FROM alarms WHERE at <= ? ORDER BY at LIMIT ?"),
        alarmClaim: db.prepare("UPDATE alarms SET claimed_at = ?, attempts = attempts + 1 WHERE object = ? AND gen = ?"),
        alarmClear: db.prepare("DELETE FROM alarms WHERE object = ? AND gen = ?"),
        alarmBackoff: db.prepare("UPDATE alarms SET at = ? WHERE object = ? AND gen = ?"),
      };

      // The context the model's Layer is built in (its Clock, its services). Instances, alarms and background
      // work run in it, so a test that replaces the clock replaces it everywhere.
      const context = yield* Effect.context<never>();
      const scope = yield* Scope.make();
      const now = Clock.currentTimeMillis;

      yield* use(() => clearStaleLeases(db));

      /**
       * Every pending callback job must have an alarm at or before its due time. Alchemy stores the job and arms the
       * alarm as two writes; a crash between them would leave a job nothing fires. Checked at start and on wake.
       */
      const repairAlarms = use(() => {
        const pending = db
          .prepare(
            "SELECT object, MIN(json_extract(value, '$.due')) AS due FROM objects WHERE key >= 'cb:' AND key < 'cb;' GROUP BY object",
          )
          .all() as Array<{ object: string; due: number }>;
        let repaired = 0;
        for (const { object, due } of pending) {
          const alarm = q.alarmGet.get(object) as { at: number } | undefined;
          if (alarm !== undefined && alarm.at <= due) continue;
          q.alarmSet.run(object, Math.floor(due));
          repaired += 1;
        }
        return repaired;
      });

      const storageOf = (object: string, gate: InputGateShape, aggregate: boolean): ObjectStorage => {
        const read = <A>(work: () => A) => gate.storage(use(work, object));
        const write = (work: () => void) => gate.storage(transaction(object, use(work, object)));
        const putOne = (key: string, value: unknown) => {
          faults.hit("write");
          q.put.run(object, key, JSON.stringify(value ?? null));
          if (aggregate && key.startsWith("event:")) journalRow(value);
        };
        const journalRow = (stored: unknown) => {
          const { event, envelope } = stored as { event: { _tag?: string }; envelope: Record<string, unknown> };
          if (typeof envelope?.stream !== "string" || typeof envelope.seq !== "number") return;
          q.journal.run(
            envelope.stream,
            envelope.seq,
            String(event?._tag ?? "unknown"),
            JSON.stringify(event),
            Number(envelope.at),
            String(envelope.commandId),
            typeof envelope.correlationId === "string" ? envelope.correlationId : null,
          );
          connection.markJournal();
        };
        const storage = {
          get: <T>(key: string) =>
            read(() => {
              const row = q.get.get(object, key) as { value: string } | undefined;
              return row === undefined ? undefined : (JSON.parse(row.value) as T);
            }),
          put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
            write(() => {
              if (typeof keyOrEntries === "string") putOne(keyOrEntries, value);
              else for (const [key, entry] of Object.entries(keyOrEntries)) putOne(key, entry);
            }),
          delete: (keys: string | ReadonlyArray<string>) =>
            gate.storage(
              transaction(
                object,
                use(() => {
                  let removed = 0;
                  for (const key of typeof keys === "string" ? [keys] : keys) {
                    faults.hit("write");
                    removed += Number(q.del.run(object, key).changes);
                  }
                  return typeof keys === "string" ? removed > 0 : removed;
                }, object),
              ),
            ),
          list: <T>(listOptions: ListOptions = {}) =>
            read(() => {
              const where = ["object = ?"];
              const args: Array<string | number> = [object];
              const { prefix, start, startAfter, end, limit, reverse } = listOptions;
              if (prefix) {
                where.push("key >= ? AND key < ?");
                args.push(prefix, prefixEnd(prefix));
              }
              if (start !== undefined) {
                where.push("key >= ?");
                args.push(start);
              }
              if (startAfter !== undefined) {
                where.push("key > ?");
                args.push(startAfter);
              }
              if (end !== undefined) {
                where.push("key < ?");
                args.push(end);
              }
              const sql = `SELECT key, value FROM objects WHERE ${where.join(" AND ")} ORDER BY key ${reverse ? "DESC" : "ASC"}${
                limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : ""
              }`;
              const rows = db.prepare(sql).all(...args) as Array<{ key: string; value: string }>;
              return new Map(rows.map((row) => [row.key, JSON.parse(row.value) as T]));
            }),
          transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.exclusive(transaction(object, effect)),
        };
        return storage as unknown as ObjectStorage;
      };

      /** Objects whose alarm is firing now. */
      const firing = new Set<string>();
      const classes = new Map<string, Parameters<Parameters<typeof makePlatform>[0]["declare"]>[2]>();
      const instances = new Map<string, Effect.Effect<Instance>>();

      const build = (name: string) =>
        Effect.gen(function* () {
          const cls = name.slice(0, name.indexOf("/"));
          const impl = classes.get(cls);
          if (impl === undefined) return yield* Effect.die(new Error(`No Domain class for ${name}`));
          const gate = yield* makeInputGate;
          const storage = storageOf(name, gate, cls.endsWith("Aggregate"));
          const callbacks = alarmCallbacks(storage, {
            set: (at) => gate.storage(use(() => void q.alarmSet.run(name, Math.floor(at)), name)),
            // While this object's alarm fires, report none: a job scheduled meanwhile then always re-arms (bumping the
            // row's generation), so the clear after firing cannot remove the alarm that job needs.
            get: gate.storage(
              use(() => (firing.has(name) ? null : ((q.alarmGet.get(name) as { at: number } | undefined)?.at ?? null)), name),
            ),
          });
          const state: ObjectStateShape = {
            storage,
            exclusive: (effect) => gate.exclusive(effect),
            waitUntil: (effect) => Effect.asVoid(Effect.forkIn(effect, scope)),
          };
          const runtime = {
            Type: "OverwatchSqlite",
            id: name,
            env: {},
            get: () => Effect.succeed(undefined),
            set: () => Effect.succeed(""),
            makeCallback: callbacks.makeCallback,
          } as unknown as RuntimeContext["Service"];
          const record = yield* impl.pipe(
            Effect.provideService(ObjectState, state),
            Effect.provideService(RuntimeContext, runtime),
            Effect.provideService(Scope.Scope, scope),
          );
          const fire = callbacks.fire.pipe(Effect.provideService(ObjectState, state), Effect.provideService(RuntimeContext, runtime));
          return { gate, record, state, runtime, fire } satisfies Instance;
        }).pipe(Effect.provide(context));

      const instance = (name: string): Effect.Effect<Instance> => {
        let made = instances.get(name);
        if (made === undefined) {
          made = Effect.runSync(Effect.cached(build(name)));
          instances.set(name, made);
        }
        return made;
      };

      const call = (name: string, method: string, args: ReadonlyArray<unknown>) =>
        Effect.flatMap(instance(name), ({ gate, record, runtime, state }) =>
          gate
            .call(
              Effect.suspend(() => {
                const fn = record[method];
                if (typeof fn !== "function") return Effect.die(new Error(`${name} has no method ${method}`));
                const effect = (fn as (...a: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>)(...clone(args));
                return ATOMIC_METHODS.has(`${kindOf(name)}.${method}`) ? gate.exclusive(transaction(name, effect)) : effect;
              }),
            )
            .pipe(
              Effect.provideService(RuntimeContext, runtime),
              Effect.provideService(ObjectState, state),
              Effect.map(clone),
              Effect.provide(context),
            ),
        );

      const namespace = (cls: string) => ({
        getByName: (key: string) =>
          new Proxy(
            {},
            { get: (_, method) => (...args: ReadonlyArray<unknown>) => call(`${cls}/${key}`, String(method), args) },
          ) as never,
      });

      const host = {
        declare: (model: { readonly modelName: string }, name: string, impl: Parameters<Parameters<typeof makePlatform>[0]["declare"]>[2]) =>
          Effect.sync(() => {
            const cls = className(model.modelName, name);
            classes.set(cls, impl);
            return namespace(cls);
          }),
        lookup: (model: { readonly modelName: string }, name: string) => namespace(className(model.modelName, name)),
        claimKey: Effect.succeed(connection as object),
      };

      // ------------------------------------------------------------ alarms

      let stopped = false;

      /** Claim, fire, clear. A crash at any point leaves the row, so the alarm fires again after a restart. */
      const fireOne = (row: AlarmRow) =>
        Effect.gen(function* () {
          firing.add(row.object);
          if (row.claimed_at !== null) log(`alarm for ${row.object} was claimed at ${new Date(row.claimed_at).toISOString()} and not cleared; firing it again`);
          yield* use(() => q.alarmClaim.run(Date.now(), row.object, row.gen));
          faults.hit("alarm:claimed");
          const exit = yield* Effect.exit(Effect.flatMap(instance(row.object), ({ gate, fire }) => gate.call(fire)));
          faults.hit("alarm:fired");
          if (Exit.isSuccess(exit)) {
            yield* use(() => q.alarmClear.run(row.object, row.gen));
          } else {
            // Not a job failing (the callbacks retry those): the instance itself could not run. Back off, keep it.
            const at = (yield* now) + 30_000;
            log(`alarm for ${row.object} failed to fire; trying again in 30s`);
            yield* use(() => q.alarmBackoff.run(at, row.object, row.gen));
          }
        }).pipe(
          Effect.ensuring(Effect.sync(() => firing.delete(row.object))),
          Effect.provide(context),
        );

      /** Fire every due alarm, `batch` at a time. Returns how many fired. */
      const drainDue: Effect.Effect<number> = Effect.gen(function* () {
        let fired = 0;
        while (!stopped) {
          const at = yield* now;
          const rows = yield* use(() => q.alarmDue.all(at, batch + firing.size) as unknown as ReadonlyArray<AlarmRow>);
          const due = rows.filter((row) => !firing.has(row.object)).slice(0, batch);
          if (due.length === 0) break;
          yield* Effect.forEach(due, fireOne, { concurrency: 8, discard: true });
          fired += due.length;
          yield* Effect.yieldNow;
        }
        return fired;
      }).pipe(Effect.provide(context));

      // The ticker. It notices a wake by the wall clock jumping, and drains whatever fell due meanwhile.
      let ticking = false;
      let last = Date.now();
      let repairNext = true;
      let ticks = 0;
      const tick = () => {
        const wall = Date.now();
        ticks += 1;
        if (ticks % Math.max(1, Math.round(60_000 / tickMs)) === 0) repairNext = true;
        if (wall - last > tickMs * 5) {
          log(`clock jumped ${Math.round((wall - last) / 1000)}s (sleep or clock change); draining due work`);
          repairNext = true;
        }
        last = wall;
        if (ticking || stopped) return;
        ticking = true;
        const repair = repairNext
          ? repairAlarms.pipe(Effect.tap((n) => Effect.sync(() => n > 0 && log(`re-armed ${n} alarm(s) for pending jobs`))))
          : Effect.void;
        repairNext = false;
        Effect.runFork(Effect.andThen(repair, drainDue).pipe(Effect.ensuring(Effect.sync(() => (ticking = false)))));
      };
      const timer = setInterval(tick, tickMs);
      timer.unref?.();
      // Catch up at start, once the model has declared its classes.
      setTimeout(tick, 0).unref?.();

      const stop = Effect.gen(function* () {
        stopped = true;
        clearInterval(timer);
        while (firing.size > 0 || ticking) yield* Effect.sleep("10 millis");
      });
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* stop;
          yield* Scope.close(scope, Exit.void);
          connection.close();
        }),
      );

      const platform = makePlatform(host).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
      return Layer.merge(platform, Layer.succeed(SqliteHost, { connection, drainDue, stop }));
    }),
  );

/**
 * A lease in Alchemy's storage stops two drains of one queue running at once. In a single process, a lease left by a
 * process that died is held by nobody, yet it would block every drain until it expires: a backstop callback that
 * finds the queue leased returns as done, and the staged rows wait for the next commit. Leases are cleared at start.
 */
function clearStaleLeases(db: import("node:sqlite").DatabaseSync) {
  db.prepare("DELETE FROM objects WHERE key GLOB '*-lease' OR key = 'bf:q-lease'").run();
}
