/**
 * Collection. Each source is read into a slice, and a slice commits in one transaction: the occurrence keys it saw
 * (inserted "if absent", and only what was inserted is counted), the incidents those counts belong to, its coverage,
 * its readings, any deploy, and the checkpoint. Keys older than the overlap are dropped in the same commit. A crash
 * before the commit changes nothing; replaying the same records after it adds nothing, because their keys exist.
 *
 * An occurrence's key is scoped to the source that counts it, and made only from the source's own data: for a log line, the cluster, namespace, pod UID,
 * container, container instance, the full timestamp, a digest of the line and its ordinal among identical lines at
 * that timestamp in that instance; for a Datadog log, its ID; for a Kubernetes event, its UID with the cumulative
 * count kept as a baseline beyond the overlap.
 *
 * Every window of event time is a half-open Span [from, to): a slice, its overlap, the 14-day floor and a saturated
 * interval. A record at a slice's end belongs to the next slice.
 */
import { createHash } from "node:crypto";
import { statfsSync } from "node:fs";
import { DEFAULT_WORDS, LIMITS, type Config, type Source, type Words } from "./config.ts";
import { clock } from "./clock.ts";
import { kubectl, parseEvents, parsePods, parseRevision, parseRollout, parseTop, streamLogs, type Pod, type Target } from "./kube.ts";
import * as datadog from "./datadog.ts";
import { backoff, classify, fixFor, type FailureKind } from "./failures.ts";
import { clean, errorText } from "./redact.ts";
import { Full, type Clean, type Store, type Writer } from "./store.ts";
import { sample, UNMEASURED, type Sample } from "./parse.ts";
import { afterChange, afterDeploy, announce, groupNow, hourly } from "./inbox.ts";
import { queueInvestigation } from "./agents.ts";
import { approvalKey } from "./trial.ts";

