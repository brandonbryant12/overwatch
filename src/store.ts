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
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Cause, Context, Effect, FileSystem, Layer, Path, Predicate, PubSub, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError } from "effect/sql";
import { BackupError, Busy, Full, Incompatible } from "./errors.ts";
export { BackupError, Busy, Full, Incompatible };
import { clean, cleanDeep, type Clean } from "./redact.ts";
export type { Clean };
import { clock } from "./clock.ts";
import { LIMITS } from "./config.ts";

export const APPLICATION_ID = 0x4f575432;
export const USER_VERSION = 1;

/** Each table: its DDL, and which of its columns hold JSON. Restore copies exactly these columns, in this order. */
/**
 * The schema, declared once: every table is created from its DDL here, and every column is listed, either as data or,
 * in `refs`, as a reference to a named parent ("table.key"). Restore checks every declared reference, whatever the
 * column is called; a unit test fails the build when a created table has a column this list does not declare.
 */
export const TABLES: ReadonlyArray<{ name: string; ddl: string; columns: ReadonlyArray<string>; refs?: Readonly<Record<string, string>>; json?: ReadonlyArray<string>; derived?: boolean }> = [
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
      streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0), next_ms INTEGER, suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)), fix TEXT, endpoint TEXT,
      delay_ms INTEGER CHECK (delay_ms >= 0))`,
    columns: ["id", "checkpoint_ms", "failure", "streak", "next_ms", "suspended", "fix", "endpoint", "delay_ms"],
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
      first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL, seq INTEGER NOT NULL,
      reading TEXT NOT NULL DEFAULT 'logs', active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
      way TEXT CHECK (way IS NULL OR json_valid(way)), returned TEXT CHECK (returned IS NULL OR json_valid(returned)),
      seen_seq INTEGER NOT NULL DEFAULT 0 CHECK (seen_seq >= 0), first_seq INTEGER NOT NULL DEFAULT 0, decided_seq INTEGER NOT NULL DEFAULT 0 CHECK (decided_seq >= 0))`,
    columns: ["id", "app", "environment", "source", "title", "severity", "count", "exact", "first_ms", "last_ms", "seq", "reading", "active", "streak", "way", "returned", "seen_seq", "first_seq", "decided_seq"],
    json: ["way", "returned"],
  },
  {
    name: "occurrences",
    ddl: `CREATE TABLE occurrences (key TEXT PRIMARY KEY, source TEXT NOT NULL, stream TEXT NOT NULL DEFAULT '', at_ms INTEGER NOT NULL, incident TEXT NOT NULL DEFAULT '')`,
    columns: ["key", "source", "stream", "at_ms", "incident"],
    refs: { incident: "incidents.id" },
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
    ddl: `CREATE TABLE metrics (source TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, at_ms INTEGER NOT NULL,
      over INTEGER NOT NULL DEFAULT 0 CHECK (over >= 0), under INTEGER NOT NULL DEFAULT 0 CHECK (under >= 0), breach INTEGER NOT NULL DEFAULT 0 CHECK (breach IN (0,1)), PRIMARY KEY (source, name))`,
    columns: ["source", "name", "value", "at_ms", "over", "under", "breach"],
  },
  {
    name: "deploys",
    ddl: `CREATE TABLE deploys (seq INTEGER PRIMARY KEY, app TEXT NOT NULL, environment TEXT NOT NULL, revision TEXT NOT NULL, previous TEXT)`,
    columns: ["seq", "app", "environment", "revision", "previous"],
  },
  {
    name: "jobs",
    ddl: `CREATE TABLE jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','completed','parked')), reason TEXT, created_seq INTEGER NOT NULL,
      inputs TEXT CHECK (inputs IS NULL OR json_valid(inputs)), result TEXT CHECK (result IS NULL OR json_valid(result)), attribution TEXT,
      closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1)))`,
    columns: ["id", "kind", "subject", "title", "state", "reason", "created_seq", "inputs", "result", "attribution", "closed"],
    json: ["inputs", "result"],
  },
  {
    name: "runs",
    ddl: `CREATE TABLE runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL CHECK (attempt >= 1),
      session_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('active','terminal')), calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
      code TEXT NOT NULL CHECK (json_valid(code)), started_ms INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'reader', slot INTEGER, work_id TEXT,
      UNIQUE (job_id, attempt))`,
    columns: ["id", "job_id", "attempt", "session_id", "state", "calls", "code", "started_ms", "role", "slot", "work_id"],
    refs: { job_id: "jobs.id" },
    json: ["code"],
  },
  {
    name: "messages",
    ddl: `CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), purpose TEXT NOT NULL CHECK (purpose IN ('prompt','nudge')))`,
    columns: ["id", "run_id", "purpose"],
    refs: { run_id: "runs.id" },
  },
  {
    name: "evidence",
    ddl: `CREATE TABLE evidence (handle TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), session_id TEXT NOT NULL, source TEXT NOT NULL,
      text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 16384), ordinal INTEGER NOT NULL, UNIQUE (run_id, source, ordinal))`,
    columns: ["handle", "run_id", "session_id", "source", "text", "ordinal"],
    refs: { run_id: "runs.id" },
  },
  {
    // What a piece of evidence is, apart from what its source is called. A piece without a row here is not
    // telemetry: an origin that was never recorded cannot make a verdict observed.
    name: "origins",
    ddl: `CREATE TABLE origins (handle TEXT PRIMARY KEY REFERENCES evidence(handle) ON DELETE CASCADE,
      origin TEXT NOT NULL CHECK (origin IN ('telemetry','code','history','generated')))`,
    columns: ["handle", "origin"],
    refs: { handle: "evidence.handle" },
  },
  {
    name: "hourly",
    ddl: `CREATE TABLE hourly (incident TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL CHECK (count >= 0), PRIMARY KEY (incident, hour))`,
    columns: ["incident", "hour", "count"],
    refs: { incident: "incidents.id" },
  },
  {
    name: "asks",
    ddl: `CREATE TABLE asks (key TEXT PRIMARY KEY, subject TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), mode TEXT NOT NULL CHECK (mode IN ('new','continue')),
      text TEXT NOT NULL, digest TEXT NOT NULL, seq INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','answered','failed')), session_id TEXT, answer TEXT, reason TEXT, message TEXT)`,
    columns: ["key", "subject", "job_id", "mode", "text", "digest", "seq", "state", "session_id", "answer", "reason", "message"],
    refs: { job_id: "jobs.id" },
  },
  {
    // Agent work, one item per reading, challenge or answer: the queue the two slots take from, owner questions first.
    name: "work",
    ddl: `CREATE TABLE work (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), kind TEXT NOT NULL CHECK (kind IN ('reading','challenge','answer')),
      slot INTEGER, priority INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('queued','running','done','missing')), tries INTEGER NOT NULL DEFAULT 0,
      ask_key TEXT, run_id TEXT REFERENCES runs(id), reason TEXT, seq INTEGER NOT NULL)`,
    columns: ["id", "job_id", "kind", "slot", "priority", "state", "tries", "ask_key", "run_id", "reason", "seq"],
    refs: { job_id: "jobs.id", run_id: "runs.id" },
  },
  {
    // Idempotent owner requests (investigate, open, correct): the key binds to the operation and its payload.
    name: "requests",
    ddl: `CREATE TABLE requests (key TEXT PRIMARY KEY, op TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL CHECK (json_valid(result)))`,
    columns: ["key", "op", "digest", "result"],
    json: ["result"],
  },
  {
    name: "corrections",
    ddl: `CREATE TABLE corrections (seq INTEGER PRIMARY KEY, app TEXT NOT NULL, subject TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id), text TEXT NOT NULL, date TEXT NOT NULL)`,
    columns: ["seq", "app", "subject", "job_id", "text", "date"],
    refs: { job_id: "jobs.id" },
  },
  {
    name: "notifications",
    ddl: `CREATE TABLE notifications (id TEXT PRIMARY KEY, subject TEXT NOT NULL REFERENCES incidents(id), cause_seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','sending','delivered','parked')), attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER, delay_ms INTEGER,
      reason TEXT, title TEXT NOT NULL, body TEXT NOT NULL, UNIQUE (subject, cause_seq))`,
    columns: ["id", "subject", "cause_seq", "state", "attempts", "next_ms", "delay_ms", "reason", "title", "body"],
    refs: { subject: "incidents.id" },
  },
  {
    // The latest lines of each problem (cleaned), what an investigation reads as telemetry.
    name: "lines",
    ddl: `CREATE TABLE lines (incident TEXT NOT NULL, source TEXT NOT NULL, at_ms INTEGER NOT NULL, text TEXT NOT NULL)`,
    columns: ["incident", "source", "at_ms", "text"],
    refs: { incident: "incidents.id" },
  },
  {
    // When a problem was first observed, by the provider's own time (a log line's timestamp): its onset.
    name: "onsets",
    ddl: `CREATE TABLE onsets (incident TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)`,
    columns: ["incident", "at_ms"],
    refs: { incident: "incidents.id" },
  },
  {
    // When a deploy rolled out: the provider's rollout time when it gives one (exact), else the interval between the
    // last observation of the previous revision and the first of this one. Keyed by the deploy's seq.
    name: "rollouts",
    ddl: `CREATE TABLE rollouts (seq INTEGER PRIMARY KEY, after_ms INTEGER, by_ms INTEGER NOT NULL, exact INTEGER NOT NULL CHECK (exact IN (0,1)))`,
    columns: ["seq", "after_ms", "by_ms", "exact"],
  },
  {
    // Measured used capacity by the provider's time, per series (metric, unit and ceiling); a null value is a gap.
    name: "samples",
    ddl: `CREATE TABLE samples (id INTEGER PRIMARY KEY, source TEXT NOT NULL, series TEXT NOT NULL, at_ms INTEGER NOT NULL, value REAL)`,
    columns: ["id", "source", "series", "at_ms", "value"],
  },
  {
    // A staging release compared with unchanged production over two aligned intervals.
    name: "comparisons",
    ddl: `CREATE TABLE comparisons (id TEXT PRIMARY KEY, app TEXT NOT NULL, staging_revision TEXT NOT NULL, production_revision TEXT, start_seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','regression','no_signal','unknown','same_release')), reason TEXT, staging_count INTEGER, production_count INTEGER,
      data TEXT NOT NULL CHECK (json_valid(data)), incident TEXT)`,
    columns: ["id", "app", "staging_revision", "production_revision", "start_seq", "state", "reason", "staging_count", "production_count", "data", "incident"],
    refs: { incident: "incidents.id" },
    json: ["data"],
  },
  {
    // A fix attempt: one per (problem, investigation, reviewed revision, policy). Its intents are written before any
    // outside step: the candidate before verification, the head and branch before any ref changes.
    name: "fixes",
    ddl: `CREATE TABLE fixes (id TEXT PRIMARY KEY, incident TEXT NOT NULL, job_id TEXT NOT NULL, app TEXT NOT NULL, environment TEXT NOT NULL, origin TEXT NOT NULL,
      state TEXT NOT NULL, reason TEXT, previous TEXT, deployed TEXT, base TEXT, candidate TEXT, head TEXT, diff TEXT, run_id TEXT,
      data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)), seq INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0)`,
    columns: ["id", "incident", "job_id", "app", "environment", "origin", "state", "reason", "previous", "deployed", "base", "candidate", "head", "diff", "run_id", "data", "seq", "version"],
    refs: { incident: "incidents.id", job_id: "jobs.id", run_id: "runs.id" },
    json: ["data"],
  },
  {
    // What a fixer session selected: one proposal per run, final once stored.
    name: "proposals",
    ddl: `CREATE TABLE proposals (run_id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK (json_valid(body)), refused TEXT)`,
    columns: ["run_id", "body", "refused"],
    refs: { run_id: "runs.id" },
    json: ["body"],
  },
  {
    name: "findings",
    ddl: `CREATE TABLE findings (id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), verdict TEXT NOT NULL CHECK (verdict IN ('real','not_real','unsure')),
      claims TEXT NOT NULL CHECK (json_valid(claims)), code TEXT NOT NULL CHECK (json_valid(code)), body TEXT NOT NULL CHECK (json_valid(body)))`,
    columns: ["id", "run_id", "verdict", "claims", "code", "body"],
    refs: { run_id: "runs.id" },
    json: ["claims", "code", "body"],
  },
  {
    // Each cited handle, kept by a trigger on findings: evidence a finding cites cannot be deleted (RESTRICT), so
    // retention and restore get the rule from the database. Derived: never copied, rebuilt by the trigger.
    name: "citations",
    ddl: `CREATE TABLE citations (finding TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
      handle TEXT NOT NULL REFERENCES evidence(handle) ON DELETE RESTRICT, PRIMARY KEY (finding, handle))`,
    columns: ["finding", "handle"],
    refs: { finding: "findings.id", handle: "evidence.handle" },
    derived: true,
  },
];

