/**
 * The inbox: four groups, the owner's three ways out (Done, Later, Never) with undo, seen marks, and the decisions
 * that bring a problem back. Every decision is made in the single writer's transaction that commits its cause, and
 * is ordered by `events.seq`: a trigger qualifies only when its seq is after the action's.
 *
 * Deadlines (Done's grace, Later's time) are stored as a wall-clock time and the delay the owner chose; the live
 * deadline is bounded by that delay on the monotonic clock, also after a restart, so a wall clock set back cannot
 * postpone one.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import { clock } from "./clock.ts";
import { clean } from "./redact.ts";
import { fold, json, type Clean, type Store, type Writer } from "./store.ts";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Kind = "done" | "later" | "never";
interface Way {
  kind: Kind;
  seq: number;
  untilMs: number | null;
  when: "worse" | null;
  reason: string | null;
  /** When it was put away (wall), the delay a deadline counts from it, and what it was like then. */
  atMs: number;
  delayMs: number | null;
  count: number;
  baseline: number;
  /** Whether the count was exact when put away: a rate needs a known baseline. */
  exact?: boolean;
  severity: string;
  previous: Way | null;
}
interface Row {
  id: string;
  app: string;
  environment: string;
  source: string;
  title: string;
  severity: string;
  count: number;
  exact: number;
  active: number;
  way: string | null;
  returned: string | null;
  seen_seq: number;
  first_seq: number;
  decided_seq: number;
  seq: number;
  first_ms: number;
  last_ms: number;
}

export const GROUPS = ["needsYou", "new", "working", "quiet"] as const;
export type Group = (typeof GROUPS)[number];
const HOUR = 3_600_000;
const RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };
const production = (environment: string) => /^(prod|production)$/i.test(environment);
const parse = <T>(text: string | null): T | null => (text ? (JSON.parse(text) as T) : null);
export const publicWay = (w: Way | null) => (w ? { kind: w.kind, seq: w.seq, untilMs: w.untilMs, when: w.when, reason: w.reason } : null);

/** Live deadlines on the monotonic clock, rebuilt at start (rebuild()) as at most their stored delay. */
const live = new Map<string, number>();

const deadlineOf = (w: Way) => (w.kind === "done" ? w.atMs + w.delayMs! : w.untilMs);

/**
 * At start: every stored deadline gets its live bound now, before any arrival or pass looks at it, so the time a
 * process was down counts by the wall clock and a wall clock set back cannot stretch it past the owner's delay.
 */
export function rebuild(store: Store) {
  const now = clock.now();
  for (const row of store.all<Row>("SELECT id, way FROM incidents WHERE way IS NOT NULL")) {
    const way = parse<Way>(row.way)!;
    const at = deadlineOf(way);
    if (at !== null && way.delayMs !== null) live.set(`${row.id}:${way.seq}`, clock.mono() + Math.min(Math.max(0, at - now), way.delayMs));
  }
}
export function passed(key: string, wallAt: number, delay: number, strict: boolean): boolean {
  const now = clock.now();
  if (strict ? now > wallAt : now >= wallAt) return true;
  if (!live.has(key)) live.set(key, clock.mono() + Math.min(Math.max(0, wallAt - now), delay));
  return strict ? clock.mono() > live.get(key)! : clock.mono() >= live.get(key)!;
}

/** Subjects that have an open request from the owner (queued or running). */
/** Subjects with outstanding work (a question or an investigation queued or running), and those left undecided. */
function openJobs(store: Store): Set<string> & { undecided: Set<string> } {
  const open = new Set(store.all<{ subject: string }>("SELECT DISTINCT subject FROM jobs WHERE kind IN ('ask', 'investigation') AND state IN ('queued', 'running')").map((r) => r.subject));
  const undecided = new Set(
    store.all<{ subject: string }>(
      `SELECT j.subject FROM jobs j WHERE j.kind = 'investigation' AND j.state = 'completed' AND json_extract(j.result, '$.verdict') = 'unsure'
       AND j.created_seq = (SELECT max(created_seq) FROM jobs k WHERE k.subject = j.subject AND k.kind = 'investigation' AND k.state = 'completed')`,
    ).map((r) => r.subject),
  );
  return Object.assign(open, { undecided });
}