const sha = (...parts: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/** A half-open interval of event time. */
export type Span = { readonly from: number; readonly to: number };
export const within = (s: Span, at: number) => at >= s.from && at < s.to;

const matchers = new WeakMap<Words, { error: RegExp | null; warn: RegExp | null }>();
const wordsRe = (list: ReadonlyArray<string>) =>
  list.length ? new RegExp(`(?<![\\p{L}\\p{N}_])(${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`, "iu") : null;

/**
 * Lines that are problems, how bad, and what groups them: numbers, IDs, quoted values and times do not. The app's
 * words decide the class (whole words, any case; error wins a tie). A provider's own severity (`given`) wins over
 * the words.
 */
export function problem(text: string, words: Words = DEFAULT_WORDS, given?: "error" | "warn"): { fingerprint: string; title: string; severity: "error" | "warn" } | null {
  let re = matchers.get(words);
  if (!re) matchers.set(words, (re = { error: wordsRe(words.error), warn: wordsRe(words.warn) }));
  const severity = given ?? (re.error?.test(text) ? "error" : re.warn?.test(text) ? "warn" : null);
  if (!severity) return null;
  const normal = clean(text.split("\n")[0]!, 2000)
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(0x)?[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'/g, "<str>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const title = normal.replace(/(\s*<(n|id|ts|str)>)+$/g, "").trim() || normal;
  return { fingerprint: normal, title, severity };
}

type Severity = "error" | "warn" | "info";
/**
 * One reading of one kind: its state, and when the provider says what it returned was observed. "ok" is only ever
 * built from parsed, recognised parts (see observe()); freshness everywhere comes from `observedMs`, never from when
 * Overwatch asked.
 */
/** A reading's outcome. Anything not failed says when the provider observed it: no reading is fresh by default. */
type Reading = { state: "failed"; missed: null } | { state: "ok" | "capped" | "gap"; missed: number | null; observedMs: number };
const observe = (complete: boolean, observedMs: number): Reading => ({ state: complete ? "ok" : "gap", missed: null, observedMs });
type Bucket = { title: string; severity: Severity; reading: string; inexact: boolean; seen: boolean };

/** A container's identity: its current and previous instance. */
const identity = (c: Pod["containers"][number]) => c.instances.map((i) => `${i.previous ? "previous" : "current"}:${i.id}`).join(" ");

const MEMORY = "memory % of limit (highest container)";
const NOT_READY = "pods not ready";
/**
 * Problems from gauges, with hysteresis: a breach needs `samples` measured samples in a row over the limit, and a
 * clear the same number at or under it. A sample that was not measured breaks both runs: it is never "fine".
 */
export const METRIC_RULES: ReadonlyArray<{ name: string; over: number; samples: number }> = [
  { name: MEMORY, over: 90, samples: 2 },
  { name: NOT_READY, over: 0, samples: 2 },
];
type Hysteresis = { over: number; under: number; breach: boolean };

/** One sample through a rule: the runs over and under the limit, and whether the problem is open. */
export function hysteresis(rule: { over: number; samples: number }, state: Hysteresis, s: Sample): Hysteresis {
  if (!s.measured) return { over: 0, under: 0, breach: state.breach };
  const value = s.value;
  const over = value > rule.over ? state.over + 1 : 0, under = value > rule.over ? 0 : state.under + 1;
  return { over, under, breach: state.breach ? under < rule.samples : over >= rule.samples };
}

/**
 * What one slice of one source read, before it is committed. Only what is new is charged against the occurrence
 * limit: a record outside the slice, inside a saturated interval, or whose key is already stored (a replay) is
 * passed over before it is charged, so a replay can never use up the room a fresh record needs.
 */
export class Slice {
  readonly admitted: Array<{ key: string; stream: string; at: number; bucket: string; text: string }> = [];
  readonly buckets = new Map<string, Bucket>();
  readonly baselines: Array<{ key: string; count: number; bucket: string }> = [];
  /** State kept beside the counts (whether a monitor is alerting), never counted itself. */
  readonly marks: Array<{ key: string; count: number }> = [];
  readonly readings = new Map<string, Reading>();
  /** Gauge samples; null is a sample that could not be measured. */
  readonly metrics: Array<{ name: string; reading: string; sample: Sample; at: number }> = [];
  /** Incidents whose stored total is now known to be a lower bound (lines counted before were lost). */
  readonly uncertain = new Set<string>();
  fresh = 0;
  revision: string | null = null;
  /** The provider's rollout time of `revision`, when the cluster says it. */
  rollout: number | null = null;
  /** A used-capacity sample (null value: not measured), by the provider's time. */
  capacity: { at: number; value: number | null; unit: string | null } | null = null;
  readonly source: Source;
  readonly span: Span;
  private readonly saturated: ReadonlyArray<Span>;
  private readonly known: (key: string) => boolean;
  private readonly keys = new Set<string>();
  constructor(source: Source, span: Span, saturated: ReadonlyArray<Span>, known: (key: string) => boolean = () => false) {
    this.source = source;
    this.span = span;
    this.saturated = saturated;
    this.known = known;
  }

  /** The problem's bucket; past the distinct-problem limit, the overflow one. */
  bucket(fingerprint: string, title: string, severity: Severity, reading: string): string {
    if (this.buckets.has(fingerprint)) return fingerprint;
    const distinct = [...this.buckets.keys()].filter((k) => k !== "overflow").length;
    if (distinct < LIMITS.problemsPerSlice) {
      this.buckets.set(fingerprint, { title, severity, reading, inexact: false, seen: false });
      return fingerprint;
    }
    if (!this.buckets.has("overflow")) this.buckets.set("overflow", { title: "many other errors", severity: "error", reading, inexact: false, seen: false });
    return "overflow";
  }

  /** A problem that may have occurred but could not be counted: its total becomes a lower bound. */
  unsure(fingerprint: string, title: string, severity: Severity, reading: string) {
    this.buckets.get(this.bucket(fingerprint, title, severity, reading))!.inexact = true;
  }

  /** One occurrence. Past the limit it is not admitted, and its problem's count becomes a lower bound. */
  add(key: string, stream: string, at: number, fingerprint: string, title: string, severity: Severity, reading = "logs", text = title) {
    if (!within(this.span, at) || this.saturated.some((s) => within(s, at))) return;
    if (this.keys.has(key) || this.known(key)) return;
    this.keys.add(key);
    const bucket = this.bucket(fingerprint, title, severity, reading);
    if (++this.fresh > LIMITS.occurrencesPerSlice) {
      this.buckets.get(bucket)!.inexact = true;
      return;
    }
    this.admitted.push({ key, stream, at, bucket, text: text.slice(0, 4000) });
  }

  /**
   * A cumulative counter (a Kubernetes event's count, a monitor's state): only its increase since the stored baseline
   * counts. `present` says the problem is still there now even if the counter did not move.
   */
  counter(key: string, count: number, fingerprint: string, title: string, severity: Severity, reading: string, present = false) {
    const bucket = this.bucket(fingerprint, title, severity, reading);
    if (present) this.buckets.get(bucket)!.seen = true;
    this.baselines.push({ key, count, bucket });
  }

  get capped() {
    return this.fresh > LIMITS.occurrencesPerSlice;
  }
}

export interface Space {
  freeBytes: number;
  dbBytes: number;
}


const incidentId = (source: Source, bucket: string) => `inc_${sha(source.app, source.environment, source.id, bucket).slice(0, 32)}`;

export class Collector {
  private readonly nextMono = new Map<string, number>();
  private readonly okMono = new Map<string, number>();
  /** Refusals that hold for an endpoint (sign-in, unreachable), within one pass: one failed call, not one per source. */
  private readonly refused = new Map<string, SourceFailure>();
  private wakeAt: number | null = null;
  private override: Space | null = null;
  private running: Promise<void> | null = null;
  paused: "disk" | null = null;

  private readonly store: Store;
  private readonly config: Config;
  private readonly directory: string;
  constructor(store: Store, config: Config, directory: string) {
    this.store = store;
    this.config = config;
    this.directory = directory;
    // Every write, wherever it comes from, is admitted by the same disk check.
    store.guard = () => {
      if (!this.room(false)) throw new Full("collection is paused for disk space");
    };
  }

  wake() {
    this.wakeAt = clock.mono() + LIMITS.wakeDelayMs;
  }
  setSpace(space: Space) {
    this.override = space;
  }
  /** When each reading last succeeded, by the monotonic clock, for freshness while the process lives. */
  okAtMono(source: string, reading: string): number | undefined {
    return this.okMono.get(`${source}|${reading}`);
  }

  private space(): Space {
    if (this.override) return this.override;
    let free = Number.MAX_SAFE_INTEGER;
    try {
      const s = statfsSync(this.directory);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {
      // Unknown free space is not a reason to stop.
    }
    return { freeBytes: free, dbBytes: this.store.liveBytes() };
  }

  /**
   * Whether there is room to admit: the free-space floor and the database budget. Over the budget, `maintain` first
   * makes room in the declared order, and measures again. No room: collection pauses with the reason `disk`.
   */
  private room(maintain: boolean): boolean {
    let space = this.space();
    if (maintain && space.dbBytes > LIMITS.databaseBudgetBytes) {
      this.store.retain(clock.now(), () => this.space().dbBytes > LIMITS.databaseBudgetBytes);
      space = this.space();
    }
    const ok = space.freeBytes >= LIMITS.freeFloorBytes && space.dbBytes <= LIMITS.databaseBudgetBytes;
    this.paused = ok ? null : "disk";
    return ok;
  }

  /**
   * Whether a source is due. The stored wall-clock time decides, and the monotonic clock bounds it: after a restart
   * the live deadline is rebuilt as at most the delay that was chosen, so a wall clock moved backwards cannot
   * postpone a probe.
   */
  private due(source: Source): boolean {
    const row = this.store.get<{ next_ms: number | null; delay_ms: number | null; failure: string | null }>("SELECT next_ms, delay_ms, failure FROM sources WHERE id = ?", source.id);
    if (!row || row.next_ms === null) return true;
    if (clock.now() >= row.next_ms) return true;
    if (!this.nextMono.has(source.id)) this.nextMono.set(source.id, clock.mono() + Math.min(row.next_ms - clock.now(), row.delay_ms ?? source.everyMs));
    if (clock.mono() >= this.nextMono.get(source.id)!) return true;
    return row.failure !== null && this.wakeAt !== null && clock.mono() >= this.wakeAt;
  }

  /** One scheduler pass over the work that is due. Passes never overlap. */
  pass(): Promise<void> {
    this.running ??= this.passOnce().finally(() => (this.running = null));
    return this.running;
  }

  /** Each kind's reader, exhaustive by type; a kind without one fails closed rather than borrowing another's. */
  private reader(source: Source): (s: Source) => Promise<unknown> {
    const readers: { readonly [K in Source["kind"]]: (s: Source) => Promise<unknown> } = { kubernetes: (s) => this.kubernetes(s), datadog: (s) => this.datadog(s) };
    const read = readers[source.kind];
    if (!read) throw new Error(`no reader for source kind ${String(source.kind)}`);
    return read;
  }

  private bounded = false;
  private async passOnce() {
    // Each source's next probe gets its live bound once, from the stored time and delay, counted from when this
    // process started: a wall clock moved backwards cannot postpone it, and time already elapsed counts.
    if (!this.bounded) {
      this.bounded = true;
      const { now, mono } = clock.start;
      for (const r of this.store.all<{ id: string; next_ms: number; delay_ms: number | null }>("SELECT id, next_ms, delay_ms FROM sources WHERE next_ms IS NOT NULL"))
        this.nextMono.set(r.id, mono + Math.min(Math.max(0, r.next_ms - now), r.delay_ms ?? this.config.sources.find((x) => x.id === r.id)?.everyMs ?? 60_000));
    }
    const roomy = this.room(true);
    this.store.reclaim(); // what was freed goes back to the disk a bounded step per pass
    if (!roomy) return;
    const woke = this.wakeAt !== null && clock.mono() >= this.wakeAt;
    this.refused.clear();
    try {
      for (const source of this.config.sources) {
        if (!this.due(source)) continue;
        try {
          const earlier = this.refused.get(endpoint(source));
          if (earlier) throw earlier;
          await this.reader(source)(source);
        } catch (error) {
          if (error instanceof Full) throw error;
          if (error instanceof SourceFailure && (error.kind === "signin" || error.kind === "unreachable")) this.refused.set(endpoint(source), error);
          this.fail(source, error);
        }
      }
    } catch (error) {
      if (error instanceof Full) return; // paused: the failure record waits for room like everything else
      throw error;
    }
    if (woke) this.wakeAt = null;
  }

  /**
   * Where reading starts: the checkpoint, never before the 14-day floor. Older time is the gap [checkpoint, floor).
   * `ordinary` is true for one new ordinary interval: time moved on since the checkpoint, by no more than two polling
   * intervals. A replay of the same window (the clock did not move) and a catch-up after a sleep are not ordinary.
   */
  private window(source: Source, overlap: number) {
    const now = clock.now(), floor = now - LIMITS.catchUpMs;
    const row = this.store.get<{ checkpoint_ms: number | null }>("SELECT checkpoint_ms FROM sources WHERE id = ?", source.id);
    let start = Math.min(row?.checkpoint_ms ?? now - source.everyMs, now);
    const gap: Span | null = start < floor ? { from: start, to: floor } : null;
    if (gap) start = floor;
    const saturated = this.store
      .all<{ from_ms: number; to_ms: number }>("SELECT from_ms, to_ms FROM saturated WHERE source = ?", source.id)
      .map((s): Span => ({ from: s.from_ms, to: s.to_ms }));
    return { now, start, floor, gap, overlap, saturated, ordinary: now - start > 0 && now - start <= 2 * source.everyMs };
  }

  private slice(source: Source, w: ReturnType<Collector["window"]>, start: number, end: number) {
    const known = (key: string) => this.store.get("SELECT 1 FROM occurrences WHERE key = ?", key) !== undefined;
    return new Slice(source, { from: Math.max(start - w.overlap, w.floor), to: end }, w.saturated, known);
  }

  /**
   * Kubernetes, in slices of at most six hours from the checkpoint to now, each committed on its own: a crash or a
   * sleep during catch-up resumes at the next slice. Logs are read for every slice; events, workloads and usage are
   * the cluster's present state and are read with the last one.
   */
  private async kubernetes(source: Source) {
    const t: Target = { context: source.context!, namespace: source.namespace! };
    const w = this.window(source, LIMITS.overlapMs.kubernetes);
    // The canary: the pod list every reading needs. A sign-in failure is one call, not one per pod.
    let pods = await this.pods(t, source);
    let start = w.start, gap = w.gap, stuck = false;
    do {
      const end = Math.min(start + LIMITS.sliceMs, w.now);
      const slice = this.slice(source, w, start, end);
      if (source.readings.includes("logs")) {
        pods = await this.logs(t, source, slice, pods);
        // Logs that cannot be read keep the checkpoint where it is; the present state is still read.
        if (slice.readings.get("logs")!.state === "failed") stuck = true;
      }
      if (end === w.now) await this.present(t, source, slice, pods, w.now);
      this.commit(slice, gap, stuck ? null : end, LIMITS.overlapMs.kubernetes, end === w.now ? { ordinary: w.ordinary } : null);
      gap = null;
      start = stuck ? Math.max(end, w.now - LIMITS.sliceMs) : end;
    } while (start < w.now);
  }

  private async pods(t: Target, source: Source) {
    const listed = await kubectl(t, "get", ["pods", "-l", source.selector!, "-o", "json"]);
    if (listed.code !== 0) throw new SourceFailure(classify(listed.stderr), listed.stderr || `kubectl exited ${listed.code}`);
    return parsePods(listed.stdout);
  }

  /** A reading the source refused (permission, configuration) is recorded as failed; any other failure fails the pass. */
  private refusedReading(slice: Slice, reading: string, stderr: string) {
    const kind = classify(stderr);
    if (kind !== "permission" && kind !== "config") throw new SourceFailure(kind, stderr);
    slice.readings.set(reading, { state: "failed", missed: null });
  }

  /**
   * One slice of logs. A container's records are kept only if its identity (its current and previous instance) is
   * the same in the pod list after the read as before it; otherwise the read is ambiguous, is discarded, is a gap,
   * and the problems it showed become lower bounds. What a read shows was lost (a line counted before and no longer
   * returned: rotation or truncation) is a gap and makes those lines' problems lower bounds. A running container
   * with no instance, or a restarted one with no previous instance to read, is a gap. A line without a readable
   * time cannot be placed and is a gap. Returns the pod list taken after the read.
   */
  private async logs(t: Target, source: Source, slice: Slice, before: ReadonlyArray<Pod>): Promise<Pod[]> {
    const order: Reading["state"][] = ["ok", "gap", "capped", "failed"], at = clock.now();
    let state: Reading = { state: before.length > LIMITS.podsPerSource ? "capped" : "ok", missed: null, observedMs: at };
    const worse = (s: Reading["state"]) => {
      if (order.indexOf(s) > order.indexOf(state.state)) state = s === "failed" ? { state: s, missed: null } : { state: s, missed: null, observedMs: at };
    };
    type Line = { key: string; stream: string; at: number; fingerprint: string; title: string; severity: "error" | "warn"; text: string };
    const reads: Array<{ uid: string; container: string; identity: string; lines: Line[] }> = [];
    for (const pod of before.slice(0, LIMITS.podsPerSource)) {
      for (const container of pod.containers) {
        const lines: Line[] = [];
        if (!container.instances.some((i) => !i.previous) && (pod.running || container.restarts > 0)) worse("gap");
        if (container.restarts > 0 && !container.instances.some((i) => i.previous)) worse("gap");
        for (const instance of container.instances) {
          const stream = sha("k8s", source.id, t.context, t.namespace, pod.uid, container.name, instance.id);
          const ordinals = new Map<string, number>();
          const seen = new Set<string>();
          let lastAt = slice.span.from;
          const read = await streamLogs(t, pod.name, container.name, iso(slice.span.from), instance.previous, LIMITS.bytesPerPodCall, (stamp, text) => {
            const at = Date.parse(stamp);
            if (!Number.isFinite(at)) return void worse("gap");
            if (at < slice.span.from) return;
            if (at >= slice.span.to) return false;
            lastAt = at;
            const p = problem(text, source.words);
            if (!p) return;
            const digest = sha(text);
            const ordinal = ordinals.get(stamp + digest) ?? 0;
            ordinals.set(stamp + digest, ordinal + 1);
            const key = sha("k8s", source.id, t.context, t.namespace, pod.uid, container.name, instance.id, stamp, digest, ordinal);
            seen.add(key);
            lines.push({ key, stream, at, ...p, text });
          });
          if (read.code !== 0) {
            if (instance.previous && /previous terminated container|not found/i.test(read.stderr)) worse("gap");
            else {
              this.refusedReading(slice, "logs", read.stderr);
              worse("failed");
            }
            continue;
          }
          if (read.capped) worse("capped");
          else if (read.cutTail) worse("gap");
          const through = read.capped || read.cutTail ? lastAt : slice.span.to;
          const lost = this.store
            .all<{ key: string; incident: string }>("SELECT key, incident FROM occurrences WHERE stream = ? AND at_ms >= ? AND at_ms < ?", stream, slice.span.from, through)
            .filter((r) => !seen.has(r.key));
          if (lost.length) worse("gap");
          for (const r of lost) if (r.incident) slice.uncertain.add(r.incident);
        }
        reads.push({ uid: pod.uid, container: container.name, identity: identity(container), lines });
      }
    }
    const after = await this.pods(t, source);
    for (const r of reads) {
      const now = after.find((p) => p.uid === r.uid)?.containers.find((c) => c.name === r.container);
      if (!now || identity(now) !== r.identity) {
        worse("gap");
        for (const x of r.lines) slice.unsure(x.fingerprint, x.title, x.severity, "logs");
        continue;
      }
      for (const x of r.lines) slice.add(x.key, x.stream, x.at, x.fingerprint, x.title, x.severity, "logs", x.text);
    }
    if (slice.capped && state.state === "ok") state = { state: "capped", missed: slice.fresh - LIMITS.occurrencesPerSlice, observedMs: at };
    slice.readings.set("logs", state);
    return after;
  }

  /**
   * What the cluster says now: warning events, the running revision and readiness, memory use against limits. The
   * memory sample is measured only when every container with a limit was measured: one pod cannot speak for another.
   */
  private async present(t: Target, source: Source, slice: Slice, pods: ReadonlyArray<Pod>, now: number) {
    if (source.readings.includes("events")) {
      const r = await kubectl(t, "get", ["events", "-o", "json"]);
      if (r.code !== 0) this.refusedReading(slice, "events", r.stderr);
      else {
        for (const e of parseEvents(r.stdout)) {
          if (e.type !== "Warning") continue;
          const p = problem(`WARN ${e.reason}: ${e.message}`, source.words, "warn")!;
          slice.counter(sha("k8s-event", source.id, t.context, t.namespace, e.uid), e.count, `event:${e.reason}:${p.fingerprint}`, `${clean(e.reason, 200)}: ${p.title.replace(/^WARN [^:]*: /, "")}`, "warn", "events");
        }
        slice.readings.set("events", observe(true, now));
      }
    }
    if (source.readings.includes("workloads")) {
      const r = await kubectl(t, "get", ["deployments", "-l", source.selector!, "-o", "json"]);
      if (r.code !== 0) this.refusedReading(slice, "workloads", r.stderr);
      else {
        slice.revision = parseRevision(r.stdout);
        slice.readings.set("workloads", observe(!!slice.revision, now));
        // A new revision: ask the cluster when it rolled out (get replicasets, read-only). Never first-seen time.
        const last = this.store.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", source.app, source.environment);
        if (slice.revision && last && last.revision !== slice.revision) {
          const rs = await kubectl(t, "get", ["replicasets", "-l", source.selector!, "-o", "json"]);
          if (rs.code === 0) slice.rollout = parseRollout(rs.stdout, slice.revision);
        }
      }
      slice.metrics.push({ name: NOT_READY, reading: "workloads", sample: sample(pods.filter((p) => !p.ready).length), at: now });
    }
    if (source.readings.includes("usage")) {
      const r = await kubectl(t, "top", ["pod", "-l", source.selector!, "--containers", "--no-headers"]);
      let worst: number | null = null;
      if (r.code !== 0) this.refusedReading(slice, "usage", r.stderr);
      else {
        const rows = parseTop(r.stdout);
        const limited = pods.flatMap((p) => p.containers.filter((c) => c.memoryLimit).map((c) => ({ pod: p.name, container: c.name, limit: c.memoryLimit! })));
        const used = limited.map((c) => rows.find((row) => row.pod === c.pod && row.container === c.container)?.memory ?? null);
        if (limited.length && used.every((m) => m !== null)) worst = Math.max(...used.map((m, i) => (100 * m!) / limited[i]!.limit));
        slice.readings.set("usage", observe(worst !== null, now));
      }
      slice.metrics.push({ name: MEMORY, reading: "usage", sample: worst === null ? UNMEASURED : sample(Math.round(worst * 10) / 10), at: now });
    }
  }

  private async datadog(source: Source) {
    const w = this.window(source, LIMITS.overlapMs.datadog);
    let start = w.start;
    let gap = w.gap;
    do {
      const end = Math.min(start + LIMITS.sliceMs, w.now);
      const slice = this.slice(source, w, start, end);
      try {
        if (source.readings.includes("logs")) {
          let unplaced = false;
          const recognised = await datadog.searchLogs(source, slice.span.from, slice.span.to, (log) => {
            if (log.at === null || log.id === null) return void (unplaced = true); // cannot be placed or counted once
            const given = /^(error|critical|emergency|alert)$/i.test(log.status) ? "error" : /^warn/i.test(log.status) ? "warn" : undefined;
            const p = problem(given === "error" ? `ERROR ${log.message}` : given === "warn" ? `WARN ${log.message}` : log.message, source.words, given);
            if (p) slice.add(sha("dd", source.baseUrl, source.id, log.id), source.id, log.at, p.fingerprint, p.title.replace(/^(ERROR|WARN) (?=ERROR|WARN)/, ""), p.severity, "logs", log.message);
          });
          slice.readings.set("logs", slice.capped ? { state: "capped", missed: slice.fresh - LIMITS.occurrencesPerSlice, observedMs: end } : observe(recognised && !unplaced, end));
        }
        if (end === w.now && source.readings.includes("monitors")) {
          const answer = await datadog.monitors(source);
          for (const m of answer.monitors) {
            // One incident per monitor across Warn and Alert. Its count is the number of transitions into alerting:
            // an OK that alerts again is counted again; staying in alert, or moving between Warn and Alert, is not.
            const alerting = /^(alert|warn)/i.test(m.state!);
            const stateKey = sha("dd-monitor-alerting", source.id, m.id), countKey = sha("dd-monitor-transitions", source.id, m.id);
            const was = (this.store.get<{ count: number }>("SELECT count FROM baselines WHERE key = ?", stateKey)?.count ?? 0) === 1;
            const transitions = this.store.get<{ count: number }>("SELECT count FROM baselines WHERE key = ?", countKey)?.count ?? 0;
            slice.marks.push({ key: stateKey, count: alerting ? 1 : 0 });
            if (!alerting) continue;
            const severity = /^alert/i.test(m.state!) ? "error" : "warn";
            slice.counter(countKey, was ? transitions : transitions + 1, `monitor:${m.id}`, `Monitor ${clean(m.name, 200)}`, severity, "monitors", true);
          }
          slice.readings.set("monitors", observe(answer.complete, end));
        }
        if (end === w.now && source.readings.includes("metrics")) {
          const point = await datadog.metric(source, end - source.everyMs, end);
          slice.metrics.push({ name: point?.name ?? `${source.metric} (${source.metric})`, reading: "metrics", sample: point ? sample(point.value) : UNMEASURED, at: point?.at ?? end });
          // Fresh as of the point's own time: an old point returned again is not a new measurement.
          slice.readings.set("metrics", observe(point !== null, point?.at ?? 0));
          if (source.capacity) slice.capacity = { at: point?.at ?? end, value: point ? point.value : null, unit: point?.unit ?? null };
        }
      } catch (error) {
        if (error instanceof datadog.HttpFailure) throw new SourceFailure(classify(error.message, error.status), error.message);
        throw error;
      }
      this.commit(slice, gap, end, LIMITS.overlapMs.datadog, end === w.now ? { ordinary: w.ordinary } : null);
      gap = null;
      start = end;
    } while (start < w.now);
  }

  /**
   * The slice, in one transaction (admitted by the store's guard). The last slice of a pass closes the pass's
   * interval (`last`); see interval().
   */
  private commit(slice: Slice, gap: Span | null, checkpoint: number | null, overlap: number, last: { ordinary: boolean } | null) {
    const source = slice.source;
    const now = clock.now();
    this.store.tx((w) => {
      const seq = w.event("slice", source.id as Clean, {
        from: slice.span.from,
        to: slice.span.to,
        fresh: slice.fresh,
        admitted: slice.admitted.length,
        readings: Object.fromEntries(slice.readings),
        ordinary: last?.ordinary ?? false,
      });
      if (gap) {
        w.run("INSERT INTO coverage (seq, source, reading, from_ms, to_ms, state, missed) VALUES (?, ?, 'all', ?, ?, 'gap', NULL)", seq, source.id as Clean, gap.from, gap.to);
        w.event("coverage_gap", source.id as Clean, { from: gap.from, to: gap.to, reason: "older than the 14-day catch-up limit" });
      }
      const counts = new Map<string, number>();
      const firstAt = new Map<string, number>();
      const recent = new Map<string, Slice["admitted"]>();
      for (const record of slice.admitted) {
        const inserted = w.run(
          "INSERT OR IGNORE INTO occurrences (key, source, stream, at_ms, incident) VALUES (?, ?, ?, ?, ?)",
          record.key as Clean, source.id as Clean, record.stream as Clean, record.at, incidentId(source, record.bucket) as Clean,
        ).changes;
        if (!inserted) continue;
        counts.set(record.bucket, (counts.get(record.bucket) ?? 0) + 1);
        firstAt.set(record.bucket, Math.min(firstAt.get(record.bucket) ?? Infinity, record.at));
        hourly(w, incidentId(source, record.bucket), record.at);
        recent.set(record.bucket, [...(recent.get(record.bucket) ?? []).slice(-(LIMITS.linesPerProblem - 1)), record]);
      }
      for (const m of slice.marks)
        w.run("INSERT INTO baselines (key, source, count, seen_ms) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = excluded.count, seen_ms = excluded.seen_ms", m.key as Clean, source.id as Clean, m.count, now);
      for (const b of slice.baselines) {
        const before = this.store.get<{ count: number }>("SELECT count FROM baselines WHERE key = ?", b.key)?.count ?? 0;
        if (b.count > before) {
          counts.set(b.bucket, (counts.get(b.bucket) ?? 0) + (b.count - before));
          hourly(w, incidentId(source, b.bucket), now, b.count - before);
        }
        w.run(
          "INSERT INTO baselines (key, source, count, seen_ms) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = max(count, excluded.count), seen_ms = excluded.seen_ms",
          b.key as Clean, source.id as Clean, b.count, now,
        );
      }
      // The latest lines of each problem, for investigations: cleaned by the writer, at most linesPerProblem kept.
      for (const [bucket, records] of recent) {
        const id = incidentId(source, bucket);
        for (const r of records) w.run("INSERT INTO lines (incident, source, at_ms, text) VALUES (?, ?, ?, ?)", id as Clean, source.name as Clean, r.at, r.text as Clean);
        w.run("DELETE FROM lines WHERE incident = ? AND rowid NOT IN (SELECT rowid FROM lines WHERE incident = ? ORDER BY at_ms DESC, rowid DESC LIMIT ?)", id as Clean, id as Clean, LIMITS.linesPerProblem);
      }
      const touched = new Set<string>();
      for (const [bucket, info] of slice.buckets) {
        const added = counts.get(bucket) ?? 0;
        if (added > 0 || info.seen) touched.add(incidentId(source, bucket));
        if (added === 0 && !info.inexact && !info.seen) continue;
        const id = incidentId(source, bucket);
        const before = this.store.get<{ severity: string; active: number }>("SELECT severity, active FROM incidents WHERE id = ?", id);
        if (added === 0 && !info.inexact && !before) continue;
        const group = before ? groupNow(this.store, id) : null;
        incident(w, source, bucket, info.title, info.severity, info.reading, added, !info.inexact, now, seq, added > 0 || info.seen, info.seen);
        // Onset: the provider's time of the first line ever admitted for a new problem.
        if (!before && firstAt.has(bucket)) w.run("INSERT OR IGNORE INTO onsets (incident, at_ms) VALUES (?, ?)", id as Clean, firstAt.get(bucket)!);
        afterChange(w, this.store, id, before, added, seq);
        // A problem's first admission is investigated automatically once the model has passed its trial.
        if (!before && added > 0 && this.store.meta(approvalKey(this.config)) === "on") queueInvestigation(w, this.store, this.config, id, "automatic");
        announce(w, this.store, id, group, seq);
      }
      for (const id of slice.uncertain) w.run("UPDATE incidents SET exact = 0 WHERE id = ?", id as Clean);
      // Time a reading did not fully cover: the totals of problems active then are lower bounds from now on.
      for (const [reading, r] of slice.readings) {
        if (r.state !== "ok") w.run("UPDATE incidents SET exact = 0 WHERE source = ? AND reading = ? AND active = 1", source.id as Clean, reading as Clean);
      }
      if (gap) w.run("UPDATE incidents SET exact = 0 WHERE source = ? AND active = 1 AND reading <> 'gauge'", source.id as Clean);
      if (slice.capped) w.run("INSERT OR REPLACE INTO saturated (source, reading, from_ms, to_ms) VALUES (?, 'logs', ?, ?)", source.id as Clean, slice.span.from, slice.span.to);
      const lastSeen = this.store.get<{ ok_ms: number | null }>("SELECT ok_ms FROM readings WHERE source = ? AND reading = 'workloads'", source.id)?.ok_ms ?? null;
      for (const [reading, r] of slice.readings) {
        w.run("INSERT INTO coverage (seq, source, reading, from_ms, to_ms, state, missed) VALUES (?, ?, ?, ?, ?, ?, ?)", seq, source.id as Clean, reading as Clean, slice.span.from, slice.span.to, r.state as Clean, r.missed);
        w.run(
          `INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source, reading) DO UPDATE SET state = excluded.state, at_ms = excluded.at_ms, ok_ms = coalesce(excluded.ok_ms, ok_ms)`,
          // Both times are the provider's: when it observed (or, failed, when it last refused). Nothing records the
          // time Overwatch asked, so no consumer can take that for freshness.
          source.id as Clean, reading as Clean, r.state as Clean, r.state === "failed" ? now : Math.min(now, r.observedMs), r.state === "failed" ? null : Math.min(now, r.observedMs),
        );
        if (r.state !== "failed") this.okMono.set(`${source.id}|${reading}`, clock.mono() - Math.max(0, now - r.observedMs));
      }
      if (last) this.interval(w, source, slice.readings, slice.metrics, touched, last.ordinary, seq, now);
      if (slice.revision) this.deploy(w, source, slice.revision, slice.rollout, lastSeen, now);
      if (slice.capacity && source.capacity) {
        // A sample carries what it proves: the metric, the configured unit and ceiling, and the provider's own unit.
        const series = `${sha(source.metric, source.capacity.resource, source.capacity.unit, source.capacity.limit)}:${slice.capacity.unit ?? ""}`;
        w.run("INSERT INTO samples (source, series, at_ms, value) VALUES (?, ?, ?, ?)", source.id as Clean, series as Clean, slice.capacity.at, slice.capacity.value);
        w.run("DELETE FROM samples WHERE source = ? AND id NOT IN (SELECT id FROM samples WHERE source = ? ORDER BY id DESC LIMIT 60)", source.id as Clean, source.id as Clean);
      }
      if (checkpoint !== null) {
        const before = this.store.get<{ failure: string | null }>("SELECT failure FROM sources WHERE id = ?", source.id);
        w.run(
          `INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint, delay_ms) VALUES (?, ?, NULL, 0, ?, 0, NULL, ?, ?)
           ON CONFLICT (id) DO UPDATE SET checkpoint_ms = excluded.checkpoint_ms, failure = NULL, streak = 0, next_ms = excluded.next_ms, suspended = 0, fix = NULL,
             endpoint = excluded.endpoint, delay_ms = excluded.delay_ms`,
          source.id as Clean, checkpoint, now + source.everyMs, endpoint(source) as Clean, source.everyMs,
        );
        if (before?.failure) w.event("source_recovered", source.id as Clean, { was: before.failure });
        w.run("DELETE FROM occurrences WHERE source = ? AND at_ms < ?", source.id as Clean, checkpoint - overlap);
        w.run("DELETE FROM saturated WHERE source = ? AND to_ms <= ?", source.id as Clean, checkpoint - overlap);
        w.run("DELETE FROM baselines WHERE source = ? AND seen_ms < ?", source.id as Clean, now - LIMITS.catchUpMs);
        w.run(
          "DELETE FROM coverage WHERE source = ? AND state = 'ok' AND id NOT IN (SELECT id FROM coverage WHERE source = ? ORDER BY id DESC LIMIT 200)",
          source.id as Clean, source.id as Clean,
        );
      }
    });
    if (checkpoint !== null) this.nextMono.set(source.id, clock.mono() + source.everyMs);
  }

  /**
   * The one place a pass's interval is recorded, whether it was read or failed: every gauge gets a sample (a failure
   * gives each an unmeasured one) and every active occurrence problem's quiet count moves by quietStep(). Nothing
   * else changes hysteresis or quiet streaks.
   */
  private interval(w: Writer, source: Source, readings: ReadonlyMap<string, Reading>, samples: Slice["metrics"], touched: ReadonlySet<string>, ordinary: boolean, seq: number, now: number) {
    for (const m of samples) this.metric(w, source, m, now, seq);
    const active = this.store.all<{ id: string; reading: string; streak: number }>("SELECT id, reading, streak FROM incidents WHERE source = ? AND active = 1 AND reading <> 'gauge'", source.id);
    for (const i of active) {
      const state = readings.get(i.reading)?.state;
      if (state === undefined) continue; // not a reading of this pass (a present-state reading on a catch-up slice)
      const next = quietStep(i.streak, { touched: touched.has(i.id), measured: state === "ok", ordinary });
      if (next.quiet) {
        w.run("UPDATE incidents SET active = 0, streak = 0 WHERE id = ?", i.id as Clean);
        w.event("quieted", i.id as Clean, { slice: seq });
      } else if (next.streak !== i.streak) w.run("UPDATE incidents SET streak = ? WHERE id = ?", next.streak, i.id as Clean);
    }
  }

  /** One gauge sample through its rule's hysteresis; the breach that opens is counted as one occurrence of its problem. */
  private metric(w: Writer, source: Source, m: Slice["metrics"][number], now: number, seq: number) {
    const row = this.store.get<{ value: number; at_ms: number; over: number; under: number; breach: number }>("SELECT * FROM metrics WHERE source = ? AND name = ?", source.id, m.name);
    if (!m.sample.measured && !row) return;
    const rule = METRIC_RULES.find((r) => r.name === m.name);
    const was = { over: row?.over ?? 0, under: row?.under ?? 0, breach: row?.breach === 1 };
    const next = rule ? hysteresis(rule, was, m.sample) : { over: 0, under: 0, breach: false };
    const value = m.sample.measured ? m.sample.value : null;
    if (rule && next.breach && !was.breach) {
      const id = incidentId(source, `metric:${m.name}`);
      const before = this.store.get<{ severity: string; active: number }>("SELECT severity, active FROM incidents WHERE id = ?", id);
      incident(w, source, `metric:${m.name}`, `${m.name} over ${rule.over} for ${rule.samples} samples`, "error", "gauge", 1, true, now, seq, true);
      hourly(w, id, now);
      afterChange(w, this.store, id, before, 1, seq);
      w.event("incident", source.id as Clean, { metric: m.name, state: "breach", value, over: rule.over });
    } else if (was.breach && !next.breach) {
      w.run("UPDATE incidents SET active = 0 WHERE id = ?", incidentId(source, `metric:${m.name}`) as Clean);
      w.event("incident", source.id as Clean, { metric: m.name, state: "clear", value });
    }
    w.run(
      "INSERT OR REPLACE INTO metrics (source, name, value, at_ms, over, under, breach) VALUES (?, ?, ?, ?, ?, ?, ?)",
      source.id as Clean, m.name as Clean, value ?? row!.value, value === null ? row!.at_ms : m.at, next.over, next.under, next.breach ? 1 : 0,
    );
  }

  /**
   * A deploy is recorded with its seq when the running revision changes, with when it rolled out: the provider's time
   * when the cluster gives one, else only the interval after the last observation of the previous revision and up to
   * this observation. Onset is judged against that interval (see fixes.ts), never against first-seen time alone.
   */
  private deploy(w: Writer, source: Source, revision: string, rollout: number | null, lastSeen: number | null, now: number) {
    const last = this.store.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", source.app, source.environment);
    if (last?.revision === revision) return;
    const seq = w.event("deploy", `${source.app}/${source.environment}` as Clean, { revision, previous: last?.revision ?? null, source: source.id, rolloutMs: rollout });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, ?, ?, ?, ?)", seq, source.app as Clean, source.environment as Clean, revision as Clean, (last?.revision ?? null) as Clean | null);
    if (last) w.run("INSERT INTO rollouts (seq, after_ms, by_ms, exact) VALUES (?, ?, ?, ?)", seq, rollout ?? lastSeen, rollout ?? now, rollout === null ? 0 : 1);
    afterDeploy(w, this.store, source.app, source.environment, seq, revision);
  }

  /** A failure: the next attempt (and possibly suspension) in one transaction; the checkpoint stays. */
  private fail(source: Source, error: unknown) {
    const kind: FailureKind = error instanceof SourceFailure ? error.kind : classify(String((error as Error)?.message ?? error));
    const detail = errorText(error instanceof SourceFailure ? error.detail : error, 400);
    const row = this.store.get<{ streak: number; failure: string | null }>("SELECT streak, failure FROM sources WHERE id = ?", source.id);
    const next = backoff(kind, row?.failure ? row.streak : 0, source.everyMs);
    const now = clock.now();
    this.store.tx((w) => {
      const seq = w.event("source_failed", source.id as Clean, { kind, streak: next.streak, suspended: next.suspended, detail });
      // A failed pass is still an interval: every reading failed, every gauge unmeasured.
      const failed = new Map(source.readings.map((r) => [r, { state: "failed" as const, missed: null }]));
      const gauges = this.store.all<{ name: string }>("SELECT name FROM metrics WHERE source = ?", source.id).map((g) => ({ name: g.name, reading: "", sample: UNMEASURED, at: now }));
      this.interval(w, source, failed, gauges, new Set(), false, seq, now);
      w.run(
        `INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint, delay_ms) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET failure = excluded.failure, streak = excluded.streak, next_ms = excluded.next_ms, suspended = excluded.suspended, fix = excluded.fix,
           delay_ms = excluded.delay_ms`,
        source.id as Clean, kind as Clean, next.streak, now + next.delayMs, next.suspended ? 1 : 0, fixFor(kind, source) as Clean, endpoint(source) as Clean, next.delayMs,
      );
    });
    this.nextMono.set(source.id, clock.mono() + next.delayMs);
  }
}

/**
 * Adds to a problem's count, creating it the first time; an inexact addition makes the count a lower bound. A
 * problem observed now (`active`) is active again and its quiet count starts over.
 */
function incident(w: Writer, source: Source, bucket: string, title: string, severity: Severity, reading: string, added: number, exact: boolean, now: number, seq: number, active: boolean, current = false) {
  w.run(
    `INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, reading, active, streak, first_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT (id) DO UPDATE SET count = count + excluded.count, exact = min(exact, excluded.exact), last_ms = max(last_ms, excluded.last_ms), seq = excluded.seq,
       severity = CASE WHEN ${current ? 1 : 0} = 1 OR excluded.severity = 'error' THEN excluded.severity ELSE severity END,
       active = max(active, excluded.active), streak = CASE WHEN excluded.active = 1 THEN 0 ELSE streak END`,
    incidentId(source, bucket) as Clean, source.app as Clean, source.environment as Clean, source.id as Clean, title as Clean, severity as Clean, added, exact ? 1 : 0, now, now, seq,
    reading as Clean, active ? 1 : 0, seq,
  );
}

export class SourceFailure extends Error {
  readonly kind: FailureKind;
  readonly detail: string;
  constructor(kind: FailureKind, detail: string) {
    super(detail);
    this.kind = kind;
    this.detail = detail;
  }
}

/** What a refusal is shared by: a cluster context, or a Datadog site and key. */
/**
 * The fields that identify a connection, one entry per source kind: two sources share a refusal only if every one is
 * equal. Typed by kind, so a new kind does not compile until it has one, and an unknown kind fails at run time.
 */
export const IDENTITY: { readonly [K in Source["kind"]]: ReadonlyArray<keyof Source> } = { kubernetes: ["context"], datadog: ["baseUrl", "apiKey", "appKey"] };
export const endpoint = (s: Source) => {
  const fields = IDENTITY[s.kind];
  if (!fields) throw new Error(`no connection identity for source kind ${String(s.kind)}`);
  return JSON.stringify([s.kind, ...fields.map((f) => s[f] ?? null)]);
};

/**
 * One step of an active problem's count toward Quiet: an interval that found it again restarts the count; one that
 * was not fully measured or not one new ordinary interval resets it; three fully measured ordinary intervals in a
 * row with nothing new make it quiet.
 */
export function quietStep(streak: number, i: { touched: boolean; measured: boolean; ordinary: boolean }): { streak: number; quiet: boolean } {
  if (i.touched || !i.measured || !i.ordinary) return { streak: 0, quiet: false };
  return streak + 1 >= LIMITS.quietIntervals ? { streak: 0, quiet: true } : { streak: streak + 1, quiet: false };
}