const INDEXES: ReadonlyArray<string> = [
  "CREATE INDEX IF NOT EXISTS occurrences_age ON occurrences (source, at_ms)",
  "CREATE INDEX IF NOT EXISTS occurrences_stream ON occurrences (stream, at_ms)",
  "CREATE INDEX IF NOT EXISTS coverage_recent ON coverage (source, reading, id)",
  "CREATE INDEX IF NOT EXISTS incidents_place ON incidents (app, environment)",
  "CREATE INDEX IF NOT EXISTS hourly_age ON hourly (hour)",
  "CREATE INDEX IF NOT EXISTS jobs_subject ON jobs (subject, state)",
  "CREATE INDEX IF NOT EXISTS lines_incident ON lines (incident, at_ms)",
  "CREATE INDEX IF NOT EXISTS work_queue ON work (state, priority, seq)",
  "CREATE INDEX IF NOT EXISTS samples_series ON samples (source, id)",
  "CREATE INDEX IF NOT EXISTS fixes_job ON fixes (job_id)",
];

/** Tables added within version 1: created on open when absent, and empty when restoring a backup that lacks them. */
const ADDED_TABLES = new Set(["onsets", "rollouts", "samples", "comparisons", "fixes", "proposals", "origins", "hourly", "asks", "citations", "work", "requests", "corrections", "notifications", "lines"]);