/** An incident's group now, for deciding whether a change moved it into Needs you. */
export function groupNow(store: Store, id: string): Group | null {
  const row = store.get<Row>("SELECT id, way, active, severity, environment FROM incidents WHERE id = ?", id);
  return row ? groupOf(row, openJobs(store)) : null;
}

/** A row's group, or null once the owner has put it away. Running work wins over an undecided error. */
function groupOf(row: Pick<Row, "way" | "active" | "severity" | "environment" | "id">, open: ReadonlySet<string> & { undecided?: ReadonlySet<string> }): Group | null {
  if (row.way) return null;
  if (open.has(row.id)) return "working";
  if (row.active && row.severity === "error" && production(row.environment)) return "needsYou";
  // An investigation that could not decide a production problem leaves it for the owner.
  if (open.undecided?.has(row.id) && production(row.environment)) return "needsYou";
  return row.active ? "new" : "quiet";
}

export function inbox(store: Store) {
  const open = openJobs(store);
  const groups: Record<Group, string[]> = { needsYou: [], new: [], working: [], quiet: [] };
  for (const row of store.all<Row>("SELECT id, way, active, severity, environment FROM incidents WHERE way IS NULL ORDER BY first_seq, id")) {
    groups[groupOf(row, open)!].push(row.id);
  }
  return { seq: store.seq(), groups };
}

/** The incident fields the page shows, for every incident in the snapshot. */
export function rows(store: Store) {
  const open = openJobs(store);
  const hour = Math.floor(clock.now() / HOUR);
  const spark = new Map<string, number[]>();
  for (const h of store.all<{ incident: string; hour: number; count: number }>("SELECT incident, hour, count FROM hourly WHERE hour > ?", hour - 24)) {
    const s = spark.get(h.incident) ?? Array(24).fill(0);
    s[23 - (hour - h.hour)] = h.count;
    spark.set(h.incident, s);
  }
  return store.all<Row>("SELECT * FROM incidents ORDER BY seq, id").map((r) => ({
    id: r.id, title: r.title, count: r.count, exact: r.exact === 1, severity: r.severity, app: r.app, environment: r.environment,
    source: r.source, active: r.active === 1, group: groupOf(r, open), decidedSeq: r.decided_seq, way: publicWay(parse<Way>(r.way)), returned: parse<{ seq: number; causeSeq: number; code: string; reason: string }>(r.returned),
    seenSeq: r.seen_seq, firstSeq: r.first_seq, lastSeq: r.seq, firstMs: r.first_ms, lastMs: r.last_ms, spark: spark.get(r.id) ?? Array(24).fill(0),
  }));
}

/** Distinct admissions of a problem over the trailing day, by the event time of each occurrence. */
function trailing(store: Store, id: string): number {
  return store.get<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM hourly WHERE incident = ? AND hour > ?", id, Math.floor(clock.now() / HOUR) - 24)!.n;
}

/** Brings a row back: one `returned` event after its cause, the disposition cleared, the problem active again. */
function ret(w: Writer, row: Row, code: string, causeSeq: number, actionSeq: number, reason: string) {
  const seq = w.event("returned", row.id as Clean, { actionSeq, causeSeq, code, reason });
  w.run("UPDATE incidents SET way = NULL, returned = ?, active = 1, streak = 0, decided_seq = ? WHERE id = ?", json({ seq, causeSeq, code, reason }), seq, row.id as Clean);
}

const get = (store: Store, id: string) => store.get<Row>("SELECT * FROM incidents WHERE id = ?", id);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * After a commit changed a problem (`added` new occurrences, its severity, or its activity): whether it comes back.
 * `before` is the row as it was before this commit (undefined when the commit created it).
 */
