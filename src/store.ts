/**
 * Storage: one SQLite file, one owner, one writer.
 *
 * Ownership is SQLite's own lock. The owner sets exclusive locking, enters WAL and commits a write before it looks at
 * the schema or listens on a port; the operating system holds that lock until the process ends, however it ends. A
 * second process of any version, or any other SQLite program, gets "database is locked" and stops. There are no lock
 * files.
 *
 * Every change is one `BEGIN IMMEDIATE` transaction through `tx`, and a change appends to `events` in the same
 * transaction. `events.seq` is the only clock for "before" and "after". The writer cleans every string and every JSON
 * value it is given (see redact.ts), so text that did not pass redaction cannot be stored.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clean, cleanDeep, type Clean } from "./redact.ts";
export type { Clean };
import { clock } from "./clock.ts";

export const APPLICATION_ID = 0x4f575432;
export const USER_VERSION = 1;

/** Each table: its DDL, and which of its columns hold JSON. Restore copies exactly these columns, in this order. */
export const TABLES: ReadonlyArray<{ name: string; ddl: string; columns: ReadonlyArray<string>; json?: ReadonlyArray<string> }> = [
  {
    name: "events",
    ddl: `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
      subject TEXT, actor TEXT NOT NULL, data TEXT NOT NULL CHECK (json_valid(data)))`,
    columns: ["seq", "at_ms", "kind", "subject", "actor", "data"],
    json: ["data"],
  },
  { name: "meta", ddl: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`, columns: ["key", "value"] },
  {
    name: "sources",
    ddl: `CREATE TABLE sources (id TEXT PRIMARY KEY, checkpoint_ms INTEGER, failure TEXT CHECK (failure IN ('signin','permission','rate','unreachable','config')),
      streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0), next_ms INTEGER, suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)), fix TEXT, endpoint TEXT)`,
    columns: ["id", "checkpoint_ms", "failure", "streak", "next_ms", "suspended", "fix", "endpoint"],
  },
  {
    name: "readings",
    ddl: `CREATE TABLE readings (source TEXT NOT NULL, reading TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('ok','capped','gap','failed')),
      at_ms INTEGER NOT NULL, ok_ms INTEGER, PRIMARY KEY (source, reading))`,
    columns: ["source", "reading", "state", "at_ms", "ok_ms"],
  },
  {
    name: "coverage",
    ddl: `CREATE TABLE coverage (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, source TEXT NOT NULL, reading TEXT NOT NULL, from_ms INTEGER NOT NULL,
      to_ms INTEGER NOT NULL CHECK (to_ms >= from_ms), state TEXT NOT NULL CHECK (state IN ('ok','capped','gap','failed')), missed INTEGER CHECK (missed >= 0))`,
    columns: ["id", "seq", "source", "reading", "from_ms", "to_ms", "state", "missed"],
  },
  {
    name: "incidents",
    ddl: `CREATE TABLE incidents (id TEXT PRIMARY KEY, app TEXT NOT NULL, environment TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('error','warn','info')), count INTEGER NOT NULL CHECK (count >= 0), exact INTEGER NOT NULL CHECK (exact IN (0,1)),
      first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL, seq INTEGER NOT NULL)`,
    columns: ["id", "app", "environment", "source", "title", "severity", "count", "exact", "first_ms", "last_ms", "seq"],
  },
  {
    name: "occurrences",
    ddl: `CREATE TABLE occurrences (key TEXT PRIMARY KEY, source TEXT NOT NULL, at_ms INTEGER NOT NULL)`,
    columns: ["key", "source", "at_ms"],
  },
  {
    name: "baselines",
    ddl: `CREATE TABLE baselines (key TEXT PRIMARY KEY, source TEXT NOT NULL, count INTEGER NOT NULL CHECK (count >= 0), seen_ms INTEGER NOT NULL)`,
    columns: ["key", "source", "count", "seen_ms"],
  },
  {
    name: "saturated",
    ddl: `CREATE TABLE saturated (source TEXT NOT NULL, reading TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL CHECK (to_ms >= from_ms), PRIMARY KEY (source, reading, from_ms))`,
    columns: ["source", "reading", "from_ms", "to_ms"],
  },
  {
    name: "metrics",
    ddl: `CREATE TABLE metrics (source TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (source, name))`,
    columns: ["source", "name", "value", "at_ms"],
  },
  {
    name: "deploys",
    ddl: `CREATE TABLE deploys (seq INTEGER PRIMARY KEY, app TEXT NOT NULL, environment TEXT NOT NULL, revision TEXT NOT NULL, previous TEXT)`,
    columns: ["seq", "app", "environment", "revision", "previous"],
  },
  {
    name: "jobs",
    ddl: `CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','completed','parked')), reason TEXT, created_seq INTEGER NOT NULL)`,
    columns: ["id", "kind", "subject", "title", "state", "reason", "created_seq"],
  },
  {
    name: "runs",
    ddl: `CREATE TABLE runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL CHECK (attempt >= 1),
      session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('active','terminal')), calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
      code TEXT NOT NULL CHECK (json_valid(code)), started_ms INTEGER NOT NULL, UNIQUE (job_id, attempt))`,
    columns: ["id", "job_id", "attempt", "session_id", "state", "calls", "code", "started_ms"],
    json: ["code"],
  },
  {
    name: "messages",
    ddl: `CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), purpose TEXT NOT NULL CHECK (purpose IN ('prompt','nudge')))`,
    columns: ["id", "run_id", "purpose"],
  },
  {
    name: "evidence",
    ddl: `CREATE TABLE evidence (handle TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), session_id TEXT NOT NULL, source TEXT NOT NULL,
      text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 16384), ordinal INTEGER NOT NULL, UNIQUE (run_id, source, ordinal))`,
    columns: ["handle", "run_id", "session_id", "source", "text", "ordinal"],
  },
  {
    name: "findings",
    ddl: `CREATE TABLE findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), verdict TEXT NOT NULL CHECK (verdict IN ('real','not_real','unsure')),
      claims TEXT NOT NULL CHECK (json_valid(claims)), code TEXT NOT NULL CHECK (json_valid(code)), body TEXT NOT NULL CHECK (json_valid(body)))`,
    columns: ["id", "run_id", "verdict", "claims", "code", "body"],
    json: ["claims", "code", "body"],
  },
];

