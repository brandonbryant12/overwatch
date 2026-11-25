import * as crypto from "node:crypto";
import { buildDatadogDeepLink, type EnvironmentTelemetrySnapshot, type EvidenceBlob } from "@overwatch/connectors";
import {
  AttachSignal,
  Catalog,
  composeHeadline,
  composeSignalSummary,
  EnterWatching,
  evaluateRule,
  fingerprintFor,
  formatMetricValue,
  GLOBAL_CATALOG_ID,
  GLOBAL_VIEW_KEY,
  Incident,
  IncidentDetailView,
  InsightFeedView,
  metricLabel,
  NowView,
  OpenIncident,
  planEnvironment,
  RecordCleanWindow,
  ResetRecoveryWindow,
  UpdateConnectorCoverage,
  type BreachSignal,
  type DetectionRule,
  type EvidenceId,
  type IncidentId,
  type MonitorAction,
  type OpenIncidentRef,
  type RuleEvaluation,
  type SeriesPoint,
  type Severity,
} from "@overwatch/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CollectionResult } from "./collector.ts";
import { findEnvironmentConfig, type DaemonContext } from "./context.ts";

export interface OperatorNotification {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  readonly urgency: Severity;
}

export interface EnvironmentMonitorStatus {
  readonly envKey: string;
  readonly cadenceSeconds: number;
  readonly lastSweepAtMs?: number;
  readonly nextSweepAtMs?: number;
  /** True while coverage is degraded and nothing is being judged. */
  readonly frozen: boolean;
  readonly rulesEvaluated: number;
  readonly lastOutcome: string;
}

export interface MonitorStatus {
  readonly running: boolean;
  readonly environments: Readonly<Record<string, EnvironmentMonitorStatus>>;
}

export interface SweepOutcome {
  readonly envKey: string;
  readonly collected: boolean;
  readonly frozen: boolean;
  readonly actions: ReadonlyArray<MonitorAction["type"]>;
  readonly openedIncidentId?: string;
  readonly resolvedIncidentIds: ReadonlyArray<string>;
}

export interface MonitorOptions {
  /** Replaces every environment's configured cadence (demo and tests). */
  readonly cadenceOverrideSeconds?: number;
  readonly tickMs?: number;
}

const SERIES_FIELDS: Record<string, keyof EnvironmentTelemetrySnapshot["metrics"][number]> = {
  p50_latency_ms: "p50LatencyMs",
  p95_latency_ms: "p95LatencyMs",
  error_rate_pct: "errorRatePct",
  cpu_pct: "cpuPct",
  memory_pct: "memoryPct",
  rps: "rps",
};

const EVIDENCE_SOURCE: Record<string, EvidenceBlob["source"]> = {
  cpu_pct: "kubernetes",
  memory_pct: "kubernetes",
  pod_restarts: "kubernetes",
  build_failure: "jenkins",
};

/** Builds the series a rule is evaluated against from one collected snapshot. */
export function seriesForRule(
  rule: DetectionRule,
  snapshot: EnvironmentTelemetrySnapshot,
): { readonly series: ReadonlyArray<SeriesPoint>; readonly rule: DetectionRule } {
  const field = SERIES_FIELDS[rule.metric];
  if (field) {
    return { rule, series: snapshot.metrics.map((m) => ({ tsMs: m.tsMs, value: m[field] })) };
  }
  // Point-in-time facts have no history to demand consecutive samples from.
  const instant = { ...rule, hysteresisCount: 1 };
  if (rule.metric === "pod_restarts") {
    if (snapshot.pods.length === 0) return { rule: instant, series: [] };
    const worst = Math.max(...snapshot.pods.map((p) => p.restarts));
    return { rule: instant, series: [{ tsMs: snapshot.sampledAtMs, value: worst }] };
  }
  if (rule.metric === "build_failure") {
    const finished = snapshot.builds.filter((b) => b.result !== "IN_PROGRESS");
    let failures = 0;
    for (const build of [...finished].sort((a, b) => b.timestampMs - a.timestampMs)) {
      if (build.result === "SUCCESS") break;
      failures += 1;
    }
    return finished.length === 0
      ? { rule: instant, series: [] }
      : { rule: instant, series: [{ tsMs: snapshot.sampledAtMs, value: failures }] };
  }
  return { rule, series: [] };
}

