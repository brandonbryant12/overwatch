/**
 * Backup and restore. A backup is a consistent copy of the one SQLite file (`VACUUM INTO`), safe to take while the
 * service runs: it carries the journal, the model's storage, schedules, receipts, unfinished runs and the plain
 * tables together. Restoring needs the service stopped; it is refused while one has the database open.
 */
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { acquireWriterLock } from "../host/lock.ts";

export function backup(databaseFile: string, target: string) {
  if (existsSync(target)) throw new Error(`${target} exists; choose a new file`);
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

/** The tables an Overwatch database has: the host's and the service's. */
const REQUIRED_TABLES = ["objects", "alarms", "journal", "checkpoints", "coverage", "run_tokens", "shown", "projections"];

/** Checks a database file is a whole Overwatch database. Throws with the reason if not. */
export function validateBackup(file: string) {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    throw new Error(`${file} is not an Overwatch backup: it does not open as a database (${(error as Error).message})`);
  }
  try {
    let tables: string[];
    try {
      tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    } catch (error) {
      throw new Error(`${file} is not an Overwatch backup: ${(error as Error).message}`);
    }
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`${file} is not an Overwatch backup: it has no ${missing.join(", ")} table(s)`);
    const check = (db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
    if (check.join() !== "ok") throw new Error(`${file} is not an Overwatch backup: the integrity check failed (${check.slice(0, 3).join("; ")})`);
  } finally {
    db.close();
  }
}

/**
 * Replaces the database with a backup. The backup is copied next to the database, the copy is checked (it opens,
 * it has Overwatch's tables, SQLite's integrity check passes), and only then does it replace the database, in one
 * rename, holding the writer lock so no service has the database open meanwhile.
 */
export function restore(backupFile: string, databaseFile: string) {
  if (!existsSync(backupFile)) throw new Error(`${backupFile} does not exist`);
  const lock = acquireWriterLock(databaseFile, "restore");
  const staged = `${databaseFile}.restoring-${process.pid}`;
  try {
    copyFileSync(backupFile, staged);
    validateBackup(staged);
    for (const suffix of ["-wal", "-shm"]) rmSync(databaseFile + suffix, { force: true });
    renameSync(staged, databaseFile);
  } finally {
    rmSync(staged, { force: true });
    lock.release();
  }
}

/** Forgets the search index; the service rebuilds it from the journal when it starts. */
export function clearSearch(databaseFile: string) {
  const lock = acquireWriterLock(databaseFile, "search rebuild");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("DELETE FROM search_terms; DELETE FROM search_docs; DELETE FROM projections WHERE name = 'search';");
  } finally {
    db.close();
    lock.release();
  }
}