const MAINTENANCE = `CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL CHECK (active IN (0,1)));
INSERT INTO maintenance VALUES (1, 0);
CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events WHEN (SELECT active FROM maintenance) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only outside maintenance'); END;
CREATE INDEX occurrences_age ON occurrences (source, at_ms);
CREATE INDEX coverage_recent ON coverage (source, reading, id);
CREATE INDEX incidents_place ON incidents (app, environment);`;

export class Busy extends Error {}
export class Incompatible extends Error {}

/** Identifiers Overwatch generates (hex digests, random hex): stored as they are. */
declare const idBrand: unique symbol;
export type Id = string & { readonly [idBrand]: "id" };
export const id = (value: string): Id => {
  if (!/^[a-z]{0,4}[_-]?[0-9a-f]{8,64}$/.test(value)) throw new Error(`not a generated identifier: ${value.slice(0, 20)}`);
  return value as Id;
};

export class Json {
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}
export const json = (value: unknown) => new Json(value);
export type Param = number | bigint | null | Clean | Id | Json;

/** The crash-test counter: after every mutating statement and every commit, and a kill at the armed count. */
export const trace = { count: 0, killAfter: null as number | null };
function tick() {
  trace.count++;
  if (trace.killAfter !== null && trace.count >= trace.killAfter) {
    process.kill(process.pid, "SIGKILL");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}

/** Normalises one value at the boundary: strings are cleaned, JSON is cleaned throughout and serialised. */
function normal(value: unknown): number | bigint | null | string {
  if (value instanceof Json) return JSON.stringify(cleanDeep(value.value));
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "bigint" || value === null) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error(`the writer cannot store ${typeof value}`);
}

export class Writer {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  run(sql: string, ...params: ReadonlyArray<Param>): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params.map(normal));
    tick();
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  /** Appends to the log and returns its seq. */
  event(kind: string, subject: string | null, data: unknown, actor = "overwatch"): number {
    return this.run("INSERT INTO events (at_ms, kind, subject, actor, data) VALUES (?, ?, ?, ?, ?)", clock.now(), kind as Clean, subject as Clean | null, actor as Clean, json(data)).lastInsertRowid;
  }
}

export class Store {
  readonly writer: Writer;
  private listeners = new Set<() => void>();
  readonly db: DatabaseSync;
  readonly file: string;
  constructor(db: DatabaseSync, file: string) {
    this.db = db;
    this.file = file;
    this.writer = new Writer(db);
  }