export function afterChange(w: Writer, store: Store, id: string, before: { severity: string; active: number } | undefined, added: number, causeSeq: number) {
  const row = get(store, id);
  if (!row) return;
  const way = parse<Way>(row.way);
  if (!way) {
    if (before && !before.active && added > 0) {
      const quieted = store.get<{ seq: number | null }>("SELECT max(seq) AS seq FROM events WHERE kind = 'quieted' AND subject = ?", id)?.seq ?? 0;
      ret(w, row, "recurred", causeSeq, quieted, `Happened again after going quiet: ${plural(added, "new occurrence")}.`);
    }
    return;
  }
  if (way.kind !== "done" && RANK[row.severity]! > RANK[way.severity]!) {
    return ret(w, row, "severity", causeSeq, way.seq, `Severity rose from ${way.severity} to ${row.severity} since ${way.kind === "never" ? "Never" : "Later"}.`);
  }
  if (added === 0) return;
  const since = row.count - way.count;
  if (way.kind === "done") {
    // Decided on the service's own admission: what is admitted after the grace brings it back.
    if (passed(`${id}:${way.seq}`, way.atMs + way.delayMs!, way.delayMs!, true)) ret(w, row, "again", causeSeq, way.seq, `Happened again since Done: ${plural(added, "new occurrence")} after the grace.`);
    return;
  }
  // A rate needs a known baseline: a count that was a lower bound when put away cannot be the denominator.
  const day = trailing(store, id), base = Math.max(1, way.baseline), factor = way.kind === "never" ? 10 : 2;
  if (way.exact !== false && since >= 5 && day >= factor * base) {
    ret(w, row, "worse", causeSeq, way.seq, `Worse: ${plural(since, "new occurrence")} since ${way.kind === "never" ? "Never" : "Later"}, ${day} in the last day against ${way.baseline} before.`);
  }
}

/** A deploy of an app and environment brings back what was put away until something changes there. */
export function afterDeploy(w: Writer, store: Store, app: string, environment: string, deploySeq: number, revision: string) {
  for (const row of store.all<Row>("SELECT * FROM incidents WHERE app = ? AND environment = ? AND way IS NOT NULL", app, environment)) {
    const way = parse<Way>(row.way)!;
    if (way.kind === "later" && !way.when && way.untilMs === null && deploySeq > way.seq) ret(w, row, "deploy", deploySeq, way.seq, `Deployed ${revision.slice(0, 12)} since Later.`);
  }
}

/** A finding on a problem brings it back when it was put away until something changes. */
export function afterFinding(w: Writer, store: Store, subject: string, findingSeq: number, verdict: string) {
  const row = get(store, subject);
  const way = parse<Way>(row?.way ?? null);
  if (row && way?.kind === "later" && !way.when && way.untilMs === null && findingSeq > way.seq) ret(w, row, "finding", findingSeq, way.seq, `An investigation filed a finding (${verdict.replace("_", " ")}) since Later.`);
}

/** Each scheduler pass: Later deadlines that have come, each with its durable deadline event first. */
export function deadlines(store: Store) {
  for (const row of store.all<Row>("SELECT * FROM incidents WHERE way IS NOT NULL AND json_extract(way, '$.untilMs') IS NOT NULL")) {
    const way = parse<Way>(row.way)!;
    if (!passed(`${row.id}:${way.seq}`, way.untilMs!, way.delayMs!, false)) continue;
    store.tx((w) => {
      const seq = w.event("deadline", row.id as Clean, { actionSeq: way.seq, untilMs: way.untilMs });
      ret(w, row, "deadline", seq, way.seq, `The time you chose for Later has come.`);
    });
  }
}

const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
/** The basisSeq a request carries: the item's decidedSeq the owner was shown, or null when it names none. */
export function basisOf(body: Record<string, unknown>): number | null {
  if (body.basisSeq === undefined || body.basisSeq === null) return null;
  if (int(body.basisSeq) === null) throw new HttpError(400, "basisSeq is the decidedSeq that was shown");
  return body.basisSeq as number;
}

/**
 * POST /v2/items/:id/action, a fenced route. Returns the seq of the action, or null when nothing changed. A decision
 * is bound to what the owner reviewed: given a basis (the decidedSeq they were shown), it is refused when the
 * disposition has changed since, so an old sheet in another tab cannot replace a newer decision.
 */
