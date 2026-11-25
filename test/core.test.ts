import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { evaluateRule, type MetricRule, type Verdict } from "../src/detection.ts";
import { parseDuration } from "../src/duration.ts";
import { applyIncidentAction, incidentId, planIncidents, type Incident } from "../src/incidents.ts";
import { redactText, redactValue } from "../src/redact.ts";
import { dedupe, fingerprint, normalizeMessage, type Signal } from "../src/signals.ts";
import { planWindows } from "../src/window.ts";

const H = 3_600_000;
const D = 24 * H;
const lookback = { initialMs: 24 * H, maxMs: 14 * D, overlapMs: 2 * 60_000, sliceMs: 6 * H };

describe("durations", () => {
  test("parses common forms and rejects the rest", () => {
    expect(parseDuration("15m")).toBe(15 * 60_000);
    expect(parseDuration("15ms")).toBe(15);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("24h")).toBe(24 * H);
    expect(parseDuration("14d")).toBe(14 * D);
    expect(parseDuration("2 hours")).toBe(2 * H);
    expect(parseDuration("soon")).toBeUndefined();
    expect(parseDuration("-5m")).toBeUndefined();
  });
});

describe("since-last-check windows", () => {
  const now = 1_800_000_000_000;

  test("a brand-new watcher starts the initial lookback back", () => {
    const plan = planWindows({ now, ...lookback });
    expect(plan.windows[0]!.from).toBe(now - 24 * H);
    expect(plan.windows.at(-1)!.to).toBe(now);
    expect(plan.truncated).toBeUndefined();
  });

  test("a returning watcher starts at its checkpoint minus the overlap, not a fixed window", () => {
    const plan = planWindows({ now, checkpoint: now - 37 * 60_000, ...lookback });
    expect(plan.windows).toEqual([{ from: now - 39 * 60_000, to: now }]);
  });

  test("a long gap is walked in slices, oldest first", () => {
    const plan = planWindows({ now, checkpoint: now - 3 * D, ...lookback });
    expect(plan.windows.length).toBe(Math.ceil((3 * D + lookback.overlapMs) / lookback.sliceMs));
    for (let i = 1; i < plan.windows.length; i++) expect(plan.windows[i]!.from).toBe(plan.windows[i - 1]!.to);
  });

  test("the lookback cap truncates coverage and says so", () => {
    const plan = planWindows({ now, checkpoint: now - 20 * D, ...lookback });
    expect(plan.windows[0]!.from).toBe(now - 14 * D);
    expect(plan.truncated).toEqual({ requestedFrom: now - 20 * D - lookback.overlapMs, coveredFrom: now - 14 * D });
  });

  test("property: windows are contiguous, bounded by the slice, and end now", () => {
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 0, max: 30 * D })), fc.integer({ min: 60_000, max: 12 * H }), (back, sliceMs) => {
        const plan = planWindows({ now, ...(back === null ? {} : { checkpoint: now - back }), ...lookback, sliceMs });
        if (plan.windows.length === 0) return back === null ? false : true;
        const ok = plan.windows.every((w, i) => w.to - w.from <= sliceMs && w.to > w.from && (i === 0 || w.from === plan.windows[i - 1]!.to));
        return ok && plan.windows.at(-1)!.to === now && plan.windows[0]!.from >= now - lookback.maxMs;
      }),
    );
  });
});

const rule = (overrides: Partial<MetricRule> = {}): MetricRule => ({ metric: "memory_pct_of_limit", operator: "gt", threshold: 90, hysteresis: 2, ...overrides });
const series = (values: ReadonlyArray<number>) => values.map((value, i) => ({ at: 1_700_000_000_000 + i * 60_000, value }));

