/**
 * One run of one watcher: every source is read since its checkpoint, in slices, oldest first. Occurrences already
 * counted are dropped, what is new is reported to the incidents, and only then do the checkpoint, the
 * de-duplication state and the covered windows move, together. A crash between the two repeats the run; the reports
 * carry deterministic command ids, so nothing is counted twice.
 *
 * Only what happened becomes an event: a run that finds nothing writes rows to the coverage table and nothing to the
 * journal. A stretch the lookback cap cut off is a gap, recorded on the Watcher.
 */
import type { DatabaseSync } from "node:sqlite";
import type { WatcherConfig } from "../collect/options.ts";
import { sourceContext, type Runtime } from "../collect/runtime.ts";
import { DEFAULT_METRIC_RULES, describeBreach, evaluateRule, ruleFor, type MetricRule } from "../collect/detection.ts";
import { dedupe, fingerprint, pruneSeen, type Sample, type Seen, type Signal } from "../collect/signals.ts";
import { sourceType } from "../collect/sources/index.ts";
import { planWindows } from "../collect/window.ts";
import { redactText } from "../domain/redact.ts";
import { incidentIdOf, type IncidentId, type Severity } from "../domain/ids.ts";

export interface SignalReport {
  readonly incidentId: IncidentId;
  /** Deterministic, so a repeated run cannot count the same occurrences twice. */
  readonly commandId: string;
  readonly app: string;
  readonly environment: string;
  readonly watcher: string;
  readonly source: string;
  readonly fingerprint: string;
  readonly title: string;
  readonly severity: Severity;
  readonly at: number;
  readonly count: number;
  readonly firstAt?: number;
  readonly sample?: string;
  readonly query?: string;
}