export function act(store: Store, config: Config, id: string, body: Record<string, unknown>, basis: number | null): { seq: number | null } {
  const row = get(store, id);
  if (!row) throw new HttpError(404, `no item ${id}`);
  const action = body.action;
  const way = parse<Way>(row.way);
  if (action !== "seen" && basis !== null && basis !== row.decided_seq) throw new HttpError(409, "this item was decided again since you looked; look again");
  if (action === "seen") {
    const through = int(body.throughSeq);
    if (through === null || through < 0 || through > store.seq()) throw new HttpError(400, "throughSeq must be a seq from 0 to the current one");
    if (through <= row.seen_seq) return { seq: null };
    return { seq: store.tx((w) => (w.run("UPDATE incidents SET seen_seq = ? WHERE id = ?", through, id as Clean), w.event("seen", id as Clean, { throughSeq: through }))) };
  }
  if (action === "undo") {
    const actionSeq = int(body.actionSeq);
    if (actionSeq === null) throw new HttpError(400, "undo needs the actionSeq it undoes");
    if (!way || way.seq !== actionSeq) throw new HttpError(409, "that action is no longer the current one");
    return { seq: store.tx((w) => {
      const before = groupNow(store, id);
      const seq = w.event("action", id as Clean, { action: "undo", actionSeq, previous: publicWay(way), way: publicWay(way.previous) });
      w.run("UPDATE incidents SET way = ?, decided_seq = ? WHERE id = ?", way.previous ? json(way.previous) : null, seq, id as Clean);
      announce(w, store, id, before, seq); // back into Needs you: a new cause, told once
      return seq;
    }) };
  }
  if (action !== "done" && action !== "later" && action !== "never") throw new HttpError(400, "action is done, later, never, undo or seen");
  const untilMs = body.untilMs === undefined || body.untilMs === null ? null : int(body.untilMs);
  const when = body.when === undefined || body.when === null ? null : body.when;
  const reason = body.reason === undefined || body.reason === null ? null : body.reason;
  if (untilMs === null && body.untilMs !== undefined && body.untilMs !== null) throw new HttpError(400, "untilMs is a time in milliseconds");
  if (when !== null && when !== "worse") throw new HttpError(400, 'when is "worse"');
  if ((untilMs !== null || when !== null) && action !== "later") throw new HttpError(400, "untilMs and when belong to Later");
  if (untilMs !== null && when !== null) throw new HttpError(400, "Later takes a time or worse, not both");
  if (untilMs !== null && untilMs <= clock.now()) throw new HttpError(400, "untilMs must be in the future");
  if (reason !== null && (typeof reason !== "string" || reason.length > 500)) throw new HttpError(400, "reason is text of at most 500 characters");
  const grace = config.watchers.find((x) => x.app === row.app && x.environment === row.environment)?.everyMs ?? 600_000;
  const now = clock.now();
  const next: Way = {
    kind: action, seq: 0, untilMs, when: when as "worse" | null, reason: reason === null ? null : clean(reason, 500), atMs: now,
    delayMs: action === "done" ? grace : untilMs !== null ? untilMs - now : null, count: row.count, baseline: trailing(store, id), exact: row.exact === 1, severity: row.severity, previous: way,
  };
  const seq = store.tx((w) => {
    // One position for the disposition: the action event's own seq, named inside the event and stored with the way.
    next.seq = w.next();
    if (w.event("action", id as Clean, { action, previous: publicWay(way), way: publicWay(next) }) !== next.seq) throw new Error("the event log moved during an action");
    // Acting on an item is looking at it.
    w.run("UPDATE incidents SET way = ?, decided_seq = ?, seen_seq = max(seen_seq, seq) WHERE id = ?", json(next), next.seq, id as Clean);
    return next.seq;
  });
  if (next.delayMs !== null) live.set(`${id}:${seq}`, clock.mono() + next.delayMs);
  return { seq };
}

/** GET /v2/items/:id */
export function detail(store: Store, config: Config, id: string) {
  const row = rows(store).find((r) => r.id === id);
  if (!row) throw new HttpError(404, `no item ${id}`);
  const history = store
    .all<{ seq: number; at_ms: number; kind: string; subject: string; data: string }>("SELECT seq, at_ms, kind, subject, data FROM (SELECT * FROM events WHERE subject = ? ORDER BY seq DESC LIMIT 200) ORDER BY seq", id)
    .map((e) => ({ seq: e.seq, atMs: e.at_ms, kind: e.kind, subject: e.subject, data: JSON.parse(e.data) }));
  const findings = store
    .all<{ id: string; verdict: string; claims: string; body: string }>("SELECT f.id, f.verdict, f.claims, f.body FROM findings f JOIN runs r ON r.id = f.run_id JOIN jobs j ON j.id = r.job_id WHERE j.subject = ? AND j.kind <> 'trial' ORDER BY f.rowid", id)
    .map((f) => ({ id: f.id, verdict: f.verdict, claims: JSON.parse(f.claims), body: JSON.parse(f.body) }));
  // What the owner asked about this item, with where each request stands.
  const requests = store
    .all<{ job_id: string; text: string; mode: string; seq: number; state: string }>("SELECT a.job_id, a.text, a.mode, a.seq, j.state FROM asks a JOIN jobs j ON j.id = a.job_id WHERE a.subject = ? ORDER BY a.seq", id)
    .map((r) => ({ jobId: r.job_id, text: r.text, mode: r.mode, seq: r.seq, state: r.state }));
  const investigations = store
    .all<{ id: string; state: string; result: string | null; created_seq: number; reason: string | null }>("SELECT id, state, result, created_seq, reason FROM jobs WHERE kind = 'investigation' AND subject = ? ORDER BY created_seq", id)
    .map((j) => ({ jobId: j.id, state: j.state, reason: j.reason, seq: j.created_seq, result: j.result ? JSON.parse(j.result) : null }));
  const corrections = store
    .all<{ seq: number; app: string; job_id: string; text: string; date: string }>("SELECT * FROM corrections WHERE subject = ? ORDER BY seq", id)
    .map((c) => ({ seq: c.seq, app: c.app, jobId: c.job_id, text: c.text, date: c.date }));
  return { incident: row, history, findings, requests, investigations, turns: turns(store, "subject", id), corrections, promptTarget: target(store, id), label: label(store, config, id) };
}