/** Rules kept by the database itself; created with the schema and on open of an older file. One statement each. */
const TRIGGERS: ReadonlyArray<string> = [
  `CREATE TRIGGER IF NOT EXISTS findings_cite AFTER INSERT ON findings BEGIN
  INSERT OR IGNORE INTO citations (finding, handle)
    SELECT NEW.id, json_extract(p.value, '$.handle') FROM json_each(NEW.claims) c, json_each(c.value, '$.pieces') p;
END`,
];

const MAINTENANCE: ReadonlyArray<string> = [
  "CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL CHECK (active IN (0,1)))",
  "INSERT INTO maintenance VALUES (1, 0)",
  "CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END",
  `CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events WHEN (SELECT active FROM maintenance) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only outside maintenance'); END`,
  ...INDEXES,
  ...TRIGGERS,
];

/**
 * Columns added within version 1 (additive, each with a default), with their definitions. Opening a file that lacks
 * one adds it in one transaction; restoring a backup that lacks one leaves it at its default. An earlier build of
 * version 1 reading a file with them ignores the columns it does not know.
 */
const ADDED: ReadonlyArray<[table: string, column: string, definition: string]> = [
  ["sources", "delay_ms", "delay_ms INTEGER CHECK (delay_ms >= 0)"],
  ["incidents", "reading", "reading TEXT NOT NULL DEFAULT 'logs'"],
  ["incidents", "active", "active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))"],
  ["incidents", "streak", "streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0)"],
  ["occurrences", "stream", "stream TEXT NOT NULL DEFAULT ''"],
  ["occurrences", "incident", "incident TEXT NOT NULL DEFAULT ''"],
  ["metrics", "over", "over INTEGER NOT NULL DEFAULT 0 CHECK (over >= 0)"],
  ["metrics", "under", "under INTEGER NOT NULL DEFAULT 0 CHECK (under >= 0)"],
  ["metrics", "breach", "breach INTEGER NOT NULL DEFAULT 0 CHECK (breach IN (0,1))"],
  ["incidents", "way", "way TEXT CHECK (way IS NULL OR json_valid(way))"],
  ["incidents", "returned", "returned TEXT CHECK (returned IS NULL OR json_valid(returned))"],
  ["incidents", "seen_seq", "seen_seq INTEGER NOT NULL DEFAULT 0 CHECK (seen_seq >= 0)"],
  ["incidents", "first_seq", "first_seq INTEGER NOT NULL DEFAULT 0"],
  ["jobs", "inputs", "inputs TEXT CHECK (inputs IS NULL OR json_valid(inputs))"],
  ["jobs", "result", "result TEXT CHECK (result IS NULL OR json_valid(result))"],
  ["jobs", "attribution", "attribution TEXT"],
  ["jobs", "closed", "closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1))"],
  ["runs", "role", "role TEXT NOT NULL DEFAULT 'reader'"],
  ["runs", "slot", "slot INTEGER"],
  ["runs", "work_id", "work_id TEXT"],
  ["asks", "state", "state TEXT NOT NULL DEFAULT 'queued'"],
  ["asks", "session_id", "session_id TEXT"],
  ["asks", "answer", "answer TEXT"],
  ["asks", "reason", "reason TEXT"],
  ["asks", "message", "message TEXT"],
  ["fixes", "version", "version INTEGER NOT NULL DEFAULT 0"],
  ["incidents", "decided_seq", "decided_seq INTEGER NOT NULL DEFAULT 0 CHECK (decided_seq >= 0)"],
];

