/**
 * Collection. Each source is read into a slice, and a slice commits in one transaction: the occurrence keys it saw
 * (inserted "if absent", and only what was inserted is counted), the incidents those counts belong to, its coverage,
 * its readings, any deploy, and the checkpoint. Keys older than the overlap are dropped in the same commit. A crash
 * before the commit changes nothing; replaying the same records after it adds nothing, because their keys exist.
 *
 * An occurrence's key is made only from the source's own data: for a log line, the cluster, namespace, pod UID,
 * container, container instance, the full timestamp, a digest of the line and its ordinal among identical lines at
 * that timestamp in that instance; for a Datadog log, its ID; for a Kubernetes event, its UID with the cumulative
 * count kept as a baseline beyond the overlap.
 */
import { createHash } from "node:crypto";
import { statfsSync, statSync } from "node:fs";
import { LIMITS, type Config, type Source } from "./config.ts";
import { clock } from "./clock.ts";
import { kubectl, parseEvents, parsePods, parseRevision, parseTop, streamLogs, type Pod, type Target } from "./kube.ts";
import * as datadog from "./datadog.ts";
import { backoff, classify, fixFor, type FailureKind } from "./failures.ts";
import { clean, errorText } from "./redact.ts";
import { type Clean, type Store, type Writer } from "./store.ts";