/** Same breach, same incident: retries and stale views cannot open a second one. */
export function incidentIdForBreach(envKey: string, signal: BreachSignal): IncidentId {
  const digest = crypto
    .createHash("sha256")
    .update(`${envKey}|${signal.rule.ruleId}|${signal.verdict.firstBreachTsMs}`)
    .digest();
  const code = digest.readUInt32BE(0).toString(36).toUpperCase().padStart(6, "0").slice(-6);
  return `INC-${code}` as IncidentId;
}

/**
 * The autonomous half of Overwatch: on a schedule, collect each environment, evaluate its watch
 * rules, and turn the plan into domain commands. No model is involved anywhere in this file.
 */
export class Monitor {
  private readonly statuses = new Map<string, EnvironmentMonitorStatus>();
  private readonly nextDue = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<SweepOutcome>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly warned = new Set<string>();
  private readonly coverageRecordedAt = new Map<string, number>();

  constructor(
    private readonly ctx: DaemonContext,
    private readonly collect: (envKey: string) => Promise<CollectionResult | undefined>,
    private readonly notify: (notification: OperatorNotification) => Promise<void>,
    private readonly options: MonitorOptions = {},
  ) {}

  private envKeys(): string[] {
    return this.ctx.config.apps.flatMap((app) => Object.keys(app.environments).map((envId) => `${app.id}:${envId}`));
  }

  private baseCadenceSeconds(envKey: string): number {
    const configured = findEnvironmentConfig(this.ctx.config, envKey)?.env.cadenceSeconds ?? 60;
    return Math.max(1, this.options.cadenceOverrideSeconds ?? configured);
  }

  start(): void {
    if (this.timer) return;
    const now = this.ctx.now();
    for (const envKey of this.envKeys()) this.nextDue.set(envKey, now);
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 1_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): MonitorStatus {
    return { running: this.timer !== undefined, environments: Object.fromEntries(this.statuses) };
  }

  /** Sweeps every environment that is due. One stream event covers the whole batch. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    const now = this.ctx.now();
    const due = this.envKeys().filter((envKey) => (this.nextDue.get(envKey) ?? 0) <= now);
    if (due.length === 0) return;
    this.ticking = true;
    try {
      await this.sweepMany(due, "schedule");
      // Schedule from the start of the batch, so environments on the same cadence stay in step
      // and each round produces one stream event instead of one per environment.
      for (const envKey of due) {
        const status = this.statuses.get(envKey);
        if (!status) continue;
        const nextSweepAtMs = now + status.cadenceSeconds * 1000;
        this.nextDue.set(envKey, nextSweepAtMs);
        this.statuses.set(envKey, { ...status, nextSweepAtMs });
      }
    } finally {
      this.ticking = false;
    }
  }

  async sweepAll(reason: string): Promise<SweepOutcome[]> {
    return this.sweepMany(this.envKeys(), reason);
  }

  private async sweepMany(envKeys: ReadonlyArray<string>, reason: string): Promise<SweepOutcome[]> {
    const outcomes: SweepOutcome[] = [];
    for (const envKey of envKeys) outcomes.push(await this.sweep(envKey, { announce: false }));
    const collected = outcomes.filter((o) => o.collected).map((o) => o.envKey);
    if (collected.length > 0) {
      const noun = collected.length === 1 ? "environment" : "environments";
      this.ctx.events.publish("telemetry.collected", `${collected.length} ${noun} (${reason})`);
    }
    return outcomes;
  }

  /** Collect, detect and act for one environment. Concurrent calls share one sweep. */
  sweep(envKey: string, options: { readonly announce?: boolean } = {}): Promise<SweepOutcome> {
    const existing = this.inFlight.get(envKey);
    if (existing) return existing;
    const run = this.runSweep(envKey)
      .catch((error): SweepOutcome => {
        this.recordStatus(envKey, { frozen: false, rulesEvaluated: 0, lastOutcome: `sweep failed: ${String(error)}` });
        return { envKey, collected: false, frozen: false, actions: [], resolvedIncidentIds: [] };
      })
      .then((outcome) => {
        if (options.announce !== false && outcome.collected) {
          this.ctx.events.publish("telemetry.collected", envKey);
        }
        return outcome;
      })
      .finally(() => this.inFlight.delete(envKey));
    this.inFlight.set(envKey, run);
    return run;
  }