describe("metric hysteresis", () => {
  test("one sample over the limit is pending, not a breach", () => {
    expect(evaluateRule(rule(), series([50, 60, 95])).kind).toBe("pending");
  });

  test("hysteresis-many samples over the limit breach, with a baseline", () => {
    const verdict = evaluateRule(rule(), series([50, 52, 54, 95, 97]));
    expect(verdict.kind).toBe("breach");
    if (verdict.kind === "breach") {
      expect(verdict.consecutive).toBe(2);
      expect(verdict.baseline).toBe(52);
      expect(verdict.firstBreachAt).toBe(1_700_000_000_000 + 3 * 60_000);
    }
  });

  test("recovery needs hysteresis-many clean samples too", () => {
    expect(evaluateRule(rule(), series([95, 97, 50])).kind).toBe("pending");
    expect(evaluateRule(rule(), series([95, 97, 50, 40])).kind).toBe("clear");
  });

  test("lt catches drops, gte includes the threshold", () => {
    expect(evaluateRule(rule({ operator: "lt", threshold: 10 }), series([50, 5, 4])).kind).toBe("breach");
    expect(evaluateRule(rule({ operator: "gte" }), series([90, 90])).kind).toBe("breach");
    expect(evaluateRule(rule({ operator: "gt" }), series([90, 90])).kind).toBe("clear");
  });

  test("ratio_gt compares with the older half; too little history is no_data", () => {
    const verdict = evaluateRule(rule({ operator: "ratio_gt", threshold: 1.5 }), series([...Array(12).fill(100), 190, 200]));
    expect(verdict.kind).toBe("breach");
    expect(evaluateRule(rule({ operator: "ratio_gt", threshold: 1.5 }), series([100, 200])).kind).toBe("no_data");
  });

  test("property: breach iff the trailing run over the limit is at least hysteresis long", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 40 }), (hysteresis, values) => {
        const verdict: Verdict = evaluateRule(rule({ hysteresis }), series(values));
        let over = 0;
        for (let i = values.length - 1; i >= 0 && values[i]! > 90; i--) over++;
        let under = 0;
        for (let i = values.length - 1; i >= 0 && values[i]! <= 90; i--) under++;
        if (over >= hysteresis) return verdict.kind === "breach";
        if (under >= hysteresis) return verdict.kind === "clear";
        return verdict.kind === "pending";
      }),
    );
  });
});

const signal = (overrides: Partial<Signal> = {}): Signal => ({
  source: "errors",
  kind: "log",
  key: "log:timeout calling <str>",
  title: "timeout calling payments",
  severity: "error",
  occurrences: [{ at: 1000, id: "a" }],
  total: 1,
  ...overrides,
});

describe("overlap de-duplication", () => {
  test("occurrences re-read in the overlap are not counted twice", () => {
    const first = dedupe([signal({ occurrences: [{ at: 1000, id: "a" }, { at: 2000, id: "b" }], total: 2 })], {}, 500);
    expect(first.fresh[0]!.total).toBe(2);
    const again = dedupe([signal({ occurrences: [{ at: 2000, id: "b" }, { at: 3000, id: "c" }], total: 2 })], first.seen, 500);
    expect(again.fresh[0]!.occurrences.map((o) => o.id)).toEqual(["c"]);
    expect(again.fresh[0]!.total).toBe(1);
  });

  test("a late arrival inside the overlap with a new ID still counts once", () => {
    const first = dedupe([signal({ occurrences: [{ at: 2000, id: "b" }] })], {}, 500);
    const late = dedupe([signal({ occurrences: [{ at: 1800, id: "late" }, { at: 2000, id: "b" }], total: 2 })], first.seen, 500);
    expect(late.fresh[0]!.occurrences.map((o) => o.id)).toEqual(["late"]);
    expect(dedupe([signal({ occurrences: [{ at: 1800, id: "late" }] })], late.seen, 500).fresh).toEqual([]);
  });

  test("state signals are never de-duplicated", () => {
    const state = signal({ state: true, occurrences: [{ at: 1000 }] });
    const first = dedupe([state], {}, 500);
    expect(dedupe([state], first.seen, 500).fresh).toHaveLength(1);
  });

  test("normalized messages group variants of the same error", () => {
    expect(normalizeMessage('2026-11-24T10:00:00Z order 1234 failed: "card declined" id=9f1c2b3a-1111-2222-3333-444455556666')).toBe(
      normalizeMessage('2026-11-25T11:30:12Z order 98 failed: "insufficient funds" id=0e1c2b3a-1111-2222-3333-444455556666'),
    );
  });
});

