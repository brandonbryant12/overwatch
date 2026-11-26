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
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const INDEXES = `CREATE INDEX IF NOT EXISTS occurrences_age ON occurrences (source, at_ms);
CREATE INDEX IF NOT EXISTS occurrences_stream ON occurrences (stream, at_ms);
CREATE INDEX IF NOT EXISTS coverage_recent ON coverage (source, reading, id);
CREATE INDEX IF NOT EXISTS incidents_place ON incidents (app, environment);
CREATE INDEX IF NOT EXISTS hourly_age ON hourly (hour);
CREATE INDEX IF NOT EXISTS jobs_subject ON jobs (subject, state);
CREATE INDEX IF NOT EXISTS lines_incident ON lines (incident, at_ms);
CREATE INDEX IF NOT EXISTS work_queue ON work (state, priority, seq);
CREATE INDEX IF NOT EXISTS samples_series ON samples (source, id);
CREATE INDEX IF NOT EXISTS fixes_job ON fixes (job_id);`;

/** Tables added within version 1: created on open when absent, and empty when restoring a backup that lacks them. */
const ADDED_TABLES = new Set(["onsets", "rollouts", "samples", "comparisons", "fixes", "proposals", "origins", "hourly", "asks", "citations", "work", "requests", "corrections", "notifications", "lines"]);

/** Rules kept by the database itself; created with the schema and on open of an older file. */
const TRIGGERS = `CREATE TRIGGER IF NOT EXISTS findings_cite AFTER INSERT ON findings BEGIN
  INSERT OR IGNORE INTO citations (finding, handle)
    SELECT NEW.id, json_extract(p.value, '$.handle') FROM json_each(NEW.claims) c, json_each(c.value, '$.pieces') p;
END;`;

const MAINTENANCE = `CREATE TABLE maintenance (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL CHECK (active IN (0,1)));
INSERT INTO maintenance VALUES (1, 0);
CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events WHEN (SELECT active FROM maintenance) = 0
  BEGIN SELECT RAISE(ABORT, 'events are append-only outside maintenance'); END;
${INDEXES}
${TRIGGERS}`;



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

export class Busy extends Error {}
/** The disk is short: nothing is admitted until there is room again. */
export class Full extends Error {}
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

/** Writes inside one transaction. Each transaction gets its own, and it is dead once that transaction ends: a writer
 * kept past its callback cannot write without admission. */