  private recordStatus(
    envKey: string,
    update: Pick<EnvironmentMonitorStatus, "frozen" | "rulesEvaluated" | "lastOutcome">,
    urgent = false,
  ): void {
    const now = this.ctx.now();
    const base = this.baseCadenceSeconds(envKey);
    // An open incident or an active rollout halves the wait, down to five seconds.
    const cadenceSeconds = urgent ? Math.max(Math.min(base, 5), Math.round(base / 2)) : base;
    this.nextDue.set(envKey, now + cadenceSeconds * 1000);
    this.statuses.set(envKey, {
      envKey,
      cadenceSeconds,
      lastSweepAtMs: now,
      nextSweepAtMs: this.timer ? now + cadenceSeconds * 1000 : undefined,
      ...update,
    });
  }

  private async runSweep(envKey: string): Promise<SweepOutcome> {
    const { ctx } = this;
    const found = findEnvironmentConfig(ctx.config, envKey);
    const result = await this.collect(envKey);
    if (!found || !result) {
      this.recordStatus(envKey, { frozen: false, rulesEvaluated: 0, lastOutcome: "not collectable" });
      return { envKey, collected: false, frozen: false, actions: [], resolvedIncidentIds: [] };
    }
    const { snapshot } = result;
    const { appId, envId } = found;

    const [nowOpt, feedOpt] = await ctx.runEffect(
      Effect.all([
        Effect.flatMap(NowView, (v) => v.get(GLOBAL_VIEW_KEY)),
        Effect.flatMap(InsightFeedView, (v) => v.get(GLOBAL_VIEW_KEY)),
      ]),
    );
    const now = Option.getOrUndefined(nowOpt);
    const record = now?.environments[envKey];

    // Coverage is an event only when it changes. Samples themselves never enter the event log.
    // A change of state is recorded at once. A change of wording alone (pod counts, error text)
    // is recorded at most every ten minutes, so a flapping message cannot flood the log.
    const stateChanged = record !== undefined && record.coverage !== snapshot.coverage;
    const detailChanged = record !== undefined && record.coverageDetail !== snapshot.coverageDetail;
    const lastDetailAt = this.coverageRecordedAt.get(envKey) ?? 0;
    if (stateChanged || (detailChanged && ctx.now() - lastDetailAt >= 10 * 60_000)) {
      this.coverageRecordedAt.set(envKey, ctx.now());
      await ctx.runEffect(
        Effect.flatMap(Catalog, (catalog) =>
          catalog.send(
            GLOBAL_CATALOG_ID,
            new UpdateConnectorCoverage({
              envKey,
              coverage: snapshot.coverage,
              detail: snapshot.coverageDetail,
            }),
          ),
        ),
      );
      if (stateChanged) ctx.events.publish("coverage.changed", `${envKey}:${snapshot.coverage}`);
    }

    const liveIncidents = Object.values(now?.incidents ?? {}).filter(
      (i) =>
        i.appId === appId &&
        i.envId === envId &&
        i.status !== "resolved" &&
        i.status !== "dismissed" &&
        i.status !== "merged",
    );
    const rolloutActive = (record?.activeRolloutUntilMs ?? 0) > ctx.now();
    const urgent = liveIncidents.length > 0 || rolloutActive;

    if (!result.fresh || snapshot.coverage !== "healthy") {
      const frozen = snapshot.coverage !== "healthy";
      this.recordStatus(
        envKey,
        {
          frozen,
          rulesEvaluated: 0,
          lastOutcome: frozen ? `detectors frozen: coverage ${snapshot.coverage}` : "no new samples",
        },
        urgent,
      );
      return { envKey, collected: true, frozen, actions: [], resolvedIncidentIds: [] };
    }

    const rules: DetectionRule[] = (Option.getOrUndefined(feedOpt)?.watchRules ?? []).filter(
      (r) => r.enabled && r.appId === appId && r.envId === envId,
    );
    const evaluations: RuleEvaluation[] = rules.map((rule) => {
      if (!result.measuredMetrics.has(rule.metric)) return { rule, verdict: { kind: "no_data" as const } };
      const target = seriesForRule(rule, snapshot);
      return { rule, verdict: evaluateRule(target.rule, target.series) };
    });

    const openIncidents: OpenIncidentRef[] = [];
    const recoveryTargets = new Map<string, number>();
    for (const summary of liveIncidents.sort((a, b) => a.openedAtMs - b.openedAtMs)) {
      const detail = Option.getOrUndefined(
        await ctx.runEffect(
          Effect.flatMap(IncidentDetailView, (v) => v.get(Incident.ref(summary.incidentId))),
        ),
      );
      // Read models trail commands by a moment. Planning from an incident whose signals have
      // not arrived yet would attach the same breach twice, so wait for the next sweep instead.
      if (!detail?.exists || detail.signals.length === 0) {
        this.recordStatus(envKey, { frozen: false, rulesEvaluated: 0, lastOutcome: "waiting for views to settle" }, true);
        return { envKey, collected: true, frozen: false, actions: [], resolvedIncidentIds: [] };
      }
      openIncidents.push({
        incidentId: summary.incidentId,
        status: summary.status,
        coveredRuleIds: detail.signals.map((s) => s.watchRuleId),
        fingerprints: detail.signals.map((s) => s.fingerprint),
        recoveryCleanWindows: summary.recoveryCleanWindows,
      });
      recoveryTargets.set(summary.incidentId, summary.recoveryTargetK);
    }

    const plan = planEnvironment({ coverage: snapshot.coverage, evaluations, openIncidents });
    let openedIncidentId: string | undefined;
    const resolvedIncidentIds: string[] = [];

    for (const action of plan.actions) {
      try {
        if (action.type === "open_incident") {
          openedIncidentId = await this.openIncident(envKey, snapshot, action, {
            rolloutId: rolloutActive ? record?.activeRolloutId : undefined,
            commitSha: rolloutActive ? record?.latestCommitSha : undefined,
          });
        } else if (action.type === "attach_signal") {
          await this.attachSignal(action.incidentId as IncidentId, envKey, snapshot, action.signal);
          ctx.events.publish("incident.signal", `${action.incidentId}:${action.signal.rule.ruleId}`);
        } else if (action.type === "reset_recovery") {
          await ctx.runEffect(
            Effect.flatMap(Incident, (inc) =>
              inc.send(
                action.incidentId as IncidentId,
                new ResetRecoveryWindow({ reason: action.reason, coverage: "healthy" }),
              ),
            ),
          );
          ctx.events.publish("incident.relapsed", action.incidentId);
        } else if (action.type === "enter_watching") {
          await ctx.runEffect(
            Effect.flatMap(Incident, (inc) =>
              inc.send(action.incidentId as IncidentId, new EnterWatching({ reason: action.reason })),
            ),
          );
          ctx.events.publish("incident.watching", action.incidentId);
        } else {
          await ctx.runEffect(
            Effect.flatMap(Incident, (inc) =>
              inc.send(
                action.incidentId as IncidentId,
                new RecordCleanWindow({ coverage: "healthy", observedAtMs: snapshot.sampledAtMs }),
                { commandId: `clean:${action.incidentId}:${snapshot.sampledAtMs}` },
              ),
            ),
          );
          const ref = openIncidents.find((i) => i.incidentId === action.incidentId);
          const target = recoveryTargets.get(action.incidentId) ?? Number.POSITIVE_INFINITY;
          if (ref && ref.recoveryCleanWindows + 1 >= target) {
            resolvedIncidentIds.push(action.incidentId);
            ctx.events.publish("incident.resolved", action.incidentId);
            const headline = liveIncidents.find((i) => i.incidentId === action.incidentId)?.headline ?? "";
            await this.notify({
              title: `Recovered: ${appId} ${envId}`,
              subtitle: action.incidentId,
              body: `${target} clean windows in a row. ${headline}`.trim(),
              urgency: "info",
            });
          } else {
            ctx.events.publish("incident.clean_window", action.incidentId);
          }
        }
      } catch (error) {
        // A rejected command (already open, already closed) is a normal race, not a failure.
        const note = `${action.type}:${envKey}:${String(error).slice(0, 80)}`;
        if (!this.warned.has(note)) {
          this.warned.add(note);
          console.warn(`[monitor] ${action.type} for ${envKey} was not applied: ${String(error)}`);
        }
      }
    }

    const breaching = evaluations.filter((e) => e.verdict.kind === "breach").length;
    this.recordStatus(
      envKey,
      {
        frozen: false,
        rulesEvaluated: evaluations.length,
        lastOutcome:
          plan.actions.length > 0
            ? plan.actions.map((a) => a.type).join(", ")
            : breaching > 0
              ? `${breaching} ${breaching === 1 ? "rule" : "rules"} over limit, already on an incident`
              : "within limits",
      },
      urgent || openedIncidentId !== undefined,
    );
    return {
      envKey,
      collected: true,
      frozen: false,
      actions: plan.actions.map((a) => a.type),
      ...(openedIncidentId ? { openedIncidentId } : {}),
      resolvedIncidentIds,
    };
  }