export interface Gap {
  readonly source: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

export interface CollectorPorts {
  readonly runtime: Runtime;
  /** Runs work on the service's connection, under its lock, in one transaction. */
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly read: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly report: (report: SignalReport) => Promise<void>;
  readonly recordGap: (watcher: string, gap: Gap) => Promise<void>;
}

export interface WatcherRunSummary {
  readonly watcher: string;
  readonly startedAt: number;
  readonly reported: number;
  readonly windows: ReadonlyArray<{ readonly source: string; readonly from: number; readonly to: number; readonly status: "ok" | "failed"; readonly note?: string }>;
  readonly gaps: ReadonlyArray<Gap>;
  readonly failed: ReadonlyArray<string>;
}

const SEEN_KEEP_MS = 14 * 86_400_000;

const SERIES_POINTS = 120;

interface MetricBreach {
  readonly metric: string;
  readonly title: string;
  readonly sample: string;
  readonly firstAt: number;
  readonly lastAt: number;
}

/**
 * Evaluates every metric the source has ever reported against its rule: this run's samples are added to the stored
 * series (not events: series are operational state). Returns the breaches, and a function that saves the series and
 * each metric's state in the caller's transaction.
 */
export function evaluateMetrics(
  db: DatabaseSync,
  input: { readonly watcher: string; readonly source: string; readonly samples: ReadonlyArray<Sample>; readonly rules: ReadonlyArray<MetricRule>; readonly now: number },
) {
  const sampled = new Map<string, Sample[]>();
  for (const sample of input.samples) sampled.set(sample.metric, [...(sampled.get(sample.metric) ?? []), sample]);
  const known = db.prepare("SELECT metric FROM metric_state WHERE watcher = ? AND source = ?").all(input.watcher, input.source).map((r) => String(r.metric));
  const states: Array<{ metric: string; state: string; observed: number | null; limit: number | null; sampledAt: number | null }> = [];
  const breaches: MetricBreach[] = [];
  for (const metric of new Set([...known, ...sampled.keys()])) {
    const fresh = sampled.get(metric);
    if (!fresh) {
      states.push({ metric, state: "unknown", observed: null, limit: null, sampledAt: null });
      continue;
    }
    const stored = db.prepare("SELECT at, value FROM series WHERE watcher = ? AND source = ? AND metric = ? ORDER BY at DESC LIMIT ?").all(input.watcher, input.source, metric, SERIES_POINTS) as Array<{ at: number; value: number }>;
    const points = [...stored.reverse(), ...fresh.filter((f) => !stored.some((s) => s.at === f.at)).map((f) => ({ at: f.at, value: f.value }))].sort((a, b) => a.at - b.at).slice(-SERIES_POINTS);
    const rule = ruleFor(input.rules, metric);
    const last = points.at(-1)!;
    if (!rule) {
      states.push({ metric, state: "measured", observed: last.value, limit: null, sampledAt: last.at });
      continue;
    }
    const verdict = evaluateRule(rule, points);
    states.push({
      metric,
      state: verdict.kind,
      observed: verdict.kind === "no_data" ? last.value : verdict.observed,
      limit: verdict.kind === "no_data" ? null : verdict.limit,
      sampledAt: last.at,
    });
    if (verdict.kind === "breach") {
      breaches.push({
        metric,
        title: describeBreach(rule, verdict),
        sample: `${metric} = ${verdict.observed} at ${new Date(verdict.lastAt).toISOString()} (limit ${verdict.limit})`,
        firstAt: verdict.firstBreachAt,
        lastAt: verdict.lastAt,
      });
    }
  }
  const save = (tx: DatabaseSync) => {
    const insert = tx.prepare("INSERT OR IGNORE INTO series (watcher, source, metric, at, value) VALUES (?, ?, ?, ?, ?)");
    for (const sample of input.samples) insert.run(input.watcher, input.source, sample.metric, sample.at, sample.value);
    for (const metric of sampled.keys()) {
      tx.prepare(
        "DELETE FROM series WHERE watcher = ? AND source = ? AND metric = ? AND at < (SELECT min(at) FROM (SELECT at FROM series WHERE watcher = ? AND source = ? AND metric = ? ORDER BY at DESC LIMIT ?))",
      ).run(input.watcher, input.source, metric, input.watcher, input.source, metric, SERIES_POINTS);
    }
    const upsert = tx.prepare(
      "INSERT INTO metric_state (watcher, source, metric, state, observed, limit_value, sampled_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (watcher, source, metric) DO UPDATE SET state = excluded.state, observed = coalesce(excluded.observed, metric_state.observed), limit_value = coalesce(excluded.limit_value, metric_state.limit_value), sampled_at = coalesce(excluded.sampled_at, metric_state.sampled_at), checked_at = excluded.checked_at",
    );
    for (const s of states) upsert.run(input.watcher, input.source, s.metric, s.state, s.observed, s.limit, s.sampledAt, input.now);
  };
  return { breaches, save };
}

/** Sends a watcher's saved reports in order, removing each once the model has it. */
export async function flushReports(ports: CollectorPorts, watcher: string): Promise<void> {
  const rows = await ports.read(
    (db) => db.prepare("SELECT id, kind, payload FROM pending_reports WHERE watcher = ? ORDER BY id").all(watcher) as Array<{ id: number; kind: string; payload: string }>,
  );
  for (const row of rows) {
    if (row.kind === "signal") await ports.report(JSON.parse(row.payload) as SignalReport);
    else await ports.recordGap(watcher, JSON.parse(row.payload) as Gap);
    await ports.atomically((db) => db.prepare("DELETE FROM pending_reports WHERE id = ?").run(row.id));
  }
}

export async function runWatcher(ports: CollectorPorts, watcher: WatcherConfig, signal: AbortSignal = new AbortController().signal): Promise<WatcherRunSummary> {
  const { runtime } = ports;
  const options = runtime.options;
  const now = runtime.now();
  const app = options.apps[watcher.app]!;
  const env = app.environments[watcher.environment]!;
  const windows: Array<WatcherRunSummary["windows"][number]> = [];
  const gaps: Gap[] = [];
  const failed: string[] = [];
  let reported = 0;

  // Reports a previous run saved and did not get to send (it crashed, or the model was busy) go first.
  await flushReports(ports, watcher.id);
  for (const source of watcher.sources) {
    const config = env.sources[source]!;
    const type = sourceType(config.type);
    if (!type) {
      failed.push(source);
      continue;
    }
    const stored = await ports.read(
      (db) => db.prepare("SELECT at, seen FROM checkpoints WHERE watcher = ? AND source = ?").get(watcher.id, source) as { at: number; seen: string } | undefined,
    );
    let seen: Seen = stored ? (JSON.parse(stored.seen) as Seen) : {};
    const plan = planWindows({ now, ...(stored ? { checkpoint: stored.at } : {}), ...options.lookback });
    if (plan.truncated) {
      gaps.push({ source, from: plan.truncated.requestedFrom, to: plan.truncated.coveredFrom, reason: "older than the lookback limit when the watcher caught up" });
    }
    const scratch = new Map<string, unknown>();
    const fresh: Signal[] = [];
    let checkpoint = stored?.at;
    let capacity: string | undefined;
    const samples: Sample[] = [];
    const covered: Array<WatcherRunSummary["windows"][number]> = [];
    for (const [index, window] of plan.windows.entries()) {
      const deadline = Date.now() + options.timeouts.sliceMs;
      try {
        const context = sourceContext(runtime, watcher.app, watcher.environment, source, signal, { deadline, scratch });
        const result = await type.collect(config, { window, final: index === plan.windows.length - 1 }, context);
        // Redacted before anything about them is kept: the de-duplication keys, the report outbox, the events.
        // Redaction is deterministic, so a redacted key still matches itself on the next run.
        const signals = result.signals.map((sig) => ({
          ...sig,
          key: redactText(sig.key, { maxBytes: 400 }),
          title: redactText(sig.title, { maxBytes: 400 }),
          ...(sig.sample === undefined ? {} : { sample: redactText(sig.sample, { maxBytes: 2_000 }) }),
          ...(sig.query === undefined ? {} : { query: redactText(sig.query, { maxBytes: 2_000 }) }),
        }));
        const deduped = dedupe(signals, seen, options.lookback.overlapMs);
        seen = deduped.seen;
        fresh.push(...deduped.fresh);
        if (result.capacity) capacity = redactText(result.capacity, { maxBytes: 2_000 });
        samples.push(...result.samples);
        checkpoint = window.to;
        covered.push({ source, from: window.from, to: window.to, status: "ok", ...(result.notes.length ? { note: redactText(result.notes.join("; "), { maxBytes: 1000 }) } : {}) });
      } catch (error) {
        // The checkpoint stays at the end of the last slice that worked; the next run starts there.
        covered.push({ source, from: window.from, to: window.to, status: "failed", note: redactText((error as Error).message, { maxBytes: 500 }) });
        failed.push(source);
        break;
      }
    }

    // What is new, grouped by fingerprint across slices. Reports are an outbox: they are saved with their command ids
    // in the same transaction as the checkpoint and the de-duplication state, then sent. A crash before the save
    // repeats the whole run; a crash after it sends the same reports again, which their receipts absorb. Either way
    // each occurrence counts once, whatever arrived upstream in between.
    const byFingerprint = new Map<string, Signal[]>();
    for (const s of fresh) byFingerprint.set(fingerprint(s), [...(byFingerprint.get(fingerprint(s)) ?? []), s]);
    const reports: SignalReport[] = [];
    for (const [fp, group] of byFingerprint) {
      const total = group.reduce((sum, s) => sum + s.total, 0);
      const stateSignal = group.some((s) => s.state);
      if (!stateSignal && total < watcher.minCount) continue;
      const newest = Math.max(...group.flatMap((s) => s.occurrences.map((o) => o.at)), stateSignal ? now : 0);
      const first = group[0]!;
      const incidentId = incidentIdOf(watcher.app, watcher.environment, fp);
      reports.push({
        incidentId,
        commandId: `sig_${incidentId}_${source}_${now}`,
        app: watcher.app,
        environment: watcher.environment,
        watcher: watcher.id,
        source,
        fingerprint: fp,
        title: first.title,
        severity: first.severity,
        at: newest,
        count: Math.max(1, total),
        firstAt: Math.min(newest, ...group.flatMap((s) => s.occurrences.map((o) => o.at))),
        ...(first.sample ? { sample: first.sample } : {}),
        ...(first.query ? { query: first.query } : {}),
      });
    }
    // Metrics: this run's samples join the stored series, each rule is evaluated with hysteresis, and a breach is
    // reported like any other signal. A metric this run did not sample is unknown, never healthy.
    const rules = env.metrics ?? DEFAULT_METRIC_RULES;
    const metricsNow = await ports.read((db) => evaluateMetrics(db, { watcher: watcher.id, source, samples, rules, now }));
    for (const breach of metricsNow.breaches) {
      const fp = `${source}:metric:${breach.metric}`;
      const incidentId = incidentIdOf(watcher.app, watcher.environment, fp);
      reports.push({
        incidentId,
        commandId: `sig_${incidentId}_${source}_${now}`,
        app: watcher.app,
        environment: watcher.environment,
        watcher: watcher.id,
        source,
        fingerprint: fp,
        title: breach.title,
        severity: "error",
        at: breach.lastAt,
        count: 1,
        firstAt: breach.firstAt,
        sample: breach.sample,
      });
    }
    const sourceGaps = gaps.filter((g) => g.source === source);
    await ports.atomically((db) => {
      if (checkpoint !== undefined) {
        db.prepare("INSERT INTO checkpoints (watcher, source, at, seen) VALUES (?, ?, ?, ?) ON CONFLICT (watcher, source) DO UPDATE SET at = excluded.at, seen = excluded.seen").run(
          watcher.id,
          source,
          checkpoint,
          JSON.stringify(pruneSeen(seen, now - SEEN_KEEP_MS)),
        );
      }
      if (capacity !== undefined) {
        db.prepare("INSERT INTO capacity (watcher, source, text, at) VALUES (?, ?, ?, ?) ON CONFLICT (watcher, source) DO UPDATE SET text = excluded.text, at = excluded.at").run(watcher.id, source, capacity, now);
      }
      const insert = db.prepare("INSERT INTO coverage (watcher, source, from_at, to_at, status, note, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const w of covered) insert.run(watcher.id, w.source, w.from, w.to, w.status, w.note ?? null, now);
      for (const gap of sourceGaps) insert.run(watcher.id, source, gap.from, gap.to, "gap", gap.reason, now);
      metricsNow.save(db);
      const pending = db.prepare("INSERT OR IGNORE INTO pending_reports (watcher, kind, command_id, payload) VALUES (?, ?, ?, ?)");
      for (const report of reports) pending.run(watcher.id, "signal", report.commandId, JSON.stringify(report));
      for (const gap of sourceGaps) pending.run(watcher.id, "gap", `gap_${watcher.id}_${gap.source}_${gap.from}_${gap.to}`, JSON.stringify(gap));
    });
    reported += reports.length;
    await flushReports(ports, watcher.id);
    windows.push(...covered);
  }
  return { watcher: watcher.id, startedAt: now, reported, windows, gaps, failed };
}
