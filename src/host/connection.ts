/**
 * The one SQLite connection the service owns, and the one lock every read and write on it goes through.
 *
 * SQLite has one transaction per connection. Anything executed on the connection while a transaction is open
 * becomes part of that transaction, and is lost if it rolls back. So the lock knows who owns the open transaction:
 * work by the owner runs on the connection directly (a nested transaction is a savepoint), and everything else waits
 * until the transaction ends.
 *
 * The owner is named explicitly, not inferred from the calling fiber: Alchemy captures and re-provides contexts, so
 * a token carried in the fiber's context does not survive into every effect a transaction runs. For a Domain object
 * the owner is the object's name. That is safe because the object's exclusive gate (a separate thing) already keeps
 * every other call on that object out while its transaction runs. Service code that is not a Domain object uses
 * `atomically`, which runs synchronously, so nothing can interleave with it.
 */
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";

/** Points where a test can stop the process, to prove that nothing is lost or done twice. */
export interface Faults {
  readonly hit: (point: FaultPoint) => void;
}
export type FaultPoint = "write" | "commit" | "alarm:claimed" | "alarm:fired";
export const noFaults: Faults = { hit: () => undefined };

/**
 * Faults from `OVERWATCH_CRASH=<point>@<n>`: the process kills itself, without cleanup, on the nth hit of that
 * point. Used only by the crash tests, which run the service in a child process.
 */
export function faultsFromEnv(spec = process.env.OVERWATCH_CRASH): Faults {
  if (!spec) return noFaults;
  const [point, count] = spec.split("@");
  let left = Number(count ?? 1);
  return {
    hit: (at) => {
      if (at !== point) return;
      left -= 1;
      if (left === 0) process.kill(process.pid, "SIGKILL");
    },
  };
}

export interface Connection {
  readonly db: DatabaseSync;
  readonly faults: Faults;
  /** Run synchronous work on the connection: inside `owner`'s transaction if it has the open one, else under the lock. */
  readonly use: <A>(work: (db: DatabaseSync) => A, owner?: string) => Effect.Effect<A>;
  /** Run `effect` in a transaction owned by `owner`. Commits on success; rolls back on failure, defect or interruption. */
  readonly transaction: <A, E, R>(owner: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Run synchronous work in its own transaction, under the lock. */
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Effect.Effect<A>;
  /** `use` for code outside Effect. */
  readonly run: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  /** `atomically` for code outside Effect. */
  readonly runAtomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  /** Called after each commit that wrote journal rows. */
  readonly afterCommit: (listener: () => void) => () => void;
  /** Marks the open transaction as one that wrote journal rows. */
  readonly markJournal: () => void;
  readonly close: () => void;
}

export function openConnection(file: string, faults: Faults = noFaults): Connection {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;`);
  const lock = Semaphore.makeUnsafe(1);
  let open: string | undefined;
  let depth = 0;
  let wroteJournal = false;
  const listeners = new Set<() => void>();

  const rollback = () => {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing open: SQLite already rolled it back.
    }
  };
  const committed = () => {
    faults.hit("commit");
    if (wroteJournal) for (const listener of listeners) queueMicrotask(listener);
    wroteJournal = false;
  };

  /** Waits for the lock. With OVERWATCH_DEBUG_LOCK set, a wait over three seconds is reported with its stack. */
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>, what: string): Effect.Effect<A, E, R> =>
    process.env.OVERWATCH_DEBUG_LOCK
      ? Effect.flatMap(
          Effect.forkDetach(
            Effect.sleep("3 seconds").pipe(
              Effect.andThen(Effect.sync(() => console.error(`lock wait over 3s: ${what} while ${open} holds it`, new Error().stack))),
            ),
          ),
          (watch) => lock.withPermits(1)(Effect.flatMap(Fiber.interrupt(watch), () => effect)),
        )
      : lock.withPermits(1)(effect);

  const use = <A>(work: (db: DatabaseSync) => A, owner?: string): Effect.Effect<A> =>
    Effect.suspend(() =>
      owner !== undefined && owner === open ? Effect.sync(() => work(db)) : locked(Effect.sync(() => work(db)), `use by ${owner}`),
    );

  const atomically = <A>(work: (db: DatabaseSync) => A): Effect.Effect<A> =>
    locked(
      Effect.sync(() => {
        db.exec("BEGIN IMMEDIATE");
        wroteJournal = false;
        try {
          const result = work(db);
          db.exec("COMMIT");
          committed();
          return result;
        } catch (error) {
          rollback();
          throw error;
        }
      }),
      "atomically",
    );

  const transaction = <A, E, R>(owner: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      if (owner === open) {
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            const name = `sp${++depth}`;
            db.exec(`SAVEPOINT ${name}`);
            return name;
          }),
          () => effect,
          (name, exit) =>
            Effect.sync(() => {
              depth -= 1;
              if (Exit.isFailure(exit)) db.exec(`ROLLBACK TO ${name}`);
              db.exec(`RELEASE ${name}`);
            }),
        );
      }
      return locked(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            db.exec("BEGIN IMMEDIATE");
            open = owner;
            depth = 0;
            wroteJournal = false;
          }),
          () => effect,
          (_, exit) =>
            Effect.sync(() => {
              open = undefined;
              if (Exit.isSuccess(exit)) {
                try {
                  db.exec("COMMIT");
                } catch (error) {
                  rollback();
                  throw error;
                }
                committed();
              } else {
                rollback();
                wroteJournal = false;
              }
            }),
        ),
        `transaction by ${owner}`,
      );
    });

  return {
    db,
    faults,
    use,
    transaction,
    atomically,
    run: (work) => Effect.runPromise(use(work)),
    runAtomically: (work) => Effect.runPromise(atomically(work)),
    afterCommit: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    markJournal: () => {
      wroteJournal = true;
    },
    close: () => db.close(),
  };
}
