/**
 * The writer lock: one process at a time may open a database for writing. Each process's connection lock and its
 * start-up repairs (clearing leases a dead process left, re-arming alarms) are only correct if no other process has
 * the file open, so the lock is taken before anything is opened or repaired.
 *
 * The lock is held by the operating system, not by a file's contents: a small SQLite database next to the database
 * (`<file>.lock`), kept in an EXCLUSIVE transaction for as long as the process holds the lock. Taking it is one
 * atomic step, so two processes started at the same instant cannot both succeed; and the operating system releases it
 * when the process exits or dies, so there is no abandoned lock to judge and take over. A sidecar file says who holds
 * it, for the message a refused process prints; it decides nothing.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface WriterLock {
  readonly path: string;
  readonly release: () => void;
}

/** Held locks stay reachable until released: a collected handle would close and silently drop the lock. */
const held = new Set<DatabaseSync>();

export function acquireWriterLock(databaseFile: string, purpose = "service"): WriterLock {
  const path = `${databaseFile}.lock`;
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