/** Questions and their answers, in the order they were asked. */
export function turns(store: Store, by: "subject" | "job_id", value: string) {
  return store
    .all<{ key: string; seq: number; text: string; state: string; session_id: string | null; answer: string | null; reason: string | null; job_id: string; reads: number }>(
      `SELECT a.*, (SELECT count(*) FROM evidence e JOIN work k ON k.run_id = e.run_id WHERE k.ask_key = a.key) AS reads FROM asks a WHERE a.${by} = ? ORDER BY a.seq`, value)
    // `reads`: how many pieces of evidence the responder actually read for this answer. An answer cites none.
    .map((a) => ({ askSeq: a.seq, jobId: a.job_id, text: a.text, sessionId: a.session_id, state: a.state, answer: a.answer, reason: a.reason, reads: a.reads }));
}

/** The deployed revision a subject is about (its app and environment), or null. */
function attribution(store: Store, config: Config, subject: string): string | null {
  const place = subject.startsWith("env:") ? subject.slice(4).split("/")
    : subject.startsWith("src:") ? subject.slice(4).split("/").slice(0, 2)
    : Object.values(store.get<{ app: string; environment: string }>("SELECT app, environment FROM incidents WHERE id = ?", subject) ?? {});
  return store.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", String(place[0] ?? ""), String(place[1] ?? ""))?.revision ?? null;
}

/**
 * Where a prompt about a subject goes: the latest conversation on exactly this subject that is still eligible (not
 * superseded by New, not parked, and the deployed revision unchanged since it began), or a new one.
 */
function target(store: Store, subject: string, config?: Config) {
  const open = store.get<{ id: string; attribution: string | null }>(
    "SELECT id, attribution FROM jobs WHERE kind = 'ask' AND subject = ? AND closed = 0 AND state <> 'parked' ORDER BY created_seq DESC LIMIT 1", subject);
  const eligible = open && (!config || (open.attribution ?? null) === attribution(store, config, subject)) ? open : undefined;
  return { subject, mode: eligible ? "continue" : "new", jobId: eligible?.id ?? null };
}

/** A subject's label: an incident's title, an environment's or a source's name. Null when there is no such subject. */
export function label(store: Store, config: Config, subject: string): string | null {
  if (subject.startsWith("env:")) return config.watchers.some((w) => `env:${w.app}/${w.environment}` === subject) ? subject.slice(4).replace("/", " / ") : null;
  if (subject.startsWith("src:")) return config.sources.some((s) => `src:${s.id}` === subject) ? subject.slice(4).replaceAll("/", " / ") : null;
  return store.get<{ title: string }>("SELECT title FROM incidents WHERE id = ?", subject)?.title ?? null;
}

/** GET /v2/focus */
export function focus(store: Store, config: Config, subject: string) {
  const name = label(store, config, subject);
  if (name === null) throw new HttpError(404, "no such subject");
  return { subject, label: name, promptTarget: target(store, subject, config), requestKey: `rk_${randomBytes(12).toString("hex")}` };
}

