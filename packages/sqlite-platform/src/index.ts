import { Database } from "bun:sqlite";
import * as DurableObjects from "@alchemy.run/domain/DurableObjects";
import type { Platform } from "@alchemy.run/domain/Platform";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { WorkflowEngine } from "effect/workflow";

export interface SqlitePlatformOptions {
  /** Path to SQLite database file, or `:memory:` for ephemeral tests. */
  readonly dbPath: string;
  /** Optional shared bun:sqlite Database handle (takes precedence over dbPath). */
  readonly database?: Database;
  /** Alarm poll interval in ms (defaults to 250ms). */
  readonly alarmPollMs?: number;
}

export function openOverwatchSqlite(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function ensureDomainTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_kv (
      ns TEXT NOT NULL,
      obj_key TEXT NOT NULL,
      k TEXT NOT NULL,
      v TEXT NOT NULL,
      PRIMARY KEY (ns, obj_key, k)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_kv_ns_obj ON domain_kv (ns, obj_key, k);

    CREATE TABLE IF NOT EXISTS domain_alarms (
      ns TEXT NOT NULL,
      obj_key TEXT NOT NULL,
      due_ms INTEGER NOT NULL,
      PRIMARY KEY (ns, obj_key)
    );
    CREATE INDEX IF NOT EXISTS idx_domain_alarms_due ON domain_alarms (due_ms);
  `);
}

function makeObjectStorage(
  db: Database,
  ns: string,
  objKey: string,
  dbTxLock: Semaphore.Semaphore,
): DurableObjects.ObjectStorage {
  const getStmt = db.prepare<{ v: string }, [string, string, string]>(
    "SELECT v FROM domain_kv WHERE ns = ? AND obj_key = ? AND k = ?",
  );
  const putStmt = db.prepare<void, [string, string, string, string]>(
    "INSERT INTO domain_kv (ns, obj_key, k, v) VALUES (?, ?, ?, ?) ON CONFLICT(ns, obj_key, k) DO UPDATE SET v = excluded.v",
  );
  const delStmt = db.prepare<void, [string, string, string]>(
    "DELETE FROM domain_kv WHERE ns = ? AND obj_key = ? AND k = ?",
  );

  const storage: DurableObjects.ObjectStorage = {
    get: <T>(key: string) =>
      Effect.sync(() => {
        const row = getStmt.get(ns, objKey, key);
        if (!row) return undefined;
        return JSON.parse(row.v) as T;
      }),

    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) =>
      Effect.sync(() => {
        if (typeof keyOrEntries === "string") {
          putStmt.run(ns, objKey, keyOrEntries, JSON.stringify(value));
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) {
            putStmt.run(ns, objKey, k, JSON.stringify(v));
          }
        }
      })) as DurableObjects.ObjectStorage["put"],

    delete: ((keyOrKeys: string | ReadonlyArray<string>) =>
      Effect.sync(() => {
        if (typeof keyOrKeys === "string") {
          const res = delStmt.run(ns, objKey, keyOrKeys);
          return res.changes > 0;
        }
        let deleted = 0;
        for (const k of keyOrKeys) {
          deleted += delStmt.run(ns, objKey, k).changes;
        }
        return deleted;
      })) as DurableObjects.ObjectStorage["delete"],

    list: <T>(options?: DurableObjects.ListOptions) =>
      Effect.sync(() => {
        const clauses = ["ns = ?", "obj_key = ?"];
        const params: Array<string | number> = [ns, objKey];

        if (options?.prefix !== undefined && options.prefix.length > 0) {
          const prefix = options.prefix;
          const upper =
            prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
          clauses.push("k >= ? AND k < ?");
          params.push(prefix, upper);
        }
        if (options?.start !== undefined) {
          clauses.push("k >= ?");
          params.push(options.start);
        }
        if (options?.startAfter !== undefined) {
          clauses.push("k > ?");
          params.push(options.startAfter);
        }
        if (options?.end !== undefined) {
          clauses.push("k < ?");
          params.push(options.end);
        }

        const dir = options?.reverse ? "DESC" : "ASC";
        const limitSql = options?.limit !== undefined ? ` LIMIT ${Math.max(0, options.limit)}` : "";
        const sql = `SELECT k, v FROM domain_kv WHERE ${clauses.join(" AND ")} ORDER BY k ${dir}${limitSql}`;
        const rows = db.query<{ k: string; v: string }, Array<string | number>>(sql).all(...params);
        const out = new Map<string, T>();
        for (const r of rows) {
          out.set(r.k, JSON.parse(r.v) as T);
        }
        return out;
      }),

    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      dbTxLock.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            db.exec("BEGIN IMMEDIATE");
          }),
          () => effect,
          (_token, exit) =>
            Effect.sync(() => {
              if (exit._tag === "Success") db.exec("COMMIT");
              else db.exec("ROLLBACK");
            }),
        ),
      ),
  };

  return storage;
}

interface LiveInstance {
  readonly methods: Record<string, (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>>;
  readonly fireAlarm: Effect.Effect<void>;
  readonly scope: Scope.Closeable;
}

/**
 * Creates a zero-Postgres local `DurableObjects.Host` backed by `bun:sqlite` (WAL).
 */
export function makeSqliteHost(options: SqlitePlatformOptions): {
  readonly db: Database;
  readonly host: DurableObjects.Host<never>;
  readonly fireDueAlarms: Effect.Effect<number>;
  readonly close: Effect.Effect<void>;
} {
  const db = options.database ?? openOverwatchSqlite(options.dbPath);
  ensureDomainTables(db);
  const dbTxLock = Semaphore.makeUnsafe(1);

  const claimKeyObj = {};
  const namespaces = new Map<string, DurableObjects.Namespace>();
  const classes = new Map<
    string,
    {
      readonly impl: DurableObjects.ObjectImpl;
      readonly instances: Map<string, LiveInstance>;
      readonly initLocks: Map<string, Semaphore.Semaphore>;
    }
  >();

  const setAlarmStmt = db.prepare<void, [string, string, number]>(
    "INSERT INTO domain_alarms (ns, obj_key, due_ms) VALUES (?, ?, ?) ON CONFLICT(ns, obj_key) DO UPDATE SET due_ms = excluded.due_ms",
  );
  const getAlarmStmt = db.prepare<{ due_ms: number }, [string, string]>(
    "SELECT due_ms FROM domain_alarms WHERE ns = ? AND obj_key = ?",
  );
  const clearAlarmStmt = db.prepare<void, [string, string]>(
    "DELETE FROM domain_alarms WHERE ns = ? AND obj_key = ?",
  );
  const dueAlarmsStmt = db.prepare<{ ns: string; obj_key: string; due_ms: number }, [number]>(
    "SELECT ns, obj_key, due_ms FROM domain_alarms WHERE due_ms <= ? ORDER BY due_ms ASC",
  );

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const scheduleAlarmTimer = (clsName: string, objKey: string, atMs: number) => {
    if (closed) return;
    const timerKey = `${clsName}::${objKey}`;
    const prev = timers.get(timerKey);
    if (prev) clearTimeout(prev);
    const delay = Math.max(0, Math.min(2_147_483_647, atMs - Date.now()));
    const handle = setTimeout(() => {
      timers.delete(timerKey);
      if (closed || !classes.has(clsName)) return;
      void Effect.runPromise(
        getOrCreateInstance(clsName, objKey).pipe(
          Effect.flatMap((inst) => inst.fireAlarm),
          Effect.catchCause(() => Effect.void),
        ),
      );
    }, delay);
    if (typeof (handle as any).unref === "function") {
      (handle as any).unref();
    }
    timers.set(timerKey, handle);
  };

  const getOrCreateInstance = (
    clsName: string,
    objKey: string,
  ): Effect.Effect<LiveInstance> =>
    Effect.gen(function* () {
      const cls = classes.get(clsName);
      if (!cls) {
        return yield* Effect.die(new Error(`SqlitePlatform: undeclared class ${clsName}`));
      }
      const existing = cls.instances.get(objKey);
      if (existing) return existing;

      let lock = cls.initLocks.get(objKey);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        cls.initLocks.set(objKey, lock);
      }

      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const again = cls.instances.get(objKey);
          if (again) return again;

          const storage = makeObjectStorage(db, clsName, objKey, dbTxLock);
          const exclusiveGate = Semaphore.makeUnsafe(1);
          const scope = yield* Scope.make();

          const alarm: DurableObjects.Alarm = {
            set: (at) =>
              Effect.sync(() => {
                setAlarmStmt.run(clsName, objKey, at);
                scheduleAlarmTimer(clsName, objKey, at);
              }),
            get: Effect.sync(() => getAlarmStmt.get(clsName, objKey)?.due_ms ?? null),
          };
          const callbacks = DurableObjects.alarmCallbacks(storage, alarm);

          const objectState: DurableObjects.ObjectStateShape = {
            storage,
            exclusive: (eff) => exclusiveGate.withPermits(1)(eff),
            waitUntil: (eff) =>
              Effect.asVoid(
                Effect.forkDetach(eff.pipe(Effect.catchCause(() => Effect.void))),
              ),
          };

          const runtimeContext = {
            Type: "Overwatch.SqliteHost",
            id: `${clsName}/${objKey}`,
            env: {},
            get: () => Effect.succeed(undefined),
            set: (id: string) => Effect.succeed(id),
            makeCallback: callbacks.makeCallback,
          };

          const rawMethods = yield* cls.impl.pipe(
            Effect.provideService(DurableObjects.ObjectState, objectState),
            Effect.provideService(RuntimeContext, runtimeContext as any),
            Effect.provideService(Scope.Scope, scope),
          );

          const methods: Record<
            string,
            (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
          > = {};
          for (const [m, fn] of Object.entries(rawMethods)) {
            if (typeof fn === "function") {
              methods[m] = fn as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
            }
          }

          const inst: LiveInstance = {
            methods,
            fireAlarm: Effect.sync(() => clearAlarmStmt.run(clsName, objKey)).pipe(
              Effect.andThen(callbacks.fire),
            ),
            scope,
          };
          cls.instances.set(objKey, inst);
          return inst;
        }),
      );
    });

  const makeNamespaceFor = (clsName: string): DurableObjects.Namespace => ({
    getByName: (objKey: string) =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            if (typeof prop !== "string") return undefined;
            return (...args: ReadonlyArray<unknown>) =>
              Effect.flatMap(getOrCreateInstance(clsName, objKey), (inst) => {
                const fn = inst.methods[prop];
                if (!fn) {
                  return Effect.die(
                    new Error(`SqlitePlatform: method ${prop} not found on ${clsName}/${objKey}`),
                  );
                }
                return fn(...args);
              });
          },
        },
      ) as DurableObjects.Stub,
  });

  const host: DurableObjects.Host<never> = {
    claimKey: Effect.succeed(claimKeyObj),
    declare: (model, name, impl) =>
      Effect.sync(() => {
        const clsName = DurableObjects.className(model.modelName, name);
        if (!classes.has(clsName)) {
          classes.set(clsName, {
            impl,
            instances: new Map(),
            initLocks: new Map(),
          });
        }
        let ns = namespaces.get(clsName);
        if (!ns) {
          ns = makeNamespaceFor(clsName);
          namespaces.set(clsName, ns);
        }
        return ns;
      }),
    lookup: (model, name) => namespaces.get(DurableObjects.className(model.modelName, name)),
  };

  const fireDueAlarms: Effect.Effect<number> = Effect.gen(function* () {
    const now = Date.now();
    const due = dueAlarmsStmt.all(now);
    let fired = 0;
    for (const row of due) {
      if (!classes.has(row.ns)) continue;
      const inst = yield* getOrCreateInstance(row.ns, row.obj_key);
      yield* inst.fireAlarm.pipe(Effect.catchCause(() => Effect.void));
      fired += 1;
    }
    return fired;
  });

  const close: Effect.Effect<void> = Effect.gen(function* () {
    closed = true;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const cls of classes.values()) {
      for (const inst of cls.instances.values()) {
        yield* Scope.close(inst.scope, { _tag: "Success", value: undefined } as any).pipe(
          Effect.catchCause(() => Effect.void),
        );
      }
      cls.instances.clear();
    }
    if (!options.database) {
      db.close();
    }
  });

  return { db, host, fireDueAlarms, close };
}

/**
 * Full local Layer providing `@alchemy.run/domain` `Platform`, `WorkflowEngine`, and `SecureRandom`
 * over a single `bun:sqlite` WAL file. Swapping to `@alchemy.run/domain/EffectCluster` is a 1-Layer change.
 */
export function makeSqlitePlatformLayer(options: SqlitePlatformOptions): {
  readonly layer: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom>;
  readonly db: Database;
  readonly fireDueAlarms: Effect.Effect<number>;
  readonly close: Effect.Effect<void>;
} {
  const { db, host, fireDueAlarms, close } = makeSqliteHost(options);
  const platformLayer = DurableObjects.makePlatform(host).pipe(
    Layer.provide(SecureRandom.layerWebCrypto),
  );
  const layer = Layer.mergeAll(
    platformLayer,
    WorkflowEngine.layerMemory,
    SecureRandom.layerWebCrypto,
  );
  return { layer, db, fireDueAlarms, close };
}
