/**
 * The writer lock: one process at a time may open a database for writing. Each process's connection lock and its
 * start-up repairs (clearing leases a dead process left, re-arming alarms) are only correct if no other process has
 * the file open, so the lock is taken before anything is opened or repaired.
 *
 * It is a file next to the database, created exclusively, holding the owner's pid. A lock whose owner is no longer
 * running (it crashed or was killed) is taken over; one whose owner is running is refused with who holds it.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface WriterLock {
  readonly path: string;
  readonly release: () => void;
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
  const path = `${databaseFile}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, purpose, since: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
            if (owner.pid === process.pid) unlinkSync(path);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number; purpose?: string; since?: string } = {};
      try {
        owner = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        // Unreadable: written by a process that died while creating it.
      }
      if (typeof owner.pid === "number" && owner.pid !== process.pid && alive(owner.pid)) {
        throw new Error(
          `Another Overwatch ${owner.purpose ?? "process"} (pid ${owner.pid}, since ${owner.since ?? "unknown"}) has ${databaseFile} open. ` +
            `Stop it first. If you are sure it is not running, remove ${path}.`,
        );
      }
      if (owner.pid === process.pid) throw new Error(`Another Overwatch ${owner.purpose ?? "service"} in this process has ${databaseFile} open.`);
      unlinkSync(path);
    }
  }
  throw new Error(`Could not take the lock ${path}`);
}