/** POST /v2/ask: the redacted intent and its job are durable before the reply; a key answers the same way forever. */
export function ask(store: Store, config: Config, body: Record<string, unknown>): Plan<{ jobId: string; target: { subject: string; mode: string; jobId: string } }> {
  const { subject, text, mode } = body;
  if (typeof subject !== "string" || label(store, config, subject) === null) throw new HttpError(400, "unknown subject");
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new HttpError(400, "text is required (at most 4,000 characters)");
  if (mode !== "auto" && mode !== "new" && mode !== "continue") throw new HttpError(400, "mode is auto, new or continue");
  const result = (r: { subject: string; job_id: string; mode: string }) => ({ jobId: r.job_id, target: { subject: r.subject, mode: r.mode, jobId: r.job_id } });
  const cleaned = clean(text.trim(), 4000), digest = createHash("sha256").update(JSON.stringify([subject, text, mode])).digest("hex");
  return { op: "ask", subject, body: { text, mode }, change: (w, key) => {
    // Decided inside the receipt: a replay answers as the first request did, whatever happened since.
    const open = target(store, subject, config).jobId;
    if (mode === "continue" && !open) throw new HttpError(409, "there is no conversation on this subject that can continue");
    const effective = mode === "new" || !open ? "new" : "continue";
    const jobId = effective === "new" ? `job_${randomBytes(12).toString("hex")}` : open!;
    const seq = w.event("asked", subject as Clean, { subject, jobId, mode: effective, text: cleaned });
    if (effective === "new") {
      // An explicit New supersedes the older conversations on this subject for later sends.
      w.run("UPDATE jobs SET closed = 1 WHERE kind = 'ask' AND subject = ? AND closed = 0", subject as Clean);
      w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq, attribution) VALUES (?, 'ask', ?, ?, 'queued', NULL, ?, ?)",
        jobId as Clean, subject as Clean, clean(cleaned, 200), seq, attribution(store, config, subject) as Clean | null);
    } else w.run("UPDATE jobs SET state = 'queued' WHERE id = ?", jobId as Clean);
    w.run("INSERT INTO asks (key, subject, job_id, mode, text, digest, seq) VALUES (?, ?, ?, ?, ?, ?, ?)", key as Clean, subject as Clean, jobId as Clean, effective as Clean, cleaned, digest as Clean, seq);
    // The answer is a work item at the front of the queue: the owner does not wait behind automatic work.
    w.run("INSERT INTO work (id, job_id, kind, slot, priority, state, ask_key, seq) VALUES (?, ?, 'answer', NULL, 0, 'queued', ?, ?)", `wk_${randomBytes(12).toString("hex")}` as Clean, jobId as Clean, key as Clean, seq);
    return result({ subject, job_id: jobId, mode: effective });
  } };
}

/**
 * GET /v2/search: literal, case-insensitive, over real problems' titles, retained evidence and findings of real work,
 * and prompts; each subject once, newest matching seq first. Trial work is not searched.
 */
export function search(store: Store, config: Config, q: string, cursor: string | null = null) {
  const needle = fold(q.trim());
  if (!needle) return { items: [], nextCursor: null };
  const bind = createHash("sha256").update(needle).digest("hex").slice(0, 12);
  let offset = 0;
  if (cursor) {
    const m = /^s(\d{1,7})_([0-9a-f]{12})$/.exec(cursor);
    if (!m || m[2] !== bind) throw new HttpError(400, "cursor does not belong to this query");
    offset = Number(m[1]);
  }
  const hits = [
    ...store.all<{ subject: string; text: string; seq: number }>("SELECT id AS subject, title AS text, seq FROM incidents WHERE instr(fold(title), ?) > 0", needle),
    ...store.all<{ subject: string; text: string; seq: number }>(
      `SELECT j.subject, e.text, j.created_seq AS seq FROM evidence e JOIN runs r ON r.id = e.run_id JOIN jobs j ON j.id = r.job_id
       WHERE j.kind <> 'trial' AND instr(fold(e.text), ?) > 0`, needle),
    ...store.all<{ subject: string; text: string; seq: number }>(
      `SELECT j.subject, f.claims || ' ' || f.body AS text, j.created_seq AS seq FROM findings f JOIN runs r ON r.id = f.run_id JOIN jobs j ON j.id = r.job_id
       WHERE j.kind <> 'trial' AND instr(fold(f.claims || ' ' || f.body), ?) > 0`, needle),
    ...store.all<{ subject: string; text: string; seq: number }>("SELECT subject, text, seq FROM asks WHERE instr(fold(text), ?) > 0", needle),
  ];
  const best = new Map<string, { id: string; title: string; excerpt: string; seq: number }>();
  for (const h of hits) {
    const prior = best.get(h.subject);
    if (prior && h.seq <= prior.seq) continue;
    const at = Math.max(0, fold(h.text).indexOf(needle));
    const excerpt = clean(`${at > 60 ? "…" : ""}${h.text.slice(Math.max(0, at - 60), at + needle.length + 80)}${at + needle.length + 80 < h.text.length ? "…" : ""}`, 400);
    best.set(h.subject, { id: h.subject, title: label(store, config, h.subject) ?? h.subject, excerpt, seq: h.seq });
  }
  // Every matching subject is reachable: pages of 50 in a stable order (newest matching seq, then ID).
  const all = [...best.values()].sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1));
  const items = all.slice(offset, offset + 50);
  return { items, nextCursor: offset + 50 < all.length ? `s${offset + 50}_${bind}` : null };
}