  private recordEvidence(envKey: string, snapshot: EnvironmentTelemetrySnapshot, signal: BreachSignal): EvidenceId {
    const { rule, verdict } = signal;
    const field = SERIES_FIELDS[rule.metric];
    const recent = field
      ? snapshot.metrics
          .slice(-12)
          .map((m) => `${new Date(m.tsMs).toISOString().slice(11, 19)}Z  ${formatMetricValue(rule.metric, m[field])}`)
          .join("\n")
      : `${metricLabel(rule.metric)}: ${formatMetricValue(rule.metric, verdict.observed)}`;
    const datadog = findEnvironmentConfig(this.ctx.config, envKey)?.env.datadog;
    const blob = this.ctx.telemetry.putEvidence({
      evidenceId: `ev_sig_${rule.ruleId}_${verdict.firstBreachTsMs}` as EvidenceId,
      source: EVIDENCE_SOURCE[rule.metric] ?? "datadog",
      envKey,
      title: `${rule.name}: ${composeSignalSummary(rule, verdict)}`,
      query: `${rule.metric} ${rule.operator} ${rule.threshold} for ${rule.hysteresisCount} consecutive samples`,
      deepLink: datadog ? buildDatadogDeepLink(datadog, "apm", "") : "",
      capturedAtMs: verdict.lastTsMs,
      excerpt: `Limit ${formatMetricValue(rule.metric, verdict.limit)}. Most recent samples:\n${recent}`,
    });
    return blob.evidenceId;
  }