/** Every declared reference, whatever its column is called. SQL REFERENCES are also checked by the database. */
export function references(): Array<[table: string, column: string, parent: string, key: string]> {
  return TABLES.flatMap((t) => Object.entries(t.refs ?? {}).map(([column, to]) => [t.name, column, ...to.split(".")] as [string, string, string, string]));
}

/**
 * What every consistent database satisfies beyond its column constraints: each query counts violations. Restore
 * checks them on the staged rows before it commits, so a backup that is intact but impossible is refused whole.
 */
const INVARIANTS: ReadonlyArray<[what: string, sql: string]> = [
  ["a row refers to a sequence number that was never issued", `SELECT (SELECT count(*) FROM incidents WHERE seq > h.s) + (SELECT count(*) FROM coverage WHERE seq > h.s)
    + (SELECT count(*) FROM deploys WHERE seq > h.s) + (SELECT count(*) FROM jobs WHERE created_seq > h.s) + (SELECT count(*) FROM events WHERE seq > h.s)
    FROM (SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS s) h`],
  ["a disposition or return names a sequence number that was never issued", `SELECT count(*) FROM incidents, (SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'events'), 0) AS s) h
    WHERE coalesce(json_extract(way, '$.seq'), 0) > h.s OR coalesce(json_extract(returned, '$.seq'), 0) > h.s OR seen_seq > h.s OR first_seq > h.s`],
  ["a finding cites evidence that is not stored for its own run", `SELECT count(*) FROM findings f, json_each(f.claims) c, json_each(c.value, '$.pieces') p
    WHERE NOT EXISTS (SELECT 1 FROM evidence v WHERE v.handle = json_extract(p.value, '$.handle') AND v.run_id = f.run_id)`],
  ["an incident's times or a source's state are impossible", `SELECT (SELECT count(*) FROM incidents WHERE last_ms < first_ms)
    + (SELECT count(*) FROM sources WHERE (failure IS NULL) <> (streak = 0))`],
];

/** Literal, case-insensitive matching across Unicode: compatibility-normalised, then folded through upper case (ß matches SS). */
export const fold = (text: string) => text.normalize("NFKC").toUpperCase().toLowerCase();

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

let issue: (p: Permit) => void = () => undefined;
/**
 * Authority for one outbound effect (a prompt, a handoff, a notice, a push, a host call). Only a Writer makes one, in
 * the transaction that records the effect's intent, and it becomes live only when that transaction commits. It is
 * spent by its one use. Constructed anywhere else, it is never live: `issue` is private to this module.
 */