describe("incidents", () => {
  const base = { watcherId: "shop-api/production", failedSources: new Set<string>(), pending: new Set<string>(), minCount: 1, resolveAfter: 3, now: 5000 };

  test("one breach, one incident: the ID derives from the breach, so retries do not duplicate", () => {
    const actions = planIncidents({ ...base, open: [], signals: [signal(), signal()] });
    expect(actions.filter((a) => a.type === "open")).toHaveLength(1);
    const again = planIncidents({ ...base, open: [], signals: [signal()] });
    expect(again[0]!.type === "open" && again[0]!.incident.id).toBe(incidentId(base.watcherId, fingerprint(signal()), 1000));
  });

  test("a signal owned by an open incident updates it instead of opening another", () => {
    const [open] = planIncidents({ ...base, open: [], signals: [signal()] });
    const incident = (open as { incident: Incident }).incident;
    const actions = planIncidents({ ...base, open: [incident], signals: [signal({ occurrences: [{ at: 4000, id: "z" }] })] });
    expect(actions).toEqual([{ type: "update", id: incident.id, lastAt: 4000, add: 1 }]);
  });

  test("incidents resolve only after resolveAfter clean runs, and freeze when their source failed", () => {
    let [action] = planIncidents({ ...base, open: [], signals: [signal()] });
    let incident = applyIncidentAction(undefined as never, action!);
    for (let run = 1; run <= 3; run++) {
      const frozen = planIncidents({ ...base, open: [incident], signals: [], failedSources: new Set(["errors"]) });
      expect(frozen).toEqual([]);
      [action] = planIncidents({ ...base, open: [incident], signals: [] });
      incident = applyIncidentAction(incident, action!);
      expect(incident.status).toBe(run < 3 ? "open" : "resolved");
    }
  });

  test("pending metrics neither clear nor breach", () => {
    const metric = signal({ source: "pods", kind: "metric", key: "metric:memory_pct_of_limit", state: true });
    const incident = applyIncidentAction(undefined as never, planIncidents({ ...base, open: [], signals: [metric] })[0]!);
    expect(planIncidents({ ...base, open: [incident], signals: [], pending: new Set([incident.fingerprint]) })).toEqual([]);
  });

  test("below minCount opens nothing; state signals ignore minCount", () => {
    expect(planIncidents({ ...base, minCount: 5, open: [], signals: [signal({ total: 4 })] })).toEqual([]);
    expect(planIncidents({ ...base, minCount: 5, open: [], signals: [signal({ total: 1, state: true })] })).toHaveLength(1);
  });

  test("property: with an incident open for a fingerprint, that fingerprint never opens again", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 12 }), (keysSeen) => {
        const open: Incident[] = [];
        for (const [i, key] of keysSeen.entries()) {
          const actions = planIncidents({ ...base, open, signals: [signal({ key, occurrences: [{ at: i * 10, id: String(i) }] })] });
          for (const action of actions) {
            if (action.type !== "open") continue;
            if (open.some((o) => o.fingerprint === action.incident.fingerprint && o.status === "open")) return false;
            open.push(action.incident);
          }
        }
        return true;
      }),
    );
  });
});

describe("redaction", () => {
  test("scrubs bearer tokens, JWTs, AWS keys, GitHub tokens, DSN passwords, API keys and cookies", () => {
    const raw = [
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc1234567890",
      "aws_access_key=AKIAIOSFODNN7EXAMPLE",
      "github=ghp_1234567890abcdefghijklmnop",
      "db=postgres://admin:superSecretPass99@db.internal:5432/shop",
      "DD-API-KEY: abcdef1234567890",
      "Cookie: session=xyz987654",
    ].join("\n");
    const scrubbed = redactText(raw);
    for (const secret of ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "AKIAIOSFODNN7EXAMPLE", "ghp_1234567890abcdefghijklmnop", "superSecretPass99", "abcdef1234567890", "xyz987654"]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(redactValue({ nested: { api_key: "secret-val-123", safe: "hello" } }).nested).toEqual({ api_key: "[REDACTED:sensitive_field]", safe: "hello" });
  });

  test("caps size", () => {
    const bounded = redactText("x".repeat(50_000), { maxBytes: 1024 });
    expect(bounded.length).toBeLessThan(1200);
    expect(bounded).toContain("[TRUNCATED:");
  });
});
