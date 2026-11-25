/**
 * The writer lock: one process at a time may open a database for writing. Each process's connection lock and its
 * start-up repairs (clearing leases a dead process left, re-arming alarms) are only correct if no other process has
 * the file open, so the lock is taken before anything is opened or repaired.
 *
 * The lock is held by the operating system, not by a file's contents: a small SQLite database next to the database
 * (`<file>.writer`), kept in an EXCLUSIVE transaction for as long as the process holds the lock. Taking it is one
 * atomic step, so two processes started at the same instant cannot both succeed; and the operating system releases it
 * when the process exits or dies, so there is no abandoned lock to judge and take over. A sidecar file says who holds
 * it, for the message a refused process prints; it decides nothing.
 *
 * Earlier versions locked `<file>.lock`: first as a JSON note naming a pid, then as a SQLite lock like this one. That
 * file is never reused, because what an earlier version left there cannot be told apart from a live lock by contents
 * alone and cannot be replaced without a race. It is only consulted: an earlier version still running with the database
 * open refuses this start; a note left by one that died is removed.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface WriterLock {
  readonly path: string;
  readonly release: () => void;
}

/** Held locks stay reachable until released: a collected handle would close and silently drop the lock. */
const held = new Set<DatabaseSync>();

/** Throws when an earlier version of Overwatch, with the old lock file, still has the database open. */
function refuseEarlierVersion(databaseFile: string) {
  const legacy = `${databaseFile}.lock`;
  if (!existsSync(legacy)) return;
  const text = (() => {
    try {
      return readFileSync(legacy, "utf8");
    } catch {
      return "";
    }
  })();
  if (text.trimStart().startsWith("{")) {
    // The first lock format: a note naming its process. Alive is busy; dead is a leftover from a crash.
    let pid: number | undefined;
    try {
      pid = (JSON.parse(text) as { pid?: number }).pid;
    } catch {
      pid = undefined;
    }
    if (pid !== undefined && pid !== process.pid && alive(pid)) {
      throw new Error(`Another Overwatch service (an earlier version, pid ${pid}) has ${databaseFile} open. Stop it first.`);
    }
    rmSync(legacy, { force: true });
    return;
  }
  if (text.startsWith("SQLite format 3")) {
    // The second format: a SQLite lock. Held means an earlier version is running.
    const db = new DatabaseSync(legacy);
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("ROLLBACK");
    } catch (error) {
      if (/locked|busy/i.test((error as Error).message)) throw new Error(`Another Overwatch service (an earlier version) has ${databaseFile} open. Stop it first.`);
    } finally {
      db.close();
    }
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function acquireWriterLock(databaseFile: string, purpose = "service"): WriterLock {
  refuseEarlierVersion(databaseFile);
  const path = `${databaseFile}.writer`;
  const info = `${path}.holder`;
  const db = new DatabaseSync(path);
  // Contenders starting together can all be turned back by each other's half-taken locks; a few tries with a random
  // pause settle it. A live holder keeps the lock through all of them.
  let taken = false;
  let failure: unknown;
  for (let attempt = 0; attempt < 12 && !taken; attempt++) {
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
      taken = true;
    } catch (error) {
      failure = error;
      if (!/locked|busy/i.test((error as Error).message)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
    }
  }
  if (!taken) {
    db.close();
    if (!/locked|busy/i.test((failure as Error)?.message ?? "")) throw failure;
    let holder: { pid?: number; purpose?: string; since?: string } = {};
    try {
      holder = JSON.parse(readFileSync(info, "utf8"));
    } catch {
      // The holder has not written its note yet, or it is unreadable: the lock itself is what counts.
    }
    const who = holder.pid === process.pid ? "in this process" : holder.pid ? `(pid ${holder.pid}, since ${holder.since ?? "unknown"})` : "(it has not said which)";
    throw new Error(`Another Overwatch ${holder.purpose ?? "service"} ${who} has ${databaseFile} open. Stop it first.`);
  }
  held.add(db);
  writeFileSync(info, JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() }));
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      try {
        const holder = JSON.parse(readFileSync(info, "utf8")) as { pid?: number };
        if (holder.pid === process.pid) rmSync(info, { force: true });
      } catch {
        // Already gone.
      }
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
        held.delete(db);
      }
    },
  };
}