  /**
   * Takes ownership of the data directory's database, or throws Busy. Exclusive locking, WAL and a committed write
   * come first; only then is the schema read or created.
   */
  static own(dataDir: string): Store {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dataDir, 0o700);
    } catch {
      // Not ours to change; the doctor says so.
    }
    const file = join(dataDir, "overwatch.db");
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file);
    } catch (error) {
      throw new Busy(`cannot open ${file}: ${(error as Error).message}`);
    }
    try {
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("BEGIN IMMEDIATE; COMMIT;");
    } catch (error) {
      db.close();
      const message = (error as Error).message;
      if (/locked|busy/i.test(message)) throw new Busy(`${file} is in use by another process`);
      throw new Incompatible(`${file} is not an Overwatch database (${message})`);
    }
    db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    const app = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get() as { n: number }).n;
    if (app === 0 && version === 0 && tables === 0) {
      db.exec("BEGIN IMMEDIATE");
      for (const t of TABLES) db.exec(t.ddl);
      db.exec(MAINTENANCE);
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${USER_VERSION};`);
      db.exec("COMMIT");
    } else if (app !== APPLICATION_ID || version !== USER_VERSION) {
      db.close();
      throw new Incompatible(
        app !== APPLICATION_ID ? `${file} is not an Overwatch database` : `${file} has schema version ${version}; this program reads version ${USER_VERSION}`,
      );
    }
    return new Store(db, file);
  }

  /** One change: one IMMEDIATE transaction. Listeners hear of it after it commits. */
  tx<A>(work: (w: Writer) => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    let result: A;
    try {
      result = work(this.writer);
      this.db.exec("COMMIT");
    } catch (error) {
      // A failed change is undone whole. (A statement that raises leaves the transaction open, so this always runs.)
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back.
      }
      throw error;
    }
    tick();
    for (const listener of this.listeners) listener();
    return result;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: ReadonlyArray<number | string | null>): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  get<T = Record<string, unknown>>(sql: string, ...params: ReadonlyArray<number | string | null>): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  seq(): number {
    return (this.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'")?.seq ?? 0) as number;
  }
  meta(key: string): string | null {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
  }
  onCommit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  /** A consistent standalone copy. Never overwrites a file. */
  backup(target: string): { file: string; seq: number } {
    if (existsSync(target)) throw new Error(`${target} exists; choose a new file`);
    const seq = this.seq();
    this.db.prepare("VACUUM INTO ?").run(target);
    return { file: target, seq };
  }

  /**
   * Replaces every row with a backup's, in one transaction on this owned connection: the file and its lock never
   * change. The backup is opened read-only, checked (its identity, version and integrity), and only its known columns
   * are read as values; every value passes the writer, so constraints and redaction apply exactly as to new data. Any
   * failure rolls back and leaves the current rows as they were. No SQL from the backup runs.
   */
  restore(source: string): { file: string; seq: number } {
    let backup: DatabaseSync;
    try {
      backup = new DatabaseSync(source, { readOnly: true });
    } catch (error) {
      throw new Incompatible(`${source} does not open as a database`);
    }
    try {
      let app: number, version: number, integrity: string;
      try {
        app = (backup.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
        version = (backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        integrity = (backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      } catch {
        throw new Incompatible(`${source} is not an Overwatch backup: it is not a database`);
      }
      if (app !== APPLICATION_ID) throw new Incompatible(`${source} is not an Overwatch backup`);
      if (version !== USER_VERSION) throw new Incompatible(`${source} has schema version ${version}; this program restores version ${USER_VERSION}`);
      if (integrity !== "ok") throw new Incompatible(`${source} fails SQLite's integrity check`);
      const present = new Set((backup.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
      for (const t of TABLES) if (!present.has(t.name)) throw new Incompatible(`${source} has no ${t.name} table`);
      const high = (backup.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined)?.seq ?? 0;
      try {
        this.tx((w) => {
          w.run("UPDATE maintenance SET active = 1");
          for (const t of [...TABLES].reverse()) w.run(`DELETE FROM ${t.name}`);
          for (const t of TABLES) {
            const placeholders = t.columns.map(() => "?").join(", ");
            const insert = `INSERT INTO ${t.name} (${t.columns.join(", ")}) VALUES (${placeholders})`;
            // The statement is held for the whole loop: Node may finalize an unreferenced one mid-iteration.
            const select = backup.prepare(`SELECT ${t.columns.map((c) => `"${c}"`).join(", ")} FROM main."${t.name}"`);
            for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
              w.run(insert, ...t.columns.map((c) => valueOf(row[c], t.json?.includes(c) ?? false)));
            }
          }
          w.run("DELETE FROM sqlite_sequence WHERE name = 'events'");
          w.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)", Math.max(high, this.get<{ m: number }>("SELECT coalesce(max(seq), 0) AS m FROM events")!.m));
          w.run("UPDATE maintenance SET active = 0");
        });
      } catch (error) {
        throw new Incompatible(`${source} cannot be restored: ${clean((error as Error).message, 300)}`);
      }
      return { file: source, seq: this.seq() };
    } finally {
      backup.close();
    }
  }

  /** Drops old history in one audited transaction; counts and the sequence are kept. */
  compact(keepEvents = 10_000): number {
    return this.tx((w) => {
      const throughSeq = Math.max(0, this.seq() - keepEvents);
      w.run("UPDATE maintenance SET active = 1");
      w.run("DELETE FROM events WHERE seq <= ?", throughSeq);
      w.run("UPDATE maintenance SET active = 0");
      w.event("compacted", null, { throughSeq });
      return throughSeq;
    });
  }
}

function valueOf(value: unknown, isJson: boolean): Param {
  if (value === null || value === undefined) return null;
  if (isJson) {
    if (typeof value !== "string") throw new Error("a JSON column holds something that is not text");
    return json(JSON.parse(value));
  }
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string") return value as Clean;
  throw new Error("a column holds a value of an unknown kind");
}

/** The discovery record a running service leaves: it routes requests and never establishes ownership. */
export interface Discovery {
  readonly url: string;
  readonly pid: number;
  readonly version: 2;
}
export function readDiscovery(dataDir: string): Discovery | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "service.json"), "utf8")) as Discovery;
    return typeof value.url === "string" && typeof value.pid === "number" ? value : null;
  } catch {
    return null;
  }
}
