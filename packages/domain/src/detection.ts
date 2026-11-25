import { BUDGET_LIMITS } from "./budgets.ts";
import type { ConnectorCoverage, IncidentStatus, Severity } from "./ids.ts";

/**
 * Deterministic detection: the code half of `collect -> detect`.
 *
 * Everything here is a pure function of its arguments. No clock, no I/O, no model call.
 * The server feeds it collected samples and applies the actions it returns as domain commands,
 * so the whole decision can be unit- and property-tested without a daemon.
 */

export interface SeriesPoint {
  readonly tsMs: number;
  readonly value: number;
}

export interface DetectionRule {
  readonly ruleId: string;
  readonly name: string;
  readonly appId: string;
  readonly envId: string;
  readonly metric: string;
  readonly operator: "gt" | "gte" | "ratio_gt";
  readonly threshold: number;
  readonly hysteresisCount: number;
  readonly severity: Severity;
  readonly enabled: boolean;
}

export type RuleVerdict =
  | {
      readonly kind: "breach";
      /** Latest observed value. */
      readonly observed: number;
      /** Typical value before the breach started, when there is enough history to say. */
      readonly baseline?: number;
      /** Absolute value the metric had to cross (for `ratio_gt`: baseline x threshold). */
      readonly limit: number;
      readonly firstBreachTsMs: number;
      readonly lastTsMs: number;
      readonly consecutive: number;
    }
  | {
      readonly kind: "clear";
      readonly observed: number;
      readonly limit: number;
      readonly lastTsMs: number;
      readonly consecutive: number;
    }
  /** Mixed recent samples: neither confirmed bad nor confirmed good. Never acted on. */
  | { readonly kind: "pending"; readonly observed: number; readonly limit: number; readonly lastTsMs: number }
  | { readonly kind: "no_data" };

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, page: 2 };
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
 * A breach needs `hysteresisCount` consecutive trailing samples over the limit, and a clear needs
 * the same number under it, so a single noisy sample neither opens nor closes anything.
 */
export function evaluateRule(rule: DetectionRule, rawSeries: ReadonlyArray<SeriesPoint>): RuleVerdict {
  const series = rawSeries.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.tsMs));
  if (series.length === 0) return { kind: "no_data" };

  const required = Math.max(1, Math.floor(rule.hysteresisCount));
  let limit = rule.threshold;
  let ratioBaseline: number | undefined;

  if (rule.operator === "ratio_gt") {
    // Baseline is the median of the older half of the window, so a regression that is still
    // under way does not immediately redefine "normal".
    const olderHalf = series.slice(0, Math.floor(series.length / 2));
    if (olderHalf.length < RATIO_MIN_BASELINE_POINTS) return { kind: "no_data" };
    ratioBaseline = median(olderHalf.map((p) => p.value));
    if (ratioBaseline === undefined || !(ratioBaseline > 0)) return { kind: "no_data" };
    limit = ratioBaseline * rule.threshold;
  }
  if (!Number.isFinite(limit)) return { kind: "no_data" };

  const exceeds = (value: number) => (rule.operator === "gte" ? value >= limit : value > limit);
  const last = series[series.length - 1]!;
  const lastExceeds = exceeds(last.value);

  let run = 0;
  for (let i = series.length - 1; i >= 0 && exceeds(series[i]!.value) === lastExceeds; i--) run++;

  if (run < required) {
    return { kind: "pending", observed: last.value, limit, lastTsMs: last.tsMs };
  }
  if (!lastExceeds) {
    return { kind: "clear", observed: last.value, limit, lastTsMs: last.tsMs, consecutive: run };
  }

  const runStartIndex = series.length - run;
  const prior = series.slice(Math.max(0, runStartIndex - BASELINE_LOOKBACK_POINTS), runStartIndex);
  const baseline = ratioBaseline ?? (prior.length >= 3 ? median(prior.map((p) => p.value)) : undefined);
  return {
    kind: "breach",
    observed: last.value,
    ...(baseline !== undefined ? { baseline } : {}),
    limit,
    firstBreachTsMs: series[runStartIndex]!.tsMs,
    lastTsMs: last.tsMs,
    consecutive: run,
  };
}