const sha = (...parts: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();

/** Lines that are problems, how bad, and what groups them: numbers, IDs, quoted values and times do not. */
export function problem(text: string): { fingerprint: string; title: string; severity: "error" | "warn" } | null {
  const severity = /\b(error|fatal|panic|exception|critical|emergency)\b/i.test(text) ? "error" : /\bwarn(ing)?\b/i.test(text) ? "warn" : null;
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

type Reading = { state: "ok" | "capped" | "gap" | "failed"; missed: number | null };

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
export function hysteresis(rule: { over: number; samples: number }, state: Hysteresis, value: number | null): Hysteresis {
  if (value === null) return { over: 0, under: 0, breach: state.breach };
  const over = value > rule.over ? state.over + 1 : 0, under = value > rule.over ? 0 : state.under + 1;
  return { over, under, breach: state.breach ? under < rule.samples : over >= rule.samples };
}

/** What one slice of one source read, before it is committed. Bounded: at most the occurrence limit is kept. */
export class Slice {
  readonly admitted: Array<{ key: string; stream: string; at: number; bucket: string }> = [];
  readonly buckets = new Map<string, { title: string; severity: "error" | "warn" | "info"; inexact: boolean }>();
  readonly baselines: Array<{ key: string; count: number; bucket: string }> = [];
  readonly readings = new Map<string, Reading>();
  /** Gauge samples; null is a sample that could not be measured. */
  readonly metrics: Array<{ name: string; value: number | null; at: number }> = [];
  eligible = 0;
  revision: string | null = null;
  readonly source: Source;
  readonly from: number;
  readonly to: number;
  private readonly saturated: ReadonlyArray<{ from: number; to: number }>;
  constructor(source: Source, from: number, to: number, saturated: ReadonlyArray<{ from: number; to: number }>) {
    this.source = source;
    this.from = from;
    this.to = to;
    this.saturated = saturated;
  }

  private bucket(fingerprint: string, title: string, severity: "error" | "warn" | "info"): string {
    if (this.buckets.has(fingerprint)) return fingerprint;
    const distinct = [...this.buckets.keys()].filter((k) => k !== "overflow").length;
    if (distinct < LIMITS.problemsPerSlice) {
      this.buckets.set(fingerprint, { title, severity, inexact: false });
      return fingerprint;
    }
    if (!this.buckets.has("overflow")) this.buckets.set("overflow", { title: "many other errors", severity: "error", inexact: false });
    return "overflow";
  }

  /** One occurrence. Past the limit it is not admitted, and its problem's count becomes a lower bound. */
  add(key: string, stream: string, at: number, fingerprint: string, title: string, severity: "error" | "warn" | "info") {
    const bucket = this.bucket(fingerprint, title, severity);
    this.eligible++;
    if (this.saturated.some((s) => at >= s.from && at <= s.to)) return;
    if (this.eligible > LIMITS.occurrencesPerSlice) {
      this.buckets.get(bucket)!.inexact = true;
      return;
    }
    this.admitted.push({ key, stream, at, bucket });
  }

  /** A cumulative counter (a Kubernetes event's count): only its increase since the stored baseline counts. */
  counter(key: string, count: number, fingerprint: string, title: string, severity: "error" | "warn" | "info") {
    this.baselines.push({ key, count, bucket: this.bucket(fingerprint, title, severity) });
  }

  get capped() {
    return this.eligible > LIMITS.occurrencesPerSlice;
  }
}

export interface Space {
  freeBytes: number;
  dbBytes: number;
}

export class Collector {
  private readonly nextMono = new Map<string, number>();
  private readonly okMono = new Map<string, number>();
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
    let free = Number.MAX_SAFE_INTEGER, size = 0;
    try {
      const s = statfsSync(this.directory);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {
      // Unknown free space is not a reason to stop.
    }
    for (const suffix of ["", "-wal"]) {
      try {
        size += statSync(this.store.file + suffix).size;
      } catch {
        // Absent.
      }
    }
    return { freeBytes: free, dbBytes: size };
  }

  private due(source: Source): boolean {
    const row = this.store.get<{ next_ms: number | null; failure: string | null }>("SELECT next_ms, failure FROM sources WHERE id = ?", source.id);
    if (!row || row.next_ms === null) return true;
    if (clock.now() >= row.next_ms) return true;
    const mono = this.nextMono.get(source.id);
    if (mono !== undefined && clock.mono() >= mono) return true;
    return row.failure !== null && this.wakeAt !== null && clock.mono() >= this.wakeAt;
  }

  /** One scheduler pass over the work that is due. Passes never overlap. */
  pass(): Promise<void> {
    this.running ??= this.passOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async passOnce() {
    const space = this.space();
    if (space.dbBytes > LIMITS.databaseBudgetBytes) this.store.compact();
    this.store.reclaim(); // what compaction freed goes back to the disk a bounded step per pass
    if (space.freeBytes < LIMITS.freeFloorBytes) {
      this.paused = "disk";
      return;
    }
    this.paused = null;
    const woke = this.wakeAt !== null && clock.mono() >= this.wakeAt;
    for (const source of this.config.sources) {
      if (!this.due(source)) continue;
      try {
        if (source.kind === "kubernetes") await this.kubernetes(source);
        else await this.datadog(source);
      } catch (error) {
        this.fail(source, error);
      }
    }
    if (woke) this.wakeAt = null;
  }

  /** Where the next slice starts, and the gap (older than the catch-up limit) it cannot read. */
  private window(source: Source, overlap: number) {
    const now = clock.now();
    const row = this.store.get<{ checkpoint_ms: number | null }>("SELECT checkpoint_ms FROM sources WHERE id = ?", source.id);
    let start = row?.checkpoint_ms ?? now - source.everyMs;
    let gap: { from: number; to: number } | null = null;
    if (now - start > LIMITS.catchUpMs) {
      gap = { from: start, to: now - LIMITS.catchUpMs };
      start = now - LIMITS.catchUpMs;
    }
    const saturated = this.store
      .all<{ from_ms: number; to_ms: number }>("SELECT from_ms, to_ms FROM saturated WHERE source = ?", source.id)
      .map((s) => ({ from: s.from_ms, to: s.to_ms }));
    return { now, start, gap, overlap, saturated };
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
      const slice = new Slice(source, start - w.overlap, end, w.saturated);
      if (source.readings.includes("logs")) {
        pods = await this.logs(t, source, slice, pods);
        // Logs that cannot be read keep the checkpoint where it is; the present state is still read.
        if (slice.readings.get("logs")!.state === "failed") stuck = true;
      }
      if (end === w.now) await this.present(t, source, slice, pods, w.now);
      this.commit(slice, gap, stuck ? null : end, LIMITS.overlapMs.kubernetes);
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
  private refused(slice: Slice, reading: string, stderr: string) {
    const kind = classify(stderr);
    if (kind !== "permission" && kind !== "config") throw new SourceFailure(kind, stderr);
    slice.readings.set(reading, { state: "failed", missed: null });
  }

  /**
   * One slice of logs. A container's records are kept only if its identity (its current and previous instance) is
   * the same in the pod list after the read as before it; otherwise the read is ambiguous, is discarded, and is a
   * gap. What a read shows was lost (a line counted before and no longer returned: rotation or truncation) or a
   * restarted container with no previous instance to read is a gap too: the count is then a lower bound.
   * Returns the pod list taken after the read.
   */
  private async logs(t: Target, source: Source, slice: Slice, before: ReadonlyArray<Pod>): Promise<Pod[]> {
    const order: Reading["state"][] = ["ok", "gap", "capped", "failed"];
    let state: Reading = { state: before.length > LIMITS.podsPerSource ? "capped" : "ok", missed: null };
    const worse = (s: Reading["state"]) => {
      if (order.indexOf(s) > order.indexOf(state.state)) state = { state: s, missed: null };
    };
    type Record = { key: string; stream: string; at: number; fingerprint: string; title: string; severity: "error" | "warn" };
    const reads: Array<{ uid: string; container: string; identity: string; records: Record[] }> = [];
    for (const pod of before.slice(0, LIMITS.podsPerSource)) {
      for (const container of pod.containers) {
        const records: Record[] = [];
        if (container.restarts > 0 && !container.instances.some((i) => i.previous)) worse("gap");
        for (const instance of container.instances) {
          const stream = sha("k8s", t.context, t.namespace, pod.uid, container.name, instance.id);
          const ordinals = new Map<string, number>();
          const seen = new Set<string>();
          let lastAt = slice.from;
          const read = await streamLogs(t, pod.name, container.name, iso(slice.from), instance.previous, LIMITS.bytesPerPodCall, (stamp, text) => {
            const at = Date.parse(stamp);
            if (!Number.isFinite(at) || at < slice.from) return;
            if (at > slice.to) return false;
            lastAt = at;
            const p = problem(text);
            if (!p) return;
            const digest = sha(text);
            const ordinal = ordinals.get(stamp + digest) ?? 0;
            ordinals.set(stamp + digest, ordinal + 1);
            const key = sha("k8s", t.context, t.namespace, pod.uid, container.name, instance.id, stamp, digest, ordinal);
            seen.add(key);
            records.push({ key, stream, at, ...p });
          });
          if (read.code !== 0) {
            if (instance.previous && /previous terminated container|not found/i.test(read.stderr)) worse("gap");
            else {
              this.refused(slice, "logs", read.stderr);
              worse("failed");
            }
            continue;
          }
          if (read.capped) worse("capped");
          else if (read.cutTail) worse("gap");
          const through = read.capped || read.cutTail ? lastAt : slice.to;
          const stored = this.store.all<{ key: string }>("SELECT key FROM occurrences WHERE stream = ? AND at_ms >= ? AND at_ms <= ?", stream, slice.from, through);
          if (stored.some((r) => !seen.has(r.key))) worse("gap");
        }
        reads.push({ uid: pod.uid, container: container.name, identity: identity(container), records });
      }
    }
    const after = await this.pods(t, source);
    for (const r of reads) {
      const now = after.find((p) => p.uid === r.uid)?.containers.find((c) => c.name === r.container);
      if (!now || identity(now) !== r.identity) {
        worse("gap");
        continue;
      }
      for (const x of r.records) slice.add(x.key, x.stream, x.at, x.fingerprint, x.title, x.severity);
    }
    if (slice.capped && state.state === "ok") state = { state: "capped", missed: slice.eligible - LIMITS.occurrencesPerSlice };
    slice.readings.set("logs", state);
    return after;
  }

  /** What the cluster says now: warning events, the running revision and readiness, memory use against limits. */
  private async present(t: Target, source: Source, slice: Slice, pods: ReadonlyArray<Pod>, now: number) {
    if (source.readings.includes("events")) {
      const r = await kubectl(t, "get", ["events", "-o", "json"]);
      if (r.code !== 0) this.refused(slice, "events", r.stderr);
      else {
        for (const e of parseEvents(r.stdout)) {
          if (e.type !== "Warning") continue;
          const p = problem(`WARN ${e.reason}: ${e.message}`)!;
          slice.counter(sha("k8s-event", t.context, t.namespace, e.uid), e.count, `event:${e.reason}:${p.fingerprint}`, `${clean(e.reason, 200)}: ${p.title.replace(/^WARN [^:]*: /, "")}`, "warn");
        }
        slice.readings.set("events", { state: "ok", missed: null });
      }
    }
    if (source.readings.includes("workloads")) {
      const r = await kubectl(t, "get", ["deployments", "-l", source.selector!, "-o", "json"]);
      if (r.code !== 0) this.refused(slice, "workloads", r.stderr);
      else {
        slice.revision = parseRevision(r.stdout);
        slice.readings.set("workloads", { state: slice.revision ? "ok" : "gap", missed: null });
      }
      slice.metrics.push({ name: NOT_READY, value: pods.filter((p) => !p.ready).length, at: now });
    }
    if (source.readings.includes("usage")) {
      const r = await kubectl(t, "top", ["pod", "-l", source.selector!, "--containers", "--no-headers"]);
      let worst: number | null = null;
      if (r.code !== 0) this.refused(slice, "usage", r.stderr);
      else {
        for (const row of parseTop(r.stdout)) {
          const limit = pods.find((p) => p.name === row.pod)?.containers.find((c) => c.name === row.container)?.memoryLimit;
          if (limit) worst = Math.max(worst ?? 0, (100 * row.memory) / limit);
        }
        slice.readings.set("usage", { state: worst === null ? "gap" : "ok", missed: null });
      }
      slice.metrics.push({ name: MEMORY, value: worst === null ? null : Math.round(worst * 10) / 10, at: now });
    }
  }

  private async datadog(source: Source) {
    const w = this.window(source, LIMITS.overlapMs.datadog);
    let start = w.start;
    let gap = w.gap;
    do {
      const end = Math.min(start + LIMITS.sliceMs, w.now);
      const slice = new Slice(source, start - w.overlap, end, w.saturated);
      try {
        if (source.readings.includes("logs")) {
          await datadog.searchLogs(source, start - w.overlap, end, (log) => {
            const p = problem(/^(error|critical|emergency|alert)$/i.test(log.status) ? `ERROR ${log.message}` : /^warn/i.test(log.status) ? `WARN ${log.message}` : log.message);
            if (p) slice.add(sha("dd", source.baseUrl, source.id, log.id), source.id, log.at, p.fingerprint, p.title.replace(/^(ERROR|WARN) (?=ERROR|WARN)/, ""), p.severity);
          });
          slice.readings.set("logs", { state: slice.capped ? "capped" : "ok", missed: slice.capped ? slice.eligible - LIMITS.occurrencesPerSlice : null });
        }
        if (end === w.now && source.readings.includes("monitors")) {
          for (const m of await datadog.monitors(source)) {
            if (!/^(alert|warn)/i.test(m.state)) continue;
            const severity = /^alert/i.test(m.state) ? "error" : "warn";
            slice.counter(sha("dd-monitor", source.id, m.id, m.state), 1, `monitor:${m.id}:${m.state}`, `Monitor ${clean(m.name, 200)} is ${clean(m.state, 40)}`, severity);
          }
          slice.readings.set("monitors", { state: "ok", missed: null });
        }
        if (end === w.now && source.readings.includes("metrics")) {
          const point = await datadog.metric(source, end - source.everyMs, end);
          if (point) slice.metrics.push({ name: point.name, value: point.value, at: point.at });
          slice.readings.set("metrics", { state: point ? "ok" : "gap", missed: null });
        }
      } catch (error) {
        if (error instanceof datadog.HttpFailure) throw new SourceFailure(classify(error.message, error.status), error.message);
        throw error;
      }
      this.commit(slice, gap, end, LIMITS.overlapMs.datadog);
      gap = null;
      start = end;
    } while (start < w.now);
  }

  /** The slice, in one transaction. */
  private commit(slice: Slice, gap: { from: number; to: number } | null, checkpoint: number | null, overlap: number) {
    const source = slice.source;
    const now = clock.now();
    this.store.tx((w) => {
      const seq = w.event("slice", source.id as Clean, {
        from: slice.from,
        to: slice.to,
        eligible: slice.eligible,
        admitted: slice.admitted.length,
        readings: Object.fromEntries(slice.readings),
      });
      if (gap) {
        w.run("INSERT INTO coverage (seq, source, reading, from_ms, to_ms, state, missed) VALUES (?, ?, 'all', ?, ?, 'gap', NULL)", seq, source.id as Clean, gap.from, gap.to);
        w.event("coverage_gap", source.id as Clean, { from: gap.from, to: gap.to, reason: "older than the 14-day catch-up limit" });
      }
      const counts = new Map<string, number>();
      for (const record of slice.admitted) {
        const inserted = w.run("INSERT OR IGNORE INTO occurrences (key, source, stream, at_ms) VALUES (?, ?, ?, ?)", record.key as Clean, source.id as Clean, record.stream as Clean, record.at).changes;
        if (inserted) counts.set(record.bucket, (counts.get(record.bucket) ?? 0) + 1);
      }
      for (const b of slice.baselines) {
        const before = this.store.get<{ count: number }>("SELECT count FROM baselines WHERE key = ?", b.key)?.count ?? 0;
        if (b.count > before) counts.set(b.bucket, (counts.get(b.bucket) ?? 0) + (b.count - before));
        w.run(
          "INSERT INTO baselines (key, source, count, seen_ms) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = max(count, excluded.count), seen_ms = excluded.seen_ms",
          b.key as Clean, source.id as Clean, b.count, now,
        );
      }
      for (const [bucket, info] of slice.buckets) {
        const added = counts.get(bucket) ?? 0;
        if (added === 0 && !info.inexact) continue;
        incident(w, source, bucket, info.title, info.severity, added, !info.inexact, now, seq);
      }
      if (slice.capped) w.run("INSERT OR REPLACE INTO saturated (source, reading, from_ms, to_ms) VALUES (?, 'logs', ?, ?)", source.id as Clean, slice.from, slice.to);
      for (const [reading, r] of slice.readings) {
        w.run("INSERT INTO coverage (seq, source, reading, from_ms, to_ms, state, missed) VALUES (?, ?, ?, ?, ?, ?, ?)", seq, source.id as Clean, reading as Clean, slice.from, slice.to, r.state as Clean, r.missed);
        w.run(
          `INSERT INTO readings (source, reading, state, at_ms, ok_ms) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (source, reading) DO UPDATE SET state = excluded.state, at_ms = excluded.at_ms, ok_ms = coalesce(excluded.ok_ms, ok_ms)`,
          source.id as Clean, reading as Clean, r.state as Clean, now, r.state === "failed" ? null : now,
        );
        if (r.state !== "failed") this.okMono.set(`${source.id}|${reading}`, clock.mono());
      }
      for (const m of slice.metrics) this.metric(w, source, m, now, seq);
      if (slice.revision) this.deploy(w, source, slice.revision);
      if (checkpoint !== null) {
        const before = this.store.get<{ failure: string | null }>("SELECT failure FROM sources WHERE id = ?", source.id);
        w.run(
          `INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint) VALUES (?, ?, NULL, 0, ?, 0, NULL, ?)
           ON CONFLICT (id) DO UPDATE SET checkpoint_ms = excluded.checkpoint_ms, failure = NULL, streak = 0, next_ms = excluded.next_ms, suspended = 0, fix = NULL`,
          source.id as Clean, checkpoint, now + source.everyMs, endpoint(source) as Clean,
        );
        if (before?.failure) w.event("source_recovered", source.id as Clean, { was: before.failure });
        w.run("DELETE FROM occurrences WHERE source = ? AND at_ms < ?", source.id as Clean, checkpoint - overlap);
        w.run("DELETE FROM saturated WHERE source = ? AND to_ms < ?", source.id as Clean, checkpoint - overlap);
        w.run("DELETE FROM baselines WHERE source = ? AND seen_ms < ?", source.id as Clean, now - LIMITS.catchUpMs);
        w.run(
          "DELETE FROM coverage WHERE source = ? AND state = 'ok' AND id NOT IN (SELECT id FROM coverage WHERE source = ? ORDER BY id DESC LIMIT 200)",
          source.id as Clean, source.id as Clean,
        );
      }
    });
    if (checkpoint !== null) this.nextMono.set(source.id, clock.mono() + source.everyMs);
  }

  /** One gauge sample through its rule's hysteresis; the breach that opens is counted as one occurrence of its problem. */
  private metric(w: Writer, source: Source, m: Slice["metrics"][number], now: number, seq: number) {
    const row = this.store.get<{ value: number; at_ms: number; over: number; under: number; breach: number }>("SELECT * FROM metrics WHERE source = ? AND name = ?", source.id, m.name);
    if (m.value === null && !row) return;
    const rule = METRIC_RULES.find((r) => r.name === m.name);
    const was = { over: row?.over ?? 0, under: row?.under ?? 0, breach: row?.breach === 1 };
    const next = rule ? hysteresis(rule, was, m.value) : { over: 0, under: 0, breach: false };
    if (rule && next.breach && !was.breach) {
      incident(w, source, `metric:${m.name}`, `${m.name} over ${rule.over} for ${rule.samples} samples`, "error", 1, true, now, seq);
      w.event("metric_breach", source.id as Clean, { name: m.name, value: m.value, over: rule.over });
    } else if (was.breach && !next.breach) w.event("metric_clear", source.id as Clean, { name: m.name, value: m.value });
    w.run(
      "INSERT OR REPLACE INTO metrics (source, name, value, at_ms, over, under, breach) VALUES (?, ?, ?, ?, ?, ?, ?)",
      source.id as Clean, m.name as Clean, m.value ?? row!.value, m.value === null ? row!.at_ms : m.at, next.over, next.under, next.breach ? 1 : 0,
    );
  }

  /** A deploy is recorded with its seq when the running revision changes. */
  private deploy(w: Writer, source: Source, revision: string) {
    const last = this.store.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", source.app, source.environment);
    if (last?.revision === revision) return;
    const seq = w.event("deploy", `${source.app}/${source.environment}` as Clean, { revision, previous: last?.revision ?? null, source: source.id });
    w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, ?, ?, ?, ?)", seq, source.app as Clean, source.environment as Clean, revision as Clean, (last?.revision ?? null) as Clean | null);
  }

  /** A failure: the next attempt (and possibly suspension) in one transaction; the checkpoint stays. */
  private fail(source: Source, error: unknown) {
    const kind: FailureKind = error instanceof SourceFailure ? error.kind : classify(String((error as Error)?.message ?? error));
    const detail = errorText(error instanceof SourceFailure ? error.detail : error, 400);
    const row = this.store.get<{ streak: number; failure: string | null }>("SELECT streak, failure FROM sources WHERE id = ?", source.id);
    const next = backoff(kind, row?.failure ? row.streak : 0, source.everyMs);
    const now = clock.now();
    this.store.tx((w) => {
      w.event("source_failed", source.id as Clean, { kind, streak: next.streak, suspended: next.suspended, detail });
      w.run(
        `INSERT INTO sources (id, checkpoint_ms, failure, streak, next_ms, suspended, fix, endpoint) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET failure = excluded.failure, streak = excluded.streak, next_ms = excluded.next_ms, suspended = excluded.suspended, fix = excluded.fix`,
        source.id as Clean, kind as Clean, next.streak, now + next.delayMs, next.suspended ? 1 : 0, fixFor(kind, source) as Clean, endpoint(source) as Clean,
      );
    });
    this.nextMono.set(source.id, clock.mono() + next.delayMs);
  }
}

/** Adds to a problem's count, creating it the first time; an inexact addition makes the count a lower bound. */
function incident(w: Writer, source: Source, bucket: string, title: string, severity: string, added: number, exact: boolean, now: number, seq: number) {
  const id = `inc_${sha(source.app, source.environment, source.id, bucket).slice(0, 32)}`;
  w.run(
    `INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET count = count + excluded.count, exact = min(exact, excluded.exact), last_ms = max(last_ms, excluded.last_ms), seq = excluded.seq`,
    id as Clean, source.app as Clean, source.environment as Clean, source.id as Clean, title as Clean, severity as Clean, added, exact ? 1 : 0, now, now, seq,
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

export const endpoint = (s: Source) => (s.kind === "kubernetes" ? `kubernetes:${s.context}` : `datadog:${s.baseUrl}`);
