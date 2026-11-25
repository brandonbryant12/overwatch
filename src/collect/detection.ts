/**
 * Deterministic metric detection with hysteresis. Pure functions of their arguments: no clock, no I/O, no model.
 */
export interface SeriesPoint {
  readonly at: number;
  readonly value: number;
}

export interface MetricRule {
  /** Metric name as a source reports it, such as `memory_pct_of_limit` or a Datadog query name. */
  readonly metric: string;
  readonly operator: "gt" | "gte" | "lt" | "ratio_gt";
  readonly threshold: number;
  /** Consecutive samples needed both to breach and to clear. */
  readonly hysteresis: number;
}

export type Verdict =
  | {
      readonly kind: "breach";
      readonly observed: number;
      readonly baseline?: number;
      /** Value the metric had to cross (for `ratio_gt`: baseline x threshold). */
      readonly limit: number;
      readonly firstBreachAt: number;
      readonly lastAt: number;
      readonly consecutive: number;
    }
  | { readonly kind: "clear"; readonly observed: number; readonly limit: number; readonly lastAt: number }
  /** Mixed recent samples: neither confirmed bad nor confirmed good. Never acted on. */
  | { readonly kind: "pending"; readonly observed: number; readonly limit: number; readonly lastAt: number }
  | { readonly kind: "no_data" };

const BASELINE_LOOKBACK_POINTS = 20;
const RATIO_MIN_BASELINE_POINTS = 5;

export function median(values: ReadonlyArray<number>): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Evaluates one rule against a series ordered oldest to newest.
 *
 * A breach needs `hysteresis` consecutive trailing samples over the limit, and a clear needs the same number
 * under it, so a single noisy sample neither opens nor closes anything.
 */
export function evaluateRule(rule: MetricRule, rawSeries: ReadonlyArray<SeriesPoint>): Verdict {
  const series = rawSeries.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.at));
  if (series.length === 0) return { kind: "no_data" };

  const required = Math.max(1, Math.floor(rule.hysteresis));
  let limit = rule.threshold;
  let ratioBaseline: number | undefined;

  if (rule.operator === "ratio_gt") {
    // The baseline is the median of the older half, so a regression under way does not redefine "normal".
    const olderHalf = series.slice(0, Math.floor(series.length / 2));
    if (olderHalf.length < RATIO_MIN_BASELINE_POINTS) return { kind: "no_data" };
    ratioBaseline = median(olderHalf.map((p) => p.value));
    if (ratioBaseline === undefined || !(ratioBaseline > 0)) return { kind: "no_data" };
    limit = ratioBaseline * rule.threshold;
  }
  if (!Number.isFinite(limit)) return { kind: "no_data" };

  const exceeds = (value: number) =>
    rule.operator === "gte" ? value >= limit : rule.operator === "lt" ? value < limit : value > limit;
  const last = series[series.length - 1]!;
  const lastExceeds = exceeds(last.value);

  let run = 0;
  for (let i = series.length - 1; i >= 0 && exceeds(series[i]!.value) === lastExceeds; i--) run++;

  if (run < required) return { kind: "pending", observed: last.value, limit, lastAt: last.at };
  if (!lastExceeds) return { kind: "clear", observed: last.value, limit, lastAt: last.at };

  const runStart = series.length - run;
  const prior = series.slice(Math.max(0, runStart - BASELINE_LOOKBACK_POINTS), runStart);
  const baseline = ratioBaseline ?? (prior.length >= 3 ? median(prior.map((p) => p.value)) : undefined);
  return {
    kind: "breach",
    observed: last.value,
    ...(baseline !== undefined ? { baseline } : {}),
    limit,
    firstBreachAt: series[runStart]!.at,
    lastAt: last.at,
    consecutive: run,
  };
}

function trim(value: number): string {
  return Number(value.toFixed(Math.abs(value) < 10 ? 2 : 1)).toString();
}

export function describeBreach(rule: MetricRule, verdict: Extract<Verdict, { kind: "breach" }>): string {
  const comparison = rule.operator === "lt" ? "under" : rule.operator === "gte" ? "at or over" : "over";
  const was = verdict.baseline !== undefined ? `, was ${trim(verdict.baseline)}` : "";
  return `${rule.metric} ${trim(verdict.observed)} ${comparison} ${trim(verdict.limit)} for ${verdict.consecutive} samples${was}`;
}

/**
 * Rules used when an environment sets none (`metrics` in its configuration). Thresholds are relative to what the
 * cluster itself reports (limits, desired replicas, autoscaler maximums, quotas), so none is specific to one app.
 * A `*` in a metric name matches any part of it.
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

/** The rule for a metric: the first whose name (with `*` wildcards) matches. */
export function ruleFor(rules: ReadonlyArray<MetricRule>, metric: string): MetricRule | undefined {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(metric);
  const rule = rules.find((r) => matches(r.metric));
  return rule ? { ...rule, metric } : undefined;
}