export class Writer {
  #db: DatabaseSync | null;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  end() {
    this.#db = null;
  }
  get #open(): DatabaseSync {
    if (!this.#db) throw new Error("this writer's transaction has ended");
    return this.#db;
  }
  run(sql: string, ...params: ReadonlyArray<Param>): { changes: number; lastInsertRowid: number } {
    const result = this.#open.prepare(sql).run(...params.map(normal));
    tick();
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }
  /** The seq the next event will have: AUTOINCREMENT never reuses one, and this writer is the only one. */
  next(): number {
    return ((this.#open.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined)?.seq ?? 0) + 1;
  }
  readonly permits: Permit[] = [];
  /** Records an outbound effect's intent; the permit for it is live once this transaction commits. */
  permit(kind: string, subject: string | null, data: unknown = {}, bind: ReadonlyArray<string> = []): Permit {
    const p = new Permit(kind, this.event("intent", subject, { kind, bind, ...(data as object) }), bind);
    this.permits.push(p);
    return p;
  }
  /** Appends to the log and returns its seq. */
  event(kind: string, subject: string | null, data: unknown, actor = "overwatch"): number {
    return this.run("INSERT INTO events (at_ms, kind, subject, actor, data) VALUES (?, ?, ?, ?, ?)", clock.now(), kind as Clean, subject as Clean | null, actor as Clean, json(data)).lastInsertRowid;
  }
}

export class Store {
  private listeners = new Set<() => void>();
  readonly #db: DatabaseSync;
  readonly file: string;
  constructor(db: DatabaseSync, file: string) {
    this.#db = db;
    this.file = file;
    // One case-folding for every literal match: Unicode, not SQLite's ASCII-only lower().
    db.function("fold", { deterministic: true }, (v) => (typeof v === "string" ? fold(v) : v));
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
      // Incremental auto-vacuum must be chosen before the first page is written (WAL writes it); see reclaim().
      db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA auto_vacuum = INCREMENTAL;");
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
    } else if (app === APPLICATION_ID && version === USER_VERSION) {
      db.exec("BEGIN IMMEDIATE");
      for (const t of TABLES) if (ADDED_TABLES.has(t.name)) db.exec(t.ddl.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));
      for (const [table, column, definition] of ADDED) {
        const has = (db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) as object | undefined) !== undefined;
        if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
      db.exec(INDEXES);
      db.exec(TRIGGERS);
      db.exec(`INSERT OR IGNORE INTO citations (finding, handle) SELECT f.id, json_extract(p.value, '$.handle') FROM findings f, json_each(f.claims) c, json_each(c.value, '$.pieces') p
        WHERE json_extract(p.value, '$.handle') IN (SELECT handle FROM evidence)`);
      db.exec("COMMIT");
    }
    if (app !== 0 && (app !== APPLICATION_ID || version !== USER_VERSION)) {
      db.close();
      throw new Incompatible(
        app !== APPLICATION_ID ? `${file} is not an Overwatch database` : `${file} has schema version ${version}; this program reads version ${USER_VERSION}`,
      );
    } else if (app === 0 && (version !== 0 || tables !== 0)) {
      db.close();
      throw new Incompatible(`${file} is not an Overwatch database`);
    }
    if ((db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }).auto_vacuum !== 2) {
      db.exec("VACUUM"); // once, at start, for a file made without incremental auto-vacuum
    }
    return new Store(db, file);
  }

  /** One change: one IMMEDIATE transaction. Listeners hear of it after it commits. */
  /**
   * Admission for every write: set by the owner of the disk check, it runs before each transaction opens, so a
   * failure record, a deadline or a page action is refused by the same rule as a slice. Only maintenance (making
   * room) passes without it.
   */
  guard: (() => void) | null = null;

  tx<A>(work: (w: Writer) => A): A {
    this.guard?.();
    return this.#transact(work);
  }

  /**
   * Making room (age, pressure) is the only write that passes without admission; it is private to the store, so no
   * caller can carry a business write through it. Its events are only `compacted`.
   */
  #maintain(work: (w: Writer) => number, step: string, throughSeq: number) {
    return this.#transact((w) => {
      const removed = work(w);
      w.event("compacted", null, { step, removed, throughSeq });
      return removed;
    });
  }

  /** One outbound effect's intent, in its own transaction; the returned permit is live. */
  permit(kind: string, subject: string | null, data: unknown = {}, bind: ReadonlyArray<string> = []): Permit {
    return this.tx((w) => w.permit(kind, subject, data, bind));
  }

  /** Lets the write-ahead log go back to the file system (tests measure the file). */
  checkpoint() {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  #transact<A>(work: (w: Writer) => A): A {
    this.#db.exec("BEGIN IMMEDIATE");
    // References are checked when the change commits, as one whole: a violation rolls the transaction back.
    this.#db.exec("PRAGMA defer_foreign_keys = ON");
    let result: A;
    const writer = new Writer(this.#db);
    try {
      result = work(writer);
      this.#db.exec("COMMIT");
    } catch (error) {
      // A failed change is undone whole. (A statement that raises leaves the transaction open, so this always runs.)
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back.
      }
      throw error;
    } finally {
      writer.end();
    }
    tick();
    for (const p of writer.permits) issue(p);
    for (const listener of this.listeners) listener();
    return result;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: ReadonlyArray<number | string | null>): T[] {
    return this.#db.prepare(sql).all(...params) as T[];
  }
  get<T = Record<string, unknown>>(sql: string, ...params: ReadonlyArray<number | string | null>): T | undefined {
    return this.#db.prepare(sql).get(...params) as T | undefined;
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
      this.#db.close();
    } catch {
      // Already closed.
    }
  }

  /** A consistent standalone copy. Never overwrites a file. */
  backup(target: string): { file: string; seq: number } {
    if (existsSync(target)) throw new Error(`${target} exists; choose a new file`);
    const seq = this.seq();
    this.#db.prepare("VACUUM INTO ?").run(target);
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
      for (const t of TABLES) if (!present.has(t.name) && !ADDED_TABLES.has(t.name)) throw new Incompatible(`${source} has no ${t.name} table`);
      const high = (backup.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as { seq: number } | undefined)?.seq ?? 0;
      try {
        this.tx((w) => {
          // References are checked once, on the whole staged copy, by the database's own foreign keys.
          w.run("UPDATE maintenance SET active = 1");
          for (const t of [...TABLES].reverse()) w.run(`DELETE FROM ${t.name}`);
          for (const t of TABLES) {
            if (!present.has(t.name) || t.derived) continue;
            // A backup from an earlier build of version 1 may lack columns added since; they take their defaults.
            const has = new Set((backup.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all() as Array<{ name: string }>).map((r) => r.name));
            const columns = t.columns.filter((c) => has.has(c) || !ADDED.some(([table, column]) => table === t.name && column === c));
            const insert = `INSERT INTO ${t.name} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
            // The statement is held for the whole loop: Node may finalize an unreferenced one mid-iteration.
            const select = backup.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(", ")} FROM main."${t.name}"`);
            for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
              w.run(insert, ...columns.map((c) => valueOf(row[c], t.json?.includes(c) ?? false)));
            }
          }
          // The backup's own high-water mark: a row beyond it is an invariant violation, not a reason to raise it.
          w.run("DELETE FROM sqlite_sequence WHERE name = 'events'");
          w.run("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)", high);
          const broken = this.all<{ table: string; parent: string }>("PRAGMA foreign_key_check");
          if (broken.length) throw new Error(`a ${broken[0]!.table} row refers to a ${broken[0]!.parent} row that does not exist (${broken.length})`);
          for (const [table, column, parent, key] of references()) {
            const n = this.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT IN (SELECT ${key} FROM ${parent})`)!.n;
            if (n) throw new Error(`a ${table}.${column} refers to a ${parent} row that does not exist (${n})`);
          }
          for (const [what, sql] of INVARIANTS) {
            const violations = Object.values(this.get<Record<string, number>>(sql) ?? {})[0] ?? 0;
            if (violations > 0) throw new Error(`${what} (${violations})`);
          }
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

  /** The bytes the database holds: its pages in use (free pages are reused before the file grows) and its log. */
  liveBytes(): number {
    const pragma = (name: string) => Object.values(this.get<Record<string, number>>(`PRAGMA ${name}`) ?? {})[0] ?? 0;
    let wal = 0;
    try {
      wal = statSync(`${this.file}-wal`).size;
    } catch {
      // No log yet.
    }
    return (pragma("page_count") - pragma("freelist_count")) * pragma("page_size") + wal;
  }

  /**
   * Gives free pages back to the file system: at most `maxBytes` per call, for any page size. Incremental vacuum
   * moves pages from the end of the file into free slots and truncates it; with auto-vacuum every (usable / 5)th page
   * is a pointer-map page that goes too, so fewer data pages are asked for than fit in the bound. Then the write-ahead
   * log is checkpointed and truncated. A full VACUUM is not used after start: it rewrites the whole file into a copy
   * (up to twice the space, on a disk that may be short of it) and holds the only connection for as long as that
   * takes, so no poll could commit meanwhile. Returns the free pages left.
   */
  reclaim(maxBytes = LIMITS.reclaimBytes): number {
    const pragma = (name: string) => Object.values(this.get<Record<string, number>>(`PRAGMA ${name}`) ?? {})[0] ?? 0;
    if (pragma("freelist_count") === 0) return 0;
    const size = pragma("page_size"), budget = Math.floor(maxBytes / size), perMap = Math.floor(size / 5);
    // n data pages and at most ceil(n / perMap) + 1 pointer-map pages must fit in the budget.
    const pages = Math.max(0, Math.floor(((budget - 2) * perMap) / (perMap + 1)));
    if (pages === 0) return pragma("freelist_count");
    this.#db.prepare(`PRAGMA incremental_vacuum(${pages})`).all();
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return pragma("freelist_count");
  }

  /**
   * Age: what has outlived its use goes, on every pass, whatever the disk: trial messages and uncited trial evidence
   * after seven days; real messages and uncited evidence after fourteen; coverage rows and hourly counts after thirty.
   * A finding and the evidence it cites are never removed (the citations table restricts it). One audited
   * transaction, only when something is due.
   */
  expire(now: number): number {
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
    const any = due.some((sql) => this.get(sql.replace(/^DELETE FROM (\w+) WHERE/, "SELECT 1 FROM $1 WHERE") + " LIMIT 1") !== undefined);
    if (!any) return 0;
    return this.#maintain((w) => due.reduce((n, sql) => n + w.run(sql).changes, 0), "age", 0);
  }

  /**
   * Makes room under pressure: old events (counts and the sequence are kept), then what age allows. Nothing else is
   * removed; if that is not enough, the caller pauses collection. Cited evidence is never removed.
   */
  retain(now: number, over: () => boolean, keepEvents = 10_000): void {
    if (over()) {
      const throughSeq = Math.max(0, this.seq() - keepEvents);
      this.#maintain((w) => {
        w.run("UPDATE maintenance SET active = 1");
        const removed = w.run("DELETE FROM events WHERE seq <= ?", throughSeq).changes;
        w.run("UPDATE maintenance SET active = 0");
        return removed;
      }, "events", throughSeq);
    }
    if (over()) this.expire(now);
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
