import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { BUDGET_LIMITS } from "../src/budgets.ts";
import {
  composeHeadline,
  composeSignalSummary,
  evaluateRule,
  fingerprintFor,
  formatMetricValue,
  planEnvironment,
  type DetectionRule,
  type OpenIncidentRef,
  type RuleEvaluation,
  type RuleVerdict,
  type SeriesPoint,
} from "../src/detection.ts";
import type { ConnectorCoverage, IncidentStatus } from "../src/ids.ts";

const rule = (overrides: Partial<DetectionRule> = {}): DetectionRule => ({
  ruleId: "rule-p95",
  name: "p95 latency",
  appId: "checkout-api",
  envId: "prod",
  metric: "p95_latency_ms",
  operator: "gt",
  threshold: 1200,
  hysteresisCount: 2,
  severity: "page",
  enabled: true,
  ...overrides,
});

const series = (values: ReadonlyArray<number>): SeriesPoint[] =>
  values.map((value, i) => ({ tsMs: 1_764_000_000_000 + i * 60_000, value }));

const breach = (overrides: Partial<Extract<RuleVerdict, { kind: "breach" }>> = {}) =>
  ({
    kind: "breach" as const,
    observed: 2150,
    baseline: 890,
    limit: 1200,
    firstBreachTsMs: 1_764_000_000_000,
    lastTsMs: 1_764_000_120_000,
    consecutive: 3,
    ...overrides,
  }) satisfies RuleVerdict;

const clear: RuleVerdict = { kind: "clear", observed: 300, limit: 1200, lastTsMs: 1, consecutive: 4 };

describe("evaluateRule", () => {
  test("a single sample over the limit is pending, not a breach", () => {
    expect(evaluateRule(rule(), series([800, 820, 810, 2100])).kind).toBe("pending");
  });

  test("hysteresis-many consecutive samples over the limit is a breach with a baseline", () => {
    const verdict = evaluateRule(rule(), series([880, 890, 900, 885, 2100, 2150]));
    expect(verdict.kind).toBe("breach");
    if (verdict.kind !== "breach") return;
    expect(verdict.observed).toBe(2150);
    expect(verdict.consecutive).toBe(2);
    expect(verdict.baseline).toBe(887.5);
    expect(verdict.firstBreachTsMs).toBe(1_764_000_000_000 + 4 * 60_000);
  });

  test("recovery also needs hysteresis-many consecutive good samples", () => {
    expect(evaluateRule(rule(), series([2100, 2150, 900])).kind).toBe("pending");
    expect(evaluateRule(rule(), series([2100, 2150, 900, 880])).kind).toBe("clear");
  });

  test("gte treats the threshold itself as a breach, gt does not", () => {
    const atLimit = series([85, 85, 85]);
    expect(evaluateRule(rule({ operator: "gte", threshold: 85 }), atLimit).kind).toBe("breach");
    expect(evaluateRule(rule({ operator: "gt", threshold: 85 }), atLimit).kind).toBe("clear");
  });

  test("ratio_gt compares against the older half of the window", () => {
    const steady = Array.from({ length: 12 }, () => 100);
    const verdict = evaluateRule(
      rule({ operator: "ratio_gt", threshold: 1.5 }),
      series([...steady, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 190, 200]),
    );
    expect(verdict.kind).toBe("breach");
    if (verdict.kind === "breach") {
      expect(verdict.baseline).toBe(100);
      expect(verdict.limit).toBe(150);
    }
    expect(evaluateRule(rule({ operator: "ratio_gt", threshold: 1.5 }), series([100, 200, 300])).kind).toBe(
      "no_data",
    );
  });

  test("empty and non-finite input is no_data rather than a guess", () => {
    expect(evaluateRule(rule(), []).kind).toBe("no_data");
    expect(evaluateRule(rule(), [{ tsMs: 1, value: Number.NaN }]).kind).toBe("no_data");
  });

  test("property: breach iff the trailing run over the limit is at least hysteresis long", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 1, maxLength: 40 }),
        (hysteresisCount, values) => {
          const verdict = evaluateRule(rule({ hysteresisCount }), series(values));
          let trailingOver = 0;
          for (let i = values.length - 1; i >= 0 && values[i]! > 1200; i--) trailingOver++;
          let trailingUnder = 0;
          for (let i = values.length - 1; i >= 0 && values[i]! <= 1200; i--) trailingUnder++;

          if (trailingOver >= hysteresisCount) return verdict.kind === "breach";
          if (trailingUnder >= hysteresisCount) return verdict.kind === "clear";
          return verdict.kind === "pending";
        },
      ),
    );
  });
});