  private signalRecord(envKey: string, snapshot: EnvironmentTelemetrySnapshot, signal: BreachSignal) {
    return {
      signalId: `sig_${signal.rule.ruleId}_${signal.verdict.firstBreachTsMs}`,
      watchRuleId: signal.rule.ruleId,
      fingerprint: fingerprintFor(signal.rule),
      summary: composeSignalSummary(signal.rule, signal.verdict),
      severity: signal.rule.severity,
      evidenceId: this.recordEvidence(envKey, snapshot, signal),
      observedAtMs: signal.verdict.lastTsMs,
    };
  }

  private async attachSignal(
    incidentId: IncidentId,
    envKey: string,
    snapshot: EnvironmentTelemetrySnapshot,
    signal: BreachSignal,
  ): Promise<void> {
    await this.ctx.runEffect(
      Effect.flatMap(Incident, (inc) =>
        inc.send(incidentId, new AttachSignal({ signal: this.signalRecord(envKey, snapshot, signal) }), {
          commandId: `detect:${incidentId}:${signal.rule.ruleId}:${signal.verdict.firstBreachTsMs}`,
        }),
      ),
    );
  }

  private async openIncident(
    envKey: string,
    snapshot: EnvironmentTelemetrySnapshot,
    action: Extract<MonitorAction, { type: "open_incident" }>,
    rollout: { readonly rolloutId?: string; readonly commitSha?: string },
  ): Promise<string> {
    const { ctx } = this;
    const found = findEnvironmentConfig(ctx.config, envKey)!;
    const { primary } = action;
    const incidentId = incidentIdForBreach(envKey, primary);
    const headline = composeHeadline(primary.rule, primary.verdict);
    const severity = [primary, ...action.correlated].some((s) => s.rule.severity === "page")
      ? "page"
      : primary.rule.severity;

    await ctx.runEffect(
      Effect.flatMap(Incident, (inc) =>
        inc.send(
          incidentId,
          new OpenIncident({
            appId: found.appId,
            envId: found.envId,
            headline,
            severity,
            signal: this.signalRecord(envKey, snapshot, primary),
            ...(rollout.rolloutId ? { rolloutId: rollout.rolloutId } : {}),
            ...(rollout.commitSha ? { commitSha: rollout.commitSha } : {}),
            tags: { ...found.app.tags, env: found.envId },
            recoveryTargetK: found.env.recoveryCleanWindows ?? 3,
          }),
          { commandId: `detect:${envKey}:${primary.rule.ruleId}:${primary.verdict.firstBreachTsMs}` },
        ),
      ),
    );
    for (const signal of action.correlated) {
      await this.attachSignal(incidentId, envKey, snapshot, signal);
    }

    ctx.events.publish("incident.opened", incidentId);
    if (severity !== "info") {
      await this.notify({
        title: headline,
        subtitle: `${incidentId} · ${severity}`,
        body: composeSignalSummary(primary.rule, primary.verdict),
        urgency: severity,
      });
    }
    return incidentId;
  }
}
