// PROTOTYPE ONLY: a single-process Domain host over node:sqlite, built on the
// package's shared Durable Objects layer (DurableObjects.makePlatform).
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { alarmCallbacks, className, makePlatform, ObjectState } from "@alchemy.run/domain/DurableObjects";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeInputGate } from "alchemy/Workers/InputGate";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export const layerSqlite = (file) =>
  Layer.unwrap(Effect.gen(function* () {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS objects (object TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (object, key)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS alarms (object TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID;`);
    const q = {
      get: db.prepare("SELECT value FROM objects WHERE object = ? AND key = ?"),
      put: db.prepare("INSERT INTO objects (object, key, value) VALUES (?, ?, ?) ON CONFLICT (object, key) DO UPDATE SET value = excluded.value"),
      del: db.prepare("DELETE FROM objects WHERE object = ? AND key = ?"),
      alarmGet: db.prepare("SELECT at FROM alarms WHERE object = ?"),
      alarmSet: db.prepare("INSERT INTO alarms (object, at) VALUES (?, ?) ON CONFLICT (object) DO UPDATE SET at = excluded.at"),
      alarmDel: db.prepare("DELETE FROM alarms WHERE object = ? AND at <= ?"),
    };
    const scope = yield* Scope.make();
    const txLock = yield* Semaphore.make(1);   // one open SQL transaction per connection
    let inTx = false;
    const classes = new Map();
    const instances = new Map();
    const timers = new Map();

    const storageOf = (object, gate) => {
      const run = (f) => gate.storage(Effect.sync(f));
      return {
        get: (key) => run(() => { const r = q.get.get(object, key); return r === undefined ? undefined : JSON.parse(r.value); }),
        put: (k, v) => run(() => { for (const [key, value] of typeof k === "string" ? [[k, v]] : Object.entries(k)) q.put.run(object, key, JSON.stringify(value ?? null)); }),
        delete: (k) => run(() => { let n = 0; for (const key of typeof k === "string" ? [k] : k) n += Number(q.del.run(object, key).changes); return typeof k === "string" ? n > 0 : n; }),
        list: ({ prefix, start, startAfter, end, limit, reverse } = {}) => run(() => {
          const where = ["object = ?"]; const args = [object];
          if (prefix) { where.push("key >= ? AND key < ?"); args.push(prefix, prefix + "￿"); }
          if (start !== undefined) { where.push("key >= ?"); args.push(start); }
          if (startAfter !== undefined) { where.push("key > ?"); args.push(startAfter); }
          if (end !== undefined) { where.push("key < ?"); args.push(end); }
          const rows = db.prepare(`SELECT key, value FROM objects WHERE ${where.join(" AND ")} ORDER BY key ${reverse ? "DESC" : "ASC"} ${limit !== undefined ? "LIMIT " + Math.max(0, limit | 0) : ""}`).all(...args);
          return new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
        }),
        transaction: (effect) => gate.exclusive(inTx ? effect : txLock.withPermits(1)(
          Effect.acquireUseRelease(
            Effect.sync(() => { db.exec("BEGIN IMMEDIATE"); inTx = true; }),
            () => effect,
            (_, exit) => Effect.sync(() => { inTx = false; db.exec(exit._tag === "Success" ? "COMMIT" : "ROLLBACK"); }),
          ))),
      };
    };

    const arm = (name, at) => {
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => Effect.runFork(fire(name, at)), Math.max(0, at - Date.now())));
    };
    const fire = (name, at) => Effect.flatMap(instance(name), ({ gate, callbacks }) =>
      gate.call(Effect.suspend(() => { q.alarmDel.run(name, at); return callbacks.fire; })));

    const build = (name) => Effect.gen(function* () {
      const cls = name.slice(0, name.indexOf("/"));
      const impl = classes.get(cls);
      if (impl === undefined) return yield* Effect.die(new Error(`no Domain class for ${name}`));
      const gate = yield* makeInputGate;
      const storage = storageOf(name, gate);
      const callbacks = alarmCallbacks(storage, {
        set: (at) => Effect.sync(() => { q.alarmSet.run(name, at); arm(name, at); }),
        get: Effect.sync(() => q.alarmGet.get(name)?.at ?? null),
      });
      const state = { storage, exclusive: (e) => gate.exclusive(e), waitUntil: (e) => Effect.asVoid(Effect.forkIn(e, scope)) };
      const runtime = { Type: "NodeSqlite", id: name, env: {}, get: () => Effect.succeed(undefined), set: () => Effect.succeed(""), makeCallback: callbacks.makeCallback };
      const record = yield* impl.pipe(
        Effect.provideService(ObjectState, state), Effect.provideService(RuntimeContext, runtime), Effect.provideService(Scope.Scope, scope));
      return { gate, callbacks, record, runtime, state };
    });
    const instance = (name) => {
      let made = instances.get(name);
      if (made === undefined) instances.set(name, (made = Effect.runSync(Effect.cached(build(name)))));
      return made;
    };
    const namespace = (cls) => ({
      getByName: (key) => new Proxy({}, {
        get: (_, method) => (...args) => Effect.flatMap(instance(`${cls}/${key}`), ({ gate, record, runtime, state }) =>
          gate.call(Effect.suspend(() => typeof record[method] === "function"
            ? record[method](...clone(args)) : Effect.die(new Error(`${cls}/${key} has no method ${String(method)}`)))).pipe(
            Effect.provideService(RuntimeContext, runtime), Effect.provideService(ObjectState, state), Effect.map(clone))),
      }),
    });
    const host = {
      declare: ({ modelName }, cls, impl) => Effect.sync(() => { const c = className(modelName, cls); classes.set(c, impl); return namespace(c); }),
      lookup: ({ modelName }, cls) => namespace(className(modelName, cls)),
      claimKey: Effect.succeed({}),
    };
    // Re-arm the alarms a previous process left pending.
    yield* Effect.sync(() => setTimeout(() => { for (const row of db.prepare("SELECT object, at FROM alarms").all()) arm(row.object, Number(row.at)); }, 50));
    return makePlatform(host).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));
  }));