const METRIC_LABELS: Record<string, string> = {
  p95_latency_ms: "p95",
  p50_latency_ms: "p50",
  error_rate_pct: "error rate",
  cpu_pct: "CPU",
  memory_pct: "memory",
  pod_restarts: "pod restarts",
  build_failure: "failed builds",
  rps: "throughput",
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric.replaceAll("_", " ");
}

function trimNumber(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

export function formatMetricValue(metric: string, value: number): string {
  if (metric.endsWith("_ms")) {
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
  }
  if (metric.endsWith("_pct")) return `${trimNumber(value, value < 10 ? 2 : 1)}%`;
  if (metric === "rps") return `${Math.round(value)} rps`;
  return trimNumber(value, 2);
}

/** Stable identity for "this metric is misbehaving in this environment". */
export function fingerprintFor(rule: Pick<DetectionRule, "appId" | "envId" | "metric">): string {
  return `fp:${rule.appId}:${rule.envId}:${rule.metric}`;
}

type BreachVerdict = Extract<RuleVerdict, { kind: "breach" }>;

/**
 * Incident headline that always fits the output budget and always carries the number that matters.
 * Clauses are dropped from least to most important until it fits.
 */
export function composeHeadline(rule: DetectionRule, verdict: BreachVerdict): string {
  const max = BUDGET_LIMITS.incidentHeadlineMaxChars;
  const observed = formatMetricValue(rule.metric, verdict.observed);
  const core = `${metricLabel(rule.metric)} ${observed}`;
  const was =
    verdict.baseline !== undefined ? ` (was ${formatMetricValue(rule.metric, verdict.baseline)})` : "";
  const limit = `, limit ${formatMetricValue(rule.metric, verdict.limit)}`;
  const scope = `${rule.appId} ${rule.envId}`;

  for (const candidate of [`${scope} ${core}${was}${limit}`, `${scope} ${core}${was}`, `${scope} ${core}`]) {
    if (candidate.length <= max) return candidate;
  }
  const room = max - core.length - 2;
  return `${scope.slice(0, Math.max(1, room))}… ${core}`.slice(0, max);
}

/** One-line signal summary for the incident timeline. */
export function composeSignalSummary(rule: DetectionRule, verdict: BreachVerdict): string {
  const observed = formatMetricValue(rule.metric, verdict.observed);
  const limit = formatMetricValue(rule.metric, verdict.limit);
  const was =
    verdict.baseline !== undefined ? `, was ${formatMetricValue(rule.metric, verdict.baseline)}` : "";
  const comparison = rule.operator === "gte" ? "at or over" : "over";
  return `${metricLabel(rule.metric)} ${observed} ${comparison} ${limit} for ${verdict.consecutive} samples${was}`.slice(
    0,
    160,
  );
}

export interface OpenIncidentRef {
  readonly incidentId: string;
  readonly status: IncidentStatus;
  /** Watch rules that already have a signal on this incident. */
  readonly coveredRuleIds: ReadonlyArray<string>;
  readonly fingerprints: ReadonlyArray<string>;
  readonly recoveryCleanWindows: number;
}

export interface RuleEvaluation {
  readonly rule: DetectionRule;
  readonly verdict: RuleVerdict;
}

export interface BreachSignal {
  readonly rule: DetectionRule;
  readonly verdict: BreachVerdict;
}

export type MonitorAction =
  /** Opens one incident for the environment. `correlated` breaches join it as extra signals. */
  | { readonly type: "open_incident"; readonly primary: BreachSignal; readonly correlated: ReadonlyArray<BreachSignal> }
  | { readonly type: "attach_signal"; readonly incidentId: string; readonly signal: BreachSignal }
  | { readonly type: "reset_recovery"; readonly incidentId: string; readonly reason: string }
  | { readonly type: "enter_watching"; readonly incidentId: string; readonly reason: string }
  | { readonly type: "record_clean_window"; readonly incidentId: string };

export interface EnvironmentPlan {
  /** True when coverage is degraded: nothing is judged, good or bad. */
  readonly frozen: boolean;
  readonly actions: ReadonlyArray<MonitorAction>;
}

const isClosed = (status: IncidentStatus) =>
  status === "resolved" || status === "dismissed" || status === "merged";

function covers(incident: OpenIncidentRef, rule: DetectionRule): boolean {
  return (
    incident.coveredRuleIds.includes(rule.ruleId) || incident.fingerprints.includes(fingerprintFor(rule))
  );
}

/**
 * Decides what one sweep of one environment should do.
 *
 * Invariants (checked by property tests):
 * - Degraded coverage produces no actions. Unknown is never treated as healthy or as broken.
 * - A breach already owned by an open incident never opens or attaches again.
 * - At most one incident is opened per sweep. Concurrent breaches correlate into it.
 * - Recovery progress is only recorded when every rule on the incident is confirmed clear.
 */
export function planEnvironment(input: {
  readonly coverage: ConnectorCoverage;
  readonly evaluations: ReadonlyArray<RuleEvaluation>;
  readonly openIncidents: ReadonlyArray<OpenIncidentRef>;
}): EnvironmentPlan {
  if (input.coverage !== "healthy") return { frozen: true, actions: [] };

  const open = input.openIncidents.filter((i) => !isClosed(i.status));
  const actions: MonitorAction[] = [];

  const breaches: BreachSignal[] = input.evaluations
    .filter((e): e is { rule: DetectionRule; verdict: BreachVerdict } => e.verdict.kind === "breach")
    .filter((e) => e.rule.enabled)
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.rule.severity] - SEVERITY_RANK[a.rule.severity] ||
        a.verdict.firstBreachTsMs - b.verdict.firstBreachTsMs ||
        a.rule.ruleId.localeCompare(b.rule.ruleId),
    );

  const unowned: BreachSignal[] = [];
  const resetIncidents = new Set<string>();
  for (const breach of breaches) {
    const owner = open.find((i) => covers(i, breach.rule));
    if (!owner) {
      unowned.push(breach);
      continue;
    }
    if (owner.status === "watching" && owner.recoveryCleanWindows > 0 && !resetIncidents.has(owner.incidentId)) {
      resetIncidents.add(owner.incidentId);
      actions.push({
        type: "reset_recovery",
        incidentId: owner.incidentId,
        reason: `${metricLabel(breach.rule.metric)} is over its limit again`,
      });
    }
  }

  const attachedTo = new Set<string>();
  if (unowned.length > 0) {
    const host = open[0];
    if (host) {
      for (const signal of unowned) {
        actions.push({ type: "attach_signal", incidentId: host.incidentId, signal });
      }
      attachedTo.add(host.incidentId);
    } else {
      const [primary, ...correlated] = unowned;
      actions.push({ type: "open_incident", primary: primary!, correlated });
    }
  }

  for (const incident of open) {
    // A new signal reopens the incident, so it cannot also make recovery progress this sweep.
    if (attachedTo.has(incident.incidentId)) continue;
    const owned = input.evaluations.filter((e) => covers(incident, e.rule));
    // Incidents without a rule to check (for example a promoted insight) are closed by a person.
    if (owned.length === 0) continue;
    if (!owned.every((e) => e.verdict.kind === "clear")) continue;

    if (incident.status === "watching") {
      actions.push({ type: "record_clean_window", incidentId: incident.incidentId });
    } else {
      actions.push({
        type: "enter_watching",
        incidentId: incident.incidentId,
        reason: "All signals are back within their limits; verifying recovery",
      });
    }
  }

  return { frozen: false, actions };
}
