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
import { json, type Clean, type Store, type Writer } from "./store.ts";

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

/** Live deadlines on the monotonic clock, rebuilt after a restart as at most their stored delay. */
const live = new Map<string, number>();
function passed(key: string, wallAt: number, delay: number, strict: boolean): boolean {
  const now = clock.now();
  if (strict ? now > wallAt : now >= wallAt) return true;
  if (!live.has(key)) live.set(key, clock.mono() + Math.min(Math.max(0, wallAt - now), delay));
  return strict ? clock.mono() > live.get(key)! : clock.mono() >= live.get(key)!;
}

/** Subjects that have an open request from the owner (queued or running). */
function openJobs(store: Store): Set<string> {
  return new Set(store.all<{ subject: string }>("SELECT DISTINCT subject FROM jobs WHERE kind = 'ask' AND state IN ('queued', 'running')").map((r) => r.subject));
}

/** A row's group, or null once the owner has put it away. Running work wins over an undecided error. */
function groupOf(row: Pick<Row, "way" | "active" | "severity" | "environment" | "id">, open: ReadonlySet<string>): Group | null {
  if (row.way) return null;
  if (open.has(row.id)) return "working";
  if (row.active && row.severity === "error" && production(row.environment)) return "needsYou";
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
    source: r.source, active: r.active === 1, group: groupOf(r, open), way: publicWay(parse<Way>(r.way)), returned: parse<{ seq: number; causeSeq: number; code: string; reason: string }>(r.returned),
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
  w.run("UPDATE incidents SET way = NULL, returned = ?, active = 1, streak = 0 WHERE id = ?", json({ seq, causeSeq, code, reason }), row.id as Clean);
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
  const day = trailing(store, id), base = Math.max(1, way.baseline), factor = way.kind === "never" ? 10 : 2;
  if (since >= 5 && day >= factor * base) {
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

/** POST /v2/items/:id/action. Returns the seq of the action, or null when nothing changed. */
export function act(store: Store, config: Config, id: string, body: Record<string, unknown>): { seq: number | null } {
  const row = get(store, id);
  if (!row) throw new HttpError(404, `no item ${id}`);
  const action = body.action;
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  const way = parse<Way>(row.way);
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
      const seq = w.event("action", id as Clean, { action: "undo", actionSeq, previous: publicWay(way), way: publicWay(way.previous) });
      w.run("UPDATE incidents SET way = ? WHERE id = ?", way.previous ? json(way.previous) : null, id as Clean);
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
    delayMs: action === "done" ? grace : untilMs !== null ? untilMs - now : null, count: row.count, baseline: trailing(store, id), severity: row.severity, previous: way,
  };
  const seq = store.tx((w) => {
    next.seq = w.event("action", id as Clean, { action, previous: publicWay(way), way: publicWay({ ...next, seq: 0 }) });
    w.run("UPDATE incidents SET way = ? WHERE id = ?", json(next), id as Clean);
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
  return { incident: row, history, findings, promptTarget: target(store, id), label: label(store, config, id) };
}

/** Where a prompt about a subject goes: its latest open job, or a new one. */
function target(store: Store, subject: string) {
  const open = store.get<{ id: string }>("SELECT id FROM jobs WHERE kind = 'ask' AND subject = ? AND state IN ('queued', 'running') ORDER BY created_seq DESC LIMIT 1", subject);
  return { subject, mode: open ? "continue" : "new", jobId: open?.id ?? null };
}

/** A subject's label: an incident's title, an environment's or a source's name. Null when there is no such subject. */
function label(store: Store, config: Config, subject: string): string | null {
  if (subject.startsWith("env:")) return config.watchers.some((w) => `env:${w.app}/${w.environment}` === subject) ? subject.slice(4).replace("/", " / ") : null;
  if (subject.startsWith("src:")) return config.sources.some((s) => `src:${s.id}` === subject) ? subject.slice(4).replaceAll("/", " / ") : null;
  return store.get<{ title: string }>("SELECT title FROM incidents WHERE id = ?", subject)?.title ?? null;
}

/** GET /v2/focus */
export function focus(store: Store, config: Config, subject: string) {
  const name = label(store, config, subject);
  if (name === null) throw new HttpError(404, "no such subject");
  return { subject, label: name, promptTarget: target(store, subject), requestKey: `rk_${randomBytes(12).toString("hex")}` };
}

/** POST /v2/ask: the redacted intent and its job are durable before the reply; a key answers the same way forever. */
export function ask(store: Store, config: Config, body: Record<string, unknown>, key: string | undefined) {
  if (!key || !/^rk_[0-9a-f]{24}$/.test(key)) throw new HttpError(400, "an Idempotency-Key from GET /v2/focus is required");
  const { subject, text, mode } = body;
  if (typeof subject !== "string" || label(store, config, subject) === null) throw new HttpError(400, "unknown subject");
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new HttpError(400, "text is required (at most 4,000 characters)");
  if (mode !== "auto" && mode !== "new" && mode !== "continue") throw new HttpError(400, "mode is auto, new or continue");
  const digest = createHash("sha256").update(JSON.stringify([subject, text, mode])).digest("hex");
  const result = (r: { subject: string; job_id: string; mode: string }) => ({ jobId: r.job_id, target: { subject: r.subject, mode: r.mode, jobId: r.job_id } });
  const used = store.get<{ subject: string; job_id: string; mode: string; digest: string }>("SELECT * FROM asks WHERE key = ?", key);
  if (used) {
    if (used.digest !== digest) throw new HttpError(409, "this request key was used for a different prompt");
    return result(used);
  }
  const open = target(store, subject).jobId;
  if (mode === "continue" && !open) throw new HttpError(409, "there is no open job to continue");
  const effective = mode === "new" || !open ? "new" : "continue";
  const cleaned = clean(text.trim(), 4000);
  return store.tx((w) => {
    const jobId = effective === "new" ? `job_${randomBytes(12).toString("hex")}` : open!;
    const seq = w.event("asked", subject as Clean, { subject, jobId, mode: effective, text: cleaned });
    if (effective === "new") w.run("INSERT INTO jobs (id, kind, subject, title, state, reason, created_seq) VALUES (?, 'ask', ?, ?, 'queued', NULL, ?)", jobId as Clean, subject as Clean, clean(cleaned, 200), seq);
    w.run("INSERT INTO asks (key, subject, job_id, mode, text, digest, seq) VALUES (?, ?, ?, ?, ?, ?, ?)", key as Clean, subject as Clean, jobId as Clean, effective as Clean, cleaned, digest as Clean, seq);
    return result({ subject, job_id: jobId, mode: effective });
  });
}

/**
 * GET /v2/search: literal, case-insensitive, over real problems' titles, retained evidence and findings of real work,
 * and prompts; each subject once, newest matching seq first. Trial work is not searched.
 */
export function search(store: Store, config: Config, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return { items: [] };
  const hits = [
    ...store.all<{ subject: string; text: string; seq: number }>("SELECT id AS subject, title AS text, seq FROM incidents WHERE instr(lower(title), ?) > 0", needle),
    ...store.all<{ subject: string; text: string; seq: number }>(
      `SELECT j.subject, e.text, j.created_seq AS seq FROM evidence e JOIN runs r ON r.id = e.run_id JOIN jobs j ON j.id = r.job_id
       WHERE j.kind <> 'trial' AND instr(lower(e.text), ?) > 0 LIMIT 500`, needle),
    ...store.all<{ subject: string; text: string; seq: number }>(
      `SELECT j.subject, f.claims || ' ' || f.body AS text, j.created_seq AS seq FROM findings f JOIN runs r ON r.id = f.run_id JOIN jobs j ON j.id = r.job_id
       WHERE j.kind <> 'trial' AND instr(lower(f.claims || ' ' || f.body), ?) > 0 LIMIT 500`, needle),
    ...store.all<{ subject: string; text: string; seq: number }>("SELECT subject, text, seq FROM asks WHERE instr(lower(text), ?) > 0 LIMIT 500", needle),
  ];
  const best = new Map<string, { id: string; title: string; excerpt: string; seq: number }>();
  for (const h of hits) {
    const at = h.text.toLowerCase().indexOf(needle);
    const excerpt = clean(`${at > 60 ? "…" : ""}${h.text.slice(Math.max(0, at - 60), at + needle.length + 80)}${at + needle.length + 80 < h.text.length ? "…" : ""}`, 400);
    const prior = best.get(h.subject);
    if (!prior || h.seq > prior.seq) best.set(h.subject, { id: h.subject, title: label(store, config, h.subject) ?? h.subject, excerpt, seq: h.seq });
  }
  return { items: [...best.values()].sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1)).slice(0, 50) };
}

/** Counts an occurrence by the hour of its event time, in the transaction that counts it. */
export function hourly(w: Writer, incident: string, atMs: number, n = 1) {
  w.run("INSERT INTO hourly (incident, hour, count) VALUES (?, ?, ?) ON CONFLICT (incident, hour) DO UPDATE SET count = count + excluded.count", incident as Clean, Math.floor(atMs / HOUR), n);
}