describe("headline and summary", () => {
  test("carries the number that matters", () => {
    expect(composeHeadline(rule(), breach())).toBe("checkout-api prod p95 2.15s (was 890ms), limit 1.20s");
    expect(formatMetricValue("error_rate_pct", 1.84)).toBe("1.84%");
    expect(formatMetricValue("memory_pct", 91.26)).toBe("91.3%");
    expect(composeSignalSummary(rule(), breach())).toBe(
      "p95 2.15s over 1.20s for 3 samples, was 890ms",
    );
  });

  test("property: headline always fits the output budget and keeps the observed value", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 120 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.double({ min: 0, max: 1e7, noNaN: true }),
        fc.option(fc.double({ min: 0, max: 1e7, noNaN: true }), { nil: undefined }),
        (appId, envId, observed, baseline) => {
          const r = rule({ appId, envId });
          const headline = composeHeadline(r, breach({ observed, baseline }));
          return (
            headline.length > 0 &&
            headline.length <= BUDGET_LIMITS.incidentHeadlineMaxChars &&
            headline.includes(formatMetricValue(r.metric, observed))
          );
        },
      ),
    );
  });
});

describe("planEnvironment", () => {
  const incident = (overrides: Partial<OpenIncidentRef> = {}): OpenIncidentRef => ({
    incidentId: "INC-1",
    status: "investigating",
    coveredRuleIds: ["rule-p95"],
    fingerprints: [fingerprintFor(rule())],
    recoveryCleanWindows: 0,
    ...overrides,
  });

  test("a new breach opens exactly one incident and correlates concurrent breaches into it", () => {
    const errRule = rule({ ruleId: "rule-5xx", metric: "error_rate_pct", threshold: 1, severity: "warn" });
    const plan = planEnvironment({
      coverage: "healthy",
      evaluations: [
        { rule: errRule, verdict: breach({ observed: 1.8, limit: 1 }) },
        { rule: rule(), verdict: breach() },
      ],
      openIncidents: [],
    });
    expect(plan.actions).toHaveLength(1);
    const action = plan.actions[0]!;
    expect(action.type).toBe("open_incident");
    if (action.type !== "open_incident") return;
    // The page-severity breach leads; the warn-severity one rides along.
    expect(action.primary.rule.ruleId).toBe("rule-p95");
    expect(action.correlated.map((c) => c.rule.ruleId)).toEqual(["rule-5xx"]);
  });

  test("a breach already on an open incident does nothing", () => {
    const plan = planEnvironment({
      coverage: "healthy",
      evaluations: [{ rule: rule(), verdict: breach() }],
      openIncidents: [incident()],
    });
    expect(plan.actions).toEqual([]);
  });

  test("a different rule breaching in the same environment attaches to the open incident", () => {
    const errRule = rule({ ruleId: "rule-5xx", metric: "error_rate_pct", threshold: 1 });
    const plan = planEnvironment({
      coverage: "healthy",
      evaluations: [
        { rule: rule(), verdict: breach() },
        { rule: errRule, verdict: breach({ observed: 1.8, limit: 1 }) },
      ],
      openIncidents: [incident()],
    });
    expect(plan.actions.map((a) => a.type)).toEqual(["attach_signal"]);
  });

  test("a self-healed incident moves to watching, then collects clean windows", () => {
    const evaluations: RuleEvaluation[] = [{ rule: rule(), verdict: clear }];
    expect(
      planEnvironment({ coverage: "healthy", evaluations, openIncidents: [incident()] }).actions.map(
        (a) => a.type,
      ),
    ).toEqual(["enter_watching"]);
    expect(
      planEnvironment({
        coverage: "healthy",
        evaluations,
        openIncidents: [incident({ status: "watching" })],
      }).actions.map((a) => a.type),
    ).toEqual(["record_clean_window"]);
  });

  test("a relapse while watching resets recovery progress once", () => {
    const plan = planEnvironment({
      coverage: "healthy",
      evaluations: [{ rule: rule(), verdict: breach() }],
      openIncidents: [incident({ status: "watching", recoveryCleanWindows: 2 })],
    });
    expect(plan.actions.map((a) => a.type)).toEqual(["reset_recovery"]);
  });

  test("pending samples neither advance nor reset recovery", () => {
    const pending: RuleVerdict = { kind: "pending", observed: 1300, limit: 1200, lastTsMs: 1 };
    const plan = planEnvironment({
      coverage: "healthy",
      evaluations: [{ rule: rule(), verdict: pending }],
      openIncidents: [incident({ status: "watching", recoveryCleanWindows: 1 })],
    });
    expect(plan.actions).toEqual([]);
  });

  const verdictArb: fc.Arbitrary<RuleVerdict> = fc.oneof(
    fc.constant(clear),
    fc.constant<RuleVerdict>({ kind: "no_data" }),
    fc.constant<RuleVerdict>({ kind: "pending", observed: 1300, limit: 1200, lastTsMs: 1 }),
    fc.integer({ min: 1, max: 9 }).map((n) => breach({ firstBreachTsMs: n, consecutive: n })),
  );
  const rulesArb = fc
    .uniqueArray(fc.constantFrom("p95_latency_ms", "error_rate_pct", "cpu_pct", "memory_pct"), {
      minLength: 1,
      maxLength: 4,
    })
    .chain((metrics) =>
      fc.tuple(
        ...metrics.map((metric) =>
          fc.record({
            rule: fc
              .constantFrom<"page" | "warn" | "info">("page", "warn", "info")
              .map((severity) => rule({ ruleId: `rule-${metric}`, metric, severity })),
            verdict: verdictArb,
          }),
        ),
      ),
    );
  const incidentsArb = fc.uniqueArray(
    fc.record({
      incidentId: fc.constantFrom("INC-1", "INC-2"),
      status: fc.constantFrom<IncidentStatus>("investigating", "mitigating", "watching", "resolved", "dismissed"),
      coveredRuleIds: fc.subarray([
        "rule-p95_latency_ms",
        "rule-error_rate_pct",
        "rule-cpu_pct",
        "rule-memory_pct",
      ]),
      fingerprints: fc.constant<ReadonlyArray<string>>([]),
      recoveryCleanWindows: fc.integer({ min: 0, max: 3 }),
    }),
    { maxLength: 2, selector: (i) => i.incidentId },
  );

  test("property: degraded coverage never produces an action", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ConnectorCoverage>("auth_expired", "unreachable", "rate_limited", "unconfigured"),
        rulesArb,
        incidentsArb,
        (coverage, evaluations, openIncidents) => {
          const plan = planEnvironment({ coverage, evaluations, openIncidents });
          return plan.frozen && plan.actions.length === 0;
        },
      ),
    );
  });

  test("property: one incident per sweep, no duplicate signals, recovery only on confirmed clear", () => {
    fc.assert(
      fc.property(rulesArb, incidentsArb, (evaluations, openIncidents) => {
        const plan = planEnvironment({ coverage: "healthy", evaluations, openIncidents });
        const live = openIncidents.filter((i) => i.status !== "resolved" && i.status !== "dismissed");

        const opens = plan.actions.filter((a) => a.type === "open_incident");
        if (opens.length > 1) return false;
        if (opens.length === 1 && live.length > 0) return false;

        for (const action of plan.actions) {
          if (action.type === "attach_signal") {
            if (live.some((i) => i.coveredRuleIds.includes(action.signal.rule.ruleId))) return false;
          }
          if (action.type === "open_incident") {
            const all = [action.primary, ...action.correlated];
            if (new Set(all.map((s) => s.rule.ruleId)).size !== all.length) return false;
          }
          if (action.type === "record_clean_window" || action.type === "enter_watching") {
            const target = live.find((i) => i.incidentId === action.incidentId);
            if (!target) return false;
            const owned = evaluations.filter((e) => target.coveredRuleIds.includes(e.rule.ruleId));
            if (owned.length === 0 || owned.some((e) => e.verdict.kind !== "clear")) return false;
            if (action.type === "record_clean_window" && target.status !== "watching") return false;
          }
        }
        return true;
      }),
    );
  });
});