/** Counts an occurrence by the hour of its event time, in the transaction that counts it. */
export function hourly(w: Writer, incident: string, atMs: number, n = 1) {
  w.run("INSERT INTO hourly (incident, hour, count) VALUES (?, ?, ?) ON CONFLICT (incident, hour) DO UPDATE SET count = count + excluded.count", incident as Clean, Math.floor(atMs / HOUR), n);
}

/** A local notification intent, once per subject and cause, in the transaction that moved the subject into Needs you. */
export function notify(w: Writer, subject: string, causeSeq: number, title: string, body: string) {
  const nid = `ntf_${createHash("sha256").update(JSON.stringify([subject, causeSeq])).digest("hex").slice(0, 24)}`;
  if (w.run("INSERT OR IGNORE INTO notifications (id, subject, cause_seq, state, title, body) VALUES (?, ?, ?, 'queued', ?, ?)", nid as Clean, subject as Clean, causeSeq, clean(title, 200), clean(body, 400)).changes)
    w.event("notification_queued", subject as Clean, { id: nid, causeSeq });
}

/** After a change to a problem: if it has just moved into Needs you, the owner is told once for this cause. */
export function announce(w: Writer, store: Store, subject: string, before: string | null, causeSeq: number) {
  if (before === "needsYou" || groupNow(store, subject) !== "needsYou") return;
  const inc = store.get<{ title: string; app: string; environment: string }>("SELECT title, app, environment FROM incidents WHERE id = ?", subject)!;
  notify(w, subject, causeSeq, `Overwatch: ${inc.app}/${inc.environment} needs you`, inc.title);
}

/**
 * Every owner write route goes through here: the receipt and the change it protects commit in one transaction, so a
 * crash leaves both or neither. The same key with the same subject and body answers the same way forever; any other
 * subject or body is 409.
 */
/**
 * A keyed owner write, declared by its handler and executed only by the router (keyed()): what it is, about which
 * subject, with which body, the change, and optionally what to do after the receipt (an outbound step).
 */
export interface Plan<T> { op: string; subject: string; body: unknown; change: (w: Writer, key: string) => T; after?: (result: T, key: string) => T | Promise<T> }
export function keyed<T>(store: Store, key: string | undefined, plan: Plan<T>): T | Promise<T> {
  const result = receipt(store, key, plan.op, plan.subject, plan.body, (w) => plan.change(w, key!));
  return plan.after ? plan.after(result, key!) : result;
}

function receipt<T>(store: Store, key: string | undefined, op: string, subject: string, body: unknown, change: (w: Writer) => T): T {
  if (!key || !/^rk_[0-9a-f]{24}$/.test(key)) throw new HttpError(400, "an Idempotency-Key from GET /v2/focus is required");
  const digest = createHash("sha256").update(JSON.stringify([op, subject, body])).digest("hex");
  return store.tx((w) => {
    const used = store.get<{ op: string; digest: string; result: string }>("SELECT * FROM requests WHERE key = ?", key);
    if (used) {
      if (used.op !== op || used.digest !== digest) throw new HttpError(409, "this request key was used for a different request");
      return JSON.parse(used.result) as T;
    }
    const result = change(w);
    w.run("INSERT INTO requests (key, op, digest, result) VALUES (?, ?, ?, ?)", key as Clean, op as Clean, digest as Clean, json(result));
    return result;
  });
}
