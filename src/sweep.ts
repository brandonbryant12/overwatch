import { describeBreach, evaluateRule, type MetricRule, type SeriesPoint } from "./detection.ts";
import { formatDuration, iso } from "./duration.ts";
import { withTimeout } from "./exec.ts";
import { applyIncidentAction, planIncidents, type Incident } from "./incidents.ts";
import type { WatcherConfig } from "./options.ts";
import { sourceContext, type Runtime } from "./runtime.ts";
import { dedupe, mergeSignals, pruneSeen, type Sample, type Signal } from "./signals.ts";
import { sourceType } from "./sources/index.ts";
import { keys, loadSeen, loadWatcher, openIncidents, writeRecord, type RunRecord, type WatcherState } from "./store.ts";
import { planWindows } from "./window.ts";

/**
 * Default metric rules, used when an environment sets none. Thresholds are relative to what the cluster
 * reports (the container's own limit, the node's allocatable, the namespace quota), never absolute capacity.
 */
export const DEFAULT_METRIC_RULES: ReadonlyArray<MetricRule> = [
  { metric: "memory_pct_of_limit", operator: "gt", threshold: 90, hysteresis: 2 },
  { metric: "cpu_pct_of_limit", operator: "gt", threshold: 90, hysteresis: 3 },
  { metric: "not_ready_pods", operator: "gt", threshold: 0, hysteresis: 2 },
  { metric: "pending_pods", operator: "gt", threshold: 0, hysteresis: 2 },
  { metric: "unavailable_replicas", operator: "gt", threshold: 0, hysteresis: 3 },
  { metric: "hpa_pct_of_max_replicas", operator: "gte", threshold: 100, hysteresis: 3 },
  { metric: "node_memory_pct_of_allocatable", operator: "gt", threshold: 90, hysteresis: 3 },
  { metric: "quota_*_pct", operator: "gt", threshold: 90, hysteresis: 2 },
];

const SERIES_POINTS = 120;
const SLICE_GRACE_MS = 15_000;

const matches = (pattern: string, metric: string) =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(metric);

export interface InvestigationRequest {
  readonly title: string;
  readonly brief: string;
  readonly app: string;
  readonly environment?: string;
  readonly window: { readonly from: number; readonly to: number };
  readonly coverage: ReadonlyArray<string>;
  readonly revisions?: ReadonlyArray<string>;
  readonly capacity?: string;
  readonly skills: ReadonlyArray<string>;
  readonly fix: boolean;
  readonly trigger:
    | { readonly type: "watcher"; readonly watcherId: string; readonly incidentIds: ReadonlyArray<string> }
    | { readonly type: "manual"; readonly text: string; readonly originSessionID?: string };
}

export interface SweepHooks {
  /** Queues an investigation and returns its ID. */
  readonly investigate?: (request: InvestigationRequest) => Promise<string>;
  readonly notify?: (title: string, body: string) => Promise<void>;
}

function appendSeries(state: WatcherState, source: string, samples: ReadonlyArray<Sample>) {
  const bySource = { ...(state.series[source] ?? {}) };
  for (const sample of samples) {
    const points = [...(bySource[sample.metric] ?? [])];
    if (!points.some((p) => p.at === sample.at)) points.push({ at: sample.at, value: sample.value });
    points.sort((a, b) => a.at - b.at);
    bySource[sample.metric] = points.slice(-SERIES_POINTS);
  }
  return bySource;
}

