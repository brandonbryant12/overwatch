/**
 * The service's own tables, next to the host's in the same SQLite file. They hold operational state that is not an
 * event: polling checkpoints and covered windows, de-duplication state, run tokens, what each session was shown,
 * worktrees, and the search projection. Every access goes through the connection's lock.
 */
import type { DatabaseSync } from "node:sqlite";
import { redactText } from "../domain/redact.ts";

export const SERVICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    watcher TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, seen TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (watcher, source)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS coverage (
    id INTEGER PRIMARY KEY, watcher TEXT NOT NULL, source TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
    status TEXT NOT NULL, note TEXT, run_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS coverage_watcher ON coverage (watcher, source, to_at);
  CREATE TABLE IF NOT EXISTS watcher_runs (
    watcher TEXT PRIMARY KEY, next_at INTEGER NOT NULL, last_started INTEGER, last_finished INTEGER, last_error TEXT, last_summary TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS run_tokens (
    token TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    subject TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS shown (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT, source TEXT NOT NULL,
    text TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (session_id, run_id, source, text)
  );
  CREATE INDEX IF NOT EXISTS shown_session ON shown (session_id);
  CREATE TABLE IF NOT EXISTS worktrees (
    thread_id TEXT PRIMARY KEY, path TEXT NOT NULL, checkout TEXT, commit_sha TEXT, created_at INTEGER NOT NULL,
    deployed INTEGER NOT NULL DEFAULT 0, note TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS capacity (
    watcher TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (watcher, source)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS pending_reports (
    id INTEGER PRIMARY KEY, watcher TEXT NOT NULL, kind TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_reads (session_id TEXT PRIMARY KEY, last_message TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS projections (name TEXT PRIMARY KEY, position INTEGER NOT NULL, version INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS search_docs (
    doc TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    app TEXT, environment TEXT, state TEXT, at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS search_terms (term TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (term, doc)) WITHOUT ROWID;
`;

/** Columns added after a table was first shipped: added to databases that predate them. */
const ADDED_COLUMNS: ReadonlyArray<readonly [table: string, column: string, definition: string]> = [
  ["worktrees", "deployed", "INTEGER NOT NULL DEFAULT 0"],
  ["worktrees", "note", "TEXT"],
];

export function createServiceTables(db: DatabaseSync) {
  db.exec(SERVICE_SCHEMA);
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export interface ShownRow {
  readonly source: string;
  readonly text: string;
}

export const shownFor = (db: DatabaseSync, sessionId: string): ShownRow[] =>
  db.prepare("SELECT source, text FROM shown WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as ShownRow[];

export const recordShown = (db: DatabaseSync, row: { sessionId: string; threadId: string; runId?: string; source: string; text: string; at: number }) =>
  db
    .prepare("INSERT OR IGNORE INTO shown (session_id, thread_id, run_id, source, text, at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.sessionId, row.threadId, row.runId ?? null, row.source, redactText(row.text, { maxBytes: 64_000 }), row.at);

export interface TokenRow {
  readonly token: string;
  readonly run_id: string;
  readonly session_id: string;
  readonly thread_id: string;
  readonly subject: string;
  readonly role: string;
}

export const tokenRow = (db: DatabaseSync, token: string) =>
  db.prepare("SELECT token, run_id, session_id, thread_id, subject, role FROM run_tokens WHERE token = ?").get(token) as TokenRow | undefined;