export class Permit {
  readonly kind: string;
  readonly seq: number;
  /** The exact arguments this permit authorizes (operation, repository, branch, head, base): all must be in the call. */
  readonly bind: ReadonlyArray<string>;
  #live = false;
  static {
    issue = (p) => void (p.#live = true);
  }
  constructor(kind: string, seq: number, bind: ReadonlyArray<string> = []) {
    this.kind = kind;
    this.seq = seq;
    this.bind = bind;
  }
  spend(kind: string, args: ReadonlyArray<string> = []) {
    if (!this.#live || this.kind !== kind) throw new Error(`an outbound ${kind} needs a committed intent`);
    const missing = this.bind.find((b) => !args.includes(b));
    if (missing !== undefined) throw new Error(`this permit was not minted for that ${kind} (it binds ${missing})`);
    this.#live = false;
  }
}

/** A statement's outcome: rows changed and the last row inserted. */
export interface Changed {
  readonly changes: number;
  readonly lastInsertRowid: number;
}
const changed = (raw: unknown): Changed => {
  const r = Predicate.isObject(raw) && !Array.isArray(raw) ? (raw as { changes?: number | bigint; lastInsertRowid?: number | bigint }) : {};
  return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
};

/**
 * Writes inside one transaction. Each transaction gets its own, and it is dead once that transaction ends: a writer
 * kept past its transaction cannot write without admission. Every method is an Effect that runs on the transaction's
 * connection.
 */
export class Writer {
  #sql: SqlClient.SqlClient | null;
  readonly permits: Permit[] = [];
  constructor(sql: SqlClient.SqlClient) {
    this.#sql = sql;
  }
  end() {
    this.#sql = null;
  }
  get #open(): Effect.Effect<SqlClient.SqlClient> {
    return Effect.suspend(() => (this.#sql ? Effect.succeed(this.#sql) : Effect.die(new Error("this writer's transaction has ended"))));
  }
  run(query: string, ...params: ReadonlyArray<Param>): Effect.Effect<Changed> {
    return this.#open.pipe(
      Effect.flatMap((sql) => Effect.suspend(() => sql.unsafe(query, params.map(normal)).raw)),
      Effect.orDie,
      Effect.map(changed),
      Effect.tap(() => Effect.sync(tick)),
    );
  }
  /** The seq the next event will have: AUTOINCREMENT never reuses one, and this writer is the only one. */
  next(): Effect.Effect<number> {
    return this.#open.pipe(
      Effect.flatMap((sql) => sql.unsafe<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'")),
      Effect.orDie,
      Effect.map((rows) => (rows[0]?.seq ?? 0) + 1),
    );
  }
  /** Records an outbound effect's intent; the permit for it is live once this transaction commits. */
  permit(kind: string, subject: string | null, data: unknown = {}, bind: ReadonlyArray<string> = []): Effect.Effect<Permit> {
    return Effect.map(this.event("intent", subject, { kind, bind, ...(data as object) }), (seq) => {
      const p = new Permit(kind, seq, bind);
      this.permits.push(p);
      return p;
    });
  }
  /** Appends to the log and returns its seq. */
  event(kind: string, subject: string | null, data: unknown, actor = "overwatch"): Effect.Effect<number> {
    return Effect.suspend(() =>
      this.run("INSERT INTO events (at_ms, kind, subject, actor, data) VALUES (?, ?, ?, ?, ?)", clock.now(), kind as Clean, subject as Clean | null, actor as Clean, json(data)),
    ).pipe(Effect.map((r) => r.lastInsertRowid));
  }
}

type Value = number | string | null;

/** The database, owned by this process: reads, the one way to change it, and its maintenance. */
export interface StoreShape {
  readonly file: string;
  readonly all: <T = Record<string, unknown>>(query: string, ...params: ReadonlyArray<Value>) => Effect.Effect<T[]>;
  readonly get: <T = Record<string, unknown>>(query: string, ...params: ReadonlyArray<Value>) => Effect.Effect<T | undefined>;
  readonly seq: Effect.Effect<number>;
  readonly meta: (key: string) => Effect.Effect<string | null>;
  /** One change: one IMMEDIATE transaction, admitted by the guard. Listeners hear of it after it commits. */
  readonly tx: <A, E, R>(work: (w: Writer) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | Full, R>;
  /** One outbound effect's intent, in its own transaction; the returned permit is live. */
  readonly permit: (kind: string, subject: string | null, data?: unknown, bind?: ReadonlyArray<string>) => Effect.Effect<Permit, Full>;
  /**
   * Admission for every write: set by the owner of the disk check, it runs before each transaction opens, so a
   * failure record, a deadline or a page action is refused by the same rule as a slice. Only maintenance (making
   * room) passes without it.
   */
  readonly setGuard: (guard: Effect.Effect<void, Full> | null) => Effect.Effect<void>;
  /** One element after each committed transaction. */
  readonly changes: Stream.Stream<void>;
  /** Lets the write-ahead log go back to the file system (tests measure the file). */
  readonly checkpoint: Effect.Effect<void>;
  /** A consistent standalone copy. Never overwrites a file. */
  readonly backup: (target: string) => Effect.Effect<{ file: string; seq: number }, BackupError>;
  readonly restore: (source: string) => Effect.Effect<{ file: string; seq: number }, Incompatible | Full>;
  /** The bytes the database holds: its pages in use (free pages are reused before the file grows) and its log. */
  readonly liveBytes: Effect.Effect<number>;
  readonly reclaim: (maxBytes?: number) => Effect.Effect<number>;
  readonly expire: (now: number) => Effect.Effect<number>;
  readonly retain: (now: number, over: Effect.Effect<boolean>, keepEvents?: number) => Effect.Effect<void>;
}

/** The innermost message of an error from SQLite, for diagnostics. */
const reason = (error: unknown): string => {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && Predicate.isObject(e) && "cause" in e && (e as { cause?: unknown }).cause !== undefined; depth++) e = (e as { cause: unknown }).cause;
  return e instanceof Error ? e.message : String(e);
};

/**
 * Takes ownership of the data directory's database, or fails with Busy. Exclusive locking, WAL and a committed write
 * come first; only then is the schema read or created. The connection lives as long as the surrounding scope.
 */
const own = Effect.fn("Store.own")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dataDir, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
  // Not ours to change when it fails; the doctor says so.
  yield* fs.chmod(dataDir, 0o700).pipe(Effect.ignore);
  const file = path.join(dataDir, "overwatch.db");
  // One connection, busy timeout 0, and WAL entered here after exclusive locking is chosen: the client's own WAL
  // switch would come before it.
  const sql = yield* SqliteClient.make({ filename: file, busyTimeout: 0, disableWAL: true }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.mapError((e) => new Busy({ message: `cannot open ${file}: ${reason(e)}` })),
  );
  const exec = (query: string) => Effect.suspend(() => sql.unsafe(query).raw);
  const value = <T>(query: string) => Effect.map(sql.unsafe<Record<string, T>>(query), (rows) => Object.values(rows[0] ?? {})[0] as T);

  // Incremental auto-vacuum must be chosen before the first page is written (WAL writes it); see reclaim().
  yield* Effect.forEach(["PRAGMA locking_mode = EXCLUSIVE", "PRAGMA auto_vacuum = INCREMENTAL", "PRAGMA journal_mode = WAL"], exec).pipe(
    Effect.andThen(sql.withTransaction(Effect.void)),
    Effect.mapError((e) => {
      const message = reason(e);
      return /locked|busy/i.test(message) ? new Busy({ message: `${file} is in use by another process` }) : new Incompatible({ message: `${file} is not an Overwatch database (${message})` });
    }),
  );
  yield* Effect.forEach(["PRAGMA synchronous = FULL", "PRAGMA foreign_keys = ON"], exec).pipe(Effect.orDie);
  const app = yield* value<number>("PRAGMA application_id").pipe(Effect.orDie);
  const version = yield* value<number>("PRAGMA user_version").pipe(Effect.orDie);
  const tables = yield* value<number>("SELECT count(*) AS n FROM sqlite_schema").pipe(Effect.orDie);
  if (app === 0 && version === 0 && tables === 0) {
    yield* sql
      .withTransaction(Effect.forEach([...TABLES.map((t) => t.ddl), ...MAINTENANCE, `PRAGMA application_id = ${APPLICATION_ID}`, `PRAGMA user_version = ${USER_VERSION}`], exec))
      .pipe(Effect.orDie);
  } else if (app === APPLICATION_ID && version === USER_VERSION) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const t of TABLES) if (ADDED_TABLES.has(t.name)) yield* exec(t.ddl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
          for (const [table, column, definition] of ADDED) {
            const has = (yield* sql.unsafe(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`, [column])).length > 0;
            if (!has) yield* exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
          }
          for (const statement of [...INDEXES, ...TRIGGERS]) yield* exec(statement);
          yield* exec(`INSERT OR IGNORE INTO citations (finding, handle) SELECT f.id, json_extract(p.value, '$.handle') FROM findings f, json_each(f.claims) c, json_each(c.value, '$.pieces') p
            WHERE json_extract(p.value, '$.handle') IN (SELECT handle FROM evidence)`);
        }),
      )
      .pipe(Effect.orDie);
  }
  if (app !== 0 && (app !== APPLICATION_ID || version !== USER_VERSION)) {
    return yield* new Incompatible({
      message: app !== APPLICATION_ID ? `${file} is not an Overwatch database` : `${file} has schema version ${version}; this program reads version ${USER_VERSION}`,
    });
  } else if (app === 0 && (version !== 0 || tables !== 0)) {
    return yield* new Incompatible({ message: `${file} is not an Overwatch database` });
  }
  if ((yield* value<number>("PRAGMA auto_vacuum").pipe(Effect.orDie)) !== 2) {
    yield* exec("VACUUM").pipe(Effect.orDie); // once, at start, for a file made without incremental auto-vacuum
  }

  const commits = yield* PubSub.unbounded<void>();
  let guard: Effect.Effect<void, Full> | null = null;

  const all = <T = Record<string, unknown>>(query: string, ...params: ReadonlyArray<Value>): Effect.Effect<T[]> =>
    Effect.suspend(() => sql.unsafe<Record<string, unknown>>(query, params)).pipe(Effect.orDie, Effect.map((rows) => rows as unknown as T[]));
  const get = <T = Record<string, unknown>>(query: string, ...params: ReadonlyArray<Value>): Effect.Effect<T | undefined> =>
    Effect.map(all<T>(query, ...params), (rows) => rows[0]);
  const pragma = (name: string) => Effect.map(get<Record<string, number>>(`PRAGMA ${name}`), (row) => Object.values(row ?? {})[0] ?? 0);
  const seq = Effect.map(get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'"), (row) => row?.seq ?? 0);

  const transact = <A, E, R>(work: (w: Writer) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const writer = new Writer(sql);
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // References are checked when the change commits, as one whole: a violation rolls the transaction back.
            yield* exec("PRAGMA defer_foreign_keys = ON").pipe(Effect.orDie);
            const result = yield* work(writer);
            yield* sql.afterCommit(
              Effect.sync(() => {
                tick();
                for (const p of writer.permits) issue(p);
              }).pipe(Effect.andThen(PubSub.publish(commits, undefined)), Effect.asVoid),
            );
            return result;
          }),
        )
        .pipe(
          // A failed COMMIT (a deferred reference) is a defect, like any broken constraint; the change is undone whole.
          Effect.catchIf(SqlError.isSqlError, (e) => Effect.die(e)),
          Effect.ensuring(Effect.sync(() => writer.end())),
        ) as Effect.Effect<A, E, R>;
    });

  const tx = <A, E, R>(work: (w: Writer) => Effect.Effect<A, E, R>): Effect.Effect<A, E | Full, R> =>
    Effect.suspend(() => guard ?? Effect.void).pipe(Effect.andThen(transact(work)));

  /**
   * Making room (age, pressure) is the only write that passes without admission; it is private to the store, so no
   * caller can carry a business write through it. Its events are only `compacted`.
   */
  const maintain = (work: (w: Writer) => Effect.Effect<number>, step: string, throughSeq: number) =>
    transact((w) =>
      Effect.gen(function* () {
        const removed = yield* work(w);
        yield* w.event("compacted", null, { step, removed, throughSeq });
        return removed;
      }),
    );

  const expire = (now: number): Effect.Effect<number> =>
    Effect.gen(function* () {
      const day = 86_400_000;
      const old = (days: number, trial: boolean) =>
        `SELECT r.id FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.state = 'terminal' AND (j.kind = 'trial') = ${trial ? 1 : 0} AND r.started_ms < ${now - days * day}`;
      const due = [
        `DELETE FROM evidence WHERE run_id IN (${old(7, true)}) AND handle NOT IN (SELECT handle FROM citations)`,
        `DELETE FROM messages WHERE run_id IN (${old(7, true)})`,
        `DELETE FROM evidence WHERE run_id IN (${old(14, false)}) AND handle NOT IN (SELECT handle FROM citations)`,
        `DELETE FROM messages WHERE run_id IN (${old(14, false)})`,
        `DELETE FROM coverage WHERE to_ms < ${now - 30 * day}`,
        `DELETE FROM hourly WHERE hour < ${Math.floor((now - 30 * day) / 3_600_000)}`,
        `DELETE FROM lines WHERE at_ms < ${now - 30 * day}`,
      ];
      let any = false;
      for (const query of due) if ((yield* get(query.replace(/^DELETE FROM (\w+) WHERE/, "SELECT 1 FROM $1 WHERE") + " LIMIT 1")) !== undefined) any = true;
      if (!any) return 0;
      return yield* maintain(
        (w) =>
          Effect.gen(function* () {
            let removed = 0;
            for (const query of due) removed += (yield* w.run(query)).changes;
            return removed;
          }),
        "age",
        0,
      );
    });

  const restore = (source: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const backup = yield* SqliteClient.make({ filename: source, readonly: true }).pipe(
          Effect.provide(Reactivity.layer),
          Effect.mapError(() => new Incompatible({ message: `${source} does not open as a database` })),
        );
        const one = <T>(query: string) => Effect.map(backup.unsafe<Record<string, T>>(query), (rows) => Object.values(rows[0] ?? {})[0] as T);
        const [app, version, integrity] = yield* Effect.all([one<number>("PRAGMA application_id"), one<number>("PRAGMA user_version"), one<string>("PRAGMA integrity_check")]).pipe(
          Effect.mapError(() => new Incompatible({ message: `${source} is not an Overwatch backup: it is not a database` })),
        );
        if (app !== APPLICATION_ID) return yield* new Incompatible({ message: `${source} is not an Overwatch backup` });
        if (version !== USER_VERSION) return yield* new Incompatible({ message: `${source} has schema version ${version}; this program restores version ${USER_VERSION}` });
        if (integrity !== "ok") return yield* new Incompatible({ message: `${source} fails SQLite's integrity check` });
        const read = <T>(query: string) => backup.unsafe<Record<string, unknown>>(query).pipe(Effect.orDie, Effect.map((rows) => rows as unknown as T[]));
        const present = new Set((yield* read<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'")).map((r) => r.name));
        for (const t of TABLES) if (!present.has(t.name) && !ADDED_TABLES.has(t.name)) return yield* new Incompatible({ message: `${source} has no ${t.name} table` });
        const high = (yield* read<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'events'"))[0]?.seq ?? 0;
        yield* tx((w) =>
          Effect.gen(function* () {
            // References are checked once, on the whole staged copy, by the database's own foreign keys.
            yield* w.run("UPDATE maintenance SET active = 1");
            for (const t of [...TABLES].reverse()) yield* w.run(`DELETE FROM ${t.name}`);
            for (const t of TABLES) {
              if (!present.has(t.name) || t.derived) continue;
              // A backup from an earlier build of version 1 may lack columns added since; they take their defaults.
              const has = new Set((yield* read<{ name: string }>(`SELECT name FROM pragma_table_info('${t.name}')`)).map((r) => r.name));
              const columns = t.columns.filter((c) => has.has(c) || !ADDED.some(([table, column]) => table === t.name && column === c));
              const insert = `INSERT INTO ${t.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
              for (const row of yield* read<Record<string, unknown>>(`SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM main."${t.name}"`)) {
                yield* w.run(insert, ...columns.map((c) => valueOf(row[c], t.json?.includes(c) ?? false)));
              }
            }
            // The backup's own high-water mark: a row beyond it is an invariant violation, not a reason to raise it.
            yield* w.run("DELETE FROM sqlite_sequence WHERE name = 'events'");
            yield* w.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)", high);
            const broken = yield* all<{ table: string; parent: string }>("PRAGMA foreign_key_check");
            if (broken.length) return yield* Effect.fail(`a ${broken[0]!.table} row refers to a ${broken[0]!.parent} row that does not exist (${broken.length})`);
            for (const [table, column, parent, key] of references()) {
              const n = (yield* get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT IN (SELECT ${key} FROM ${parent})`))!.n;
              if (n) return yield* Effect.fail(`a ${table}.${column} refers to a ${parent} row that does not exist (${n})`);
            }
            for (const [what, query] of INVARIANTS) {
              const violations = Object.values((yield* get<Record<string, number>>(query)) ?? {})[0] ?? 0;
              if (violations > 0) return yield* Effect.fail(`${what} (${violations})`);
            }
            yield* w.run("UPDATE maintenance SET active = 0");
          }),
        ).pipe(
          Effect.catchCause((cause): Effect.Effect<never, Incompatible | Full> => {
            const failure = Cause.findErrorOption(cause);
            if (failure._tag === "Some" && Predicate.isTagged(failure.value, "Full")) return Effect.fail(failure.value as Full);
            const text = failure._tag === "Some" ? String(failure.value) : reason(Cause.squash(cause));
            return Effect.fail(new Incompatible({ message: `${source} cannot be restored: ${clean(text, 300)}` }));
          }),
        );
        return { file: source, seq: yield* seq };
      }),
    );

  const shape: StoreShape = {
    file,
    all,
    get,
    seq,
    meta: (key) => Effect.map(get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key), (row) => row?.value ?? null),
    tx,
    permit: (kind, subject, data = {}, bind = []) => tx((w) => w.permit(kind, subject, data, bind)),
    setGuard: (next) => Effect.sync(() => void (guard = next)),
    changes: Stream.fromPubSub(commits),
    checkpoint: exec("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie, Effect.asVoid),
    backup: (target) =>
      Effect.gen(function* () {
        if (yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false))) return yield* new BackupError({ message: `${target} exists; choose a new file` });
        const at = yield* seq;
        yield* Effect.suspend(() => sql.unsafe("VACUUM INTO ?", [target]).raw).pipe(Effect.mapError((e) => new BackupError({ message: reason(e) })));
        return { file: target, seq: at };
      }),
    restore,
    liveBytes: Effect.gen(function* () {
      const wal = yield* fs.stat(`${file}-wal`).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0), // no log yet
      );
      return ((yield* pragma("page_count")) - (yield* pragma("freelist_count"))) * (yield* pragma("page_size")) + wal;
    }),
    /**
     * Gives free pages back to the file system: at most `maxBytes` per call, for any page size. Incremental vacuum
     * moves pages from the end of the file into free slots and truncates it; with auto-vacuum every (usable / 5)th
     * page is a pointer-map page that goes too, so fewer data pages are asked for than fit in the bound. Then the
     * write-ahead log is checkpointed and truncated. A full VACUUM is not used after start: it rewrites the whole file
     * into a copy (up to twice the space, on a disk that may be short of it) and holds the only connection for as long
     * as that takes, so no poll could commit meanwhile. Returns the free pages left.
     */
    reclaim: (maxBytes = LIMITS.reclaimBytes) =>
      Effect.gen(function* () {
        if ((yield* pragma("freelist_count")) === 0) return 0;
        const size = yield* pragma("page_size"), budget = Math.floor(maxBytes / size), perMap = Math.floor(size / 5);
        // n data pages and at most ceil(n / perMap) + 1 pointer-map pages must fit in the budget.
        const pages = Math.max(0, Math.floor(((budget - 2) * perMap) / (perMap + 1)));
        if (pages === 0) return yield* pragma("freelist_count");
        yield* all(`PRAGMA incremental_vacuum(${pages})`);
        yield* exec("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie);
        return yield* pragma("freelist_count");
      }),
    /**
     * Age: what has outlived its use goes, on every pass, whatever the disk: trial messages and uncited trial
     * evidence after seven days; real messages and uncited evidence after fourteen; coverage rows and hourly counts
     * after thirty. A finding and the evidence it cites are never removed (the citations table restricts it). One
     * audited transaction, only when something is due.
     */
    expire,
    /**
     * Makes room under pressure: old events (counts and the sequence are kept), then what age allows. Nothing else is
     * removed; if that is not enough, the caller pauses collection. Cited evidence is never removed.
     */
    retain: (now, over, keepEvents = 10_000) =>
      Effect.gen(function* () {
        if (yield* over) {
          const throughSeq = Math.max(0, (yield* seq) - keepEvents);
          yield* maintain(
            (w) =>
              Effect.gen(function* () {
                yield* w.run("UPDATE maintenance SET active = 1");
                const removed = (yield* w.run("DELETE FROM events WHERE seq <= ?", throughSeq)).changes;
                yield* w.run("UPDATE maintenance SET active = 0");
                return removed;
              }),
            "events",
            throughSeq,
          );
        }
        if (yield* over) yield* expire(now);
      }),
  };
  return shape;
});

/** The database service: owned for as long as the layer's scope lasts. */
export class Store extends Context.Service<Store, StoreShape>()("overwatch/Store") {
  static readonly own = own;
  static readonly layer = (dataDir: string) => Layer.effect(Store, own(dataDir));
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
export const Discovery = Schema.Struct({ url: Schema.String, pid: Schema.Number, version: Schema.optional(Schema.Number) });
export type Discovery = typeof Discovery.Type;
export const readDiscovery = (dataDir: string): Effect.Effect<Discovery | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(dataDir, "service.json"));
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Discovery))(text);
  }).pipe(Effect.orElseSucceed(() => null));