/** Brief for an investigation of incidents a watcher just opened. */
export function incidentBrief(incidents: ReadonlyArray<Incident>): string {
  return incidents
    .map((i) =>
      [
        `- ${i.title} [${i.source}, ${i.kind}] ${i.count} occurrence(s) from ${iso(i.firstAt)} to ${iso(i.lastAt)}`,
        i.sample ? `  sample: ${i.sample}` : undefined,
        i.query ? `  query: ${i.query}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/**
 * One watcher run: walks each source from its own checkpoint, de-duplicates, evaluates metrics, updates
 * incidents, and queues one investigation for whatever it opened.
 */
export async function runWatcher(runtime: Runtime, watcher: WatcherConfig, hooks: SweepHooks = {}, signal?: AbortSignal): Promise<RunRecord> {
  const started = runtime.now();
  const now = started;
  const { options, kv } = runtime;
  const app = options.apps[watcher.app]!;
  const env = app.environments[watcher.environment]!;
  let state = await loadWatcher(kv, watcher.id);
  const coverage: string[] = [];
  const failed = new Set<string>();
  const fresh: Signal[] = [];
  const revisions: string[] = [];
  const capacity: string[] = [];
  const checkpoints: Record<string, number> = { ...state.checkpoints };
  const series = { ...state.series };
  const seenUpdates: Array<[string, unknown]> = [];
  const sampled = new Set<string>();

  for (const name of watcher.sources) {
    const config = env.sources[name]!;
    const type = sourceType(config.type);
    if (!type) {
      failed.add(name);
      coverage.push(`${name}: unknown source type ${config.type}`);
      continue;
    }
    let seen = await loadSeen(kv, watcher.id, name);
    const plan = planWindows({
      now,
      ...(checkpoints[name] !== undefined ? { checkpoint: checkpoints[name] } : {}),
      ...options.lookback,
    });
    if (plan.truncated) {
      coverage.push(
        `${name}: ${iso(plan.truncated.requestedFrom)} to ${iso(plan.truncated.coveredFrom)} not checked (lookback is capped at ${formatDuration(options.lookback.maxMs)})`,
      );
    }
    const collected: Signal[] = [];
    // Shared by this source's slices, so a long catch-up does not repeat the same calls for every slice.
    const scratch = new Map<string, unknown>();
    for (const [index, window] of plan.windows.entries()) {
      const final = index === plan.windows.length - 1;
      try {
        // The source is told its deadline and reports what it could not read in time. The timeout here is only
        // the backstop for a source that does not come back at all.
        const deadline = Date.now() + options.timeouts.sliceMs;
        const result = await withTimeout(
          options.timeouts.sliceMs + SLICE_GRACE_MS,
          `${name} ${iso(window.from)}`,
          (s) => type.collect(config, { window, final }, sourceContext(runtime, watcher.app, watcher.environment, name, s, { deadline, scratch })),
          signal,
        );
        const deduped = dedupe(result.signals, seen, options.lookback.overlapMs);
        seen = deduped.seen;
        collected.push(...deduped.fresh);
        series[name] = appendSeries({ ...state, series }, name, result.samples);
        for (const sample of result.samples) sampled.add(`${name}:metric:${sample.metric}`);
        for (const note of result.notes) if (!coverage.includes(note)) coverage.push(note);
        if (result.revisions) revisions.push(...result.revisions);
        if (result.capacity) capacity.push(result.capacity);
        checkpoints[name] = window.to;
      } catch (error) {
        failed.add(name);
        const message = error instanceof Error ? error.message : String(error);
        coverage.push(`${name}: not checked from ${iso(window.from)} (${message}); the next run retries from there`);
        break;
      }
    }
    fresh.push(...mergeSignals(collected));
    seenUpdates.push([keys.seen(watcher.id, name), pruneSeen(seen, now - options.lookback.maxMs)]);
  }

  // Metrics: hysteresis over the stored series of each source that answered this run.
  const pending = new Set<string>();
  const rules = env.metrics ?? DEFAULT_METRIC_RULES;
  for (const [source, metrics] of Object.entries(series)) {
    if (!watcher.sources.includes(source) || failed.has(source)) continue;
    for (const [metric, points] of Object.entries(metrics)) {
      const rule = rules.find((r) => matches(r.metric, metric));
      if (!rule) continue;
      const verdict = evaluateRule({ ...rule, metric }, points as SeriesPoint[]);
      const key = `metric:${metric}`;
      // A metric with no new sample this run is unknown, not healthy: its stored series is stale.
      if (!sampled.has(`${source}:${key}`)) {
        pending.add(`${source}:${key}`);
        continue;
      }
      if (verdict.kind === "breach") {
        fresh.push({
          source,
          kind: "metric",
          key,
          title: describeBreach({ ...rule, metric }, verdict),
          severity: "error",
          occurrences: [{ at: verdict.firstBreachAt }],
          total: verdict.consecutive,
          state: true,
          sample: `${metric} = ${verdict.observed} at ${iso(verdict.lastAt)} (limit ${verdict.limit})`,
        });
      } else if (verdict.kind !== "clear") pending.add(`${source}:${key}`);
    }
  }

  const open = await openIncidents(kv, watcher.id);
  const actions = planIncidents({
    watcherId: watcher.id,
    open,
    signals: fresh,
    failedSources: failed,
    pending,
    minCount: watcher.minCount,
    resolveAfter: watcher.resolveAfter,
    now,
  });
  const opened: Incident[] = [];
  const resolved: string[] = [];
  for (const action of actions) {
    const current = action.type === "open" ? action.incident : open.find((i) => i.id === action.id);
    if (!current) continue;
    const next = applyIncidentAction(current, action);
    await writeRecord(kv, keys.incident(next.id), next);
    if (action.type === "open") opened.push(next);
    if (action.type === "resolve") resolved.push(next.id);
  }
  for (const [key, value] of seenUpdates) await writeRecord(kv, key, value);

  let investigationId: string | undefined;
  if (opened.length && watcher.investigate && hooks.investigate) {
    investigationId = await hooks.investigate({
      title: opened.length === 1 ? opened[0]!.title : `${opened.length} new problems`,
      brief: incidentBrief(opened),
      app: watcher.app,
      environment: watcher.environment,
      window: { from: Math.min(...opened.map((i) => i.firstAt)) - 30 * 60_000, to: now },
      coverage,
      revisions: [...new Set(revisions)],
      capacity: capacity.join("\n"),
      skills: watcher.skills,
      fix: watcher.fix,
      trigger: { type: "watcher", watcherId: watcher.id, incidentIds: opened.map((i) => i.id) },
    });
    for (const incident of opened) {
      await writeRecord(kv, keys.incident(incident.id), { ...incident, investigationId });
    }
  } else if (opened.length && hooks.notify) {
    await hooks.notify(`Overwatch: ${watcher.id}`, opened.map((i) => i.title).join("; "));
  }

  const record: RunRecord = {
    at: now,
    durationMs: runtime.now() - started,
    coverage,
    failedSources: [...failed],
    opened: opened.map((i) => i.id),
    resolved,
    ...(investigationId ? { investigationId } : {}),
  };
  state = { lastRunAt: now, checkpoints, series, lastRun: record };
  await writeRecord(kv, keys.watcher(watcher.id), state);
  runtime.log(
    `${watcher.id}: ${opened.length} opened, ${resolved.length} resolved${failed.size ? `, failed: ${[...failed].join(", ")}` : ""}`,
  );
  return record;
}
