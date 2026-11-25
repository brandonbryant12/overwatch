/**
 * Backup and restore. A backup is a consistent copy of the one SQLite file (`VACUUM INTO`), safe to take while the
 * service runs: it carries the journal, the model's storage, schedules, receipts, unfinished runs and the plain
 * tables together. Restoring replaces the file while the service is stopped.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function backup(databaseFile: string, target: string) {
  if (existsSync(target)) throw new Error(`${target} exists; choose a new file`);
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
}

export function restore(backupFile: string, databaseFile: string) {
  if (!existsSync(backupFile)) throw new Error(`${backupFile} does not exist`);
  for (const suffix of ["-wal", "-shm"]) rmSync(databaseFile + suffix, { force: true });
  copyFileSync(backupFile, databaseFile);
}

/** Forgets the search index; the service rebuilds it from the journal when it starts. */
export function clearSearch(databaseFile: string) {
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("DELETE FROM search_terms; DELETE FROM search_docs; DELETE FROM projections WHERE name = 'search';");
  } finally {
    db.close();
  }
}
