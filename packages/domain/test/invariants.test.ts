import { describe, expect, test } from "bun:test";
import * as DateTime from "effect/DateTime";
import * as fc from "fast-check";
import {
  BUDGET_LIMITS,
  validateAskBudget,
  validateHeadline,
  validateInsightBudget,
  validateStakeholderUpdate,
  validateUnderstanding,
} from "../src/budgets.ts";
import {
  Action,
  ApproveAction,
  RequestAction,
  StartActionExecution,
} from "../src/aggregates/Action.ts";
import {
  EnterWatching,
  Incident,
  OpenIncident,
  RecordCleanWindow,
  RecordFinding,
  ResetRecoveryWindow,
  ResolveIncident,
} from "../src/aggregates/Incident.ts";
import type { ActionId, ConnectorCoverage, EvidenceId, IncidentId } from "../src/ids.ts";

const NOW = DateTime.makeUnsafe(1_764_000_000_000);

describe("Property-Based State Machine Invariants (fast-check)", () => {
  test("Incident recovery invariant: automated resolution NEVER occurs without K consecutive healthy clean windows", () => {
    type Step =
      | { kind: "enter_watching" }
      | { kind: "clean"; coverage: ConnectorCoverage }
      | { kind: "sleep_reset" }
      | { kind: "try_resolve" };

    const stepArb: fc.Arbitrary<Step> = fc.oneof(
      fc.constant({ kind: "enter_watching" as const }),
      fc.record({
        kind: fc.constant("clean" as const),
        coverage: fc.constantFrom<ConnectorCoverage>(
          "healthy",
          "auth_expired",
          "unreachable",
          "rate_limited",
        ),
      }),
      fc.constant({ kind: "sleep_reset" as const }),
      fc.constant({ kind: "try_resolve" as const }),
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(stepArb, { minLength: 1, maxLength: 30 }),
        (targetK, steps) => {
          const id = "inc-prop" as IncidentId;
          const opened = Incident.predict(
            Incident.definition.initial,
            new OpenIncident({
              appId: "api",
              envId: "prod",
              headline: "Latency spike",
              severity: "page",
              signal: {
                signalId: "s1",
                watchRuleId: "r1",
                fingerprint: "fp1",
                summary: "p95 > 1s",
                severity: "page",
                evidenceId: "ev_1" as EvidenceId,
                observedAtMs: 1000,
              },
              recoveryTargetK: targetK,
            }),
            { id, now: NOW },
          );
          if (opened._tag !== "Accepted") throw new Error("Expected OpenIncident accepted");
          let state = opened.state;
          let consecutiveHealthyWhileWatching = 0;

          for (let i = 0; i < steps.length; i++) {
            const step = steps[i]!;
            if (state.status === "resolved") break;
            const stepNow = DateTime.makeUnsafe(NOW.epochMilliseconds + (i + 1) * 1000);

            if (step.kind === "enter_watching") {
              const res = Incident.predict(state, new EnterWatching({ reason: "subsided" }), {
                id,
                now: stepNow,
              });
              if (res._tag === "Accepted") {
                if (state.status !== "watching") consecutiveHealthyWhileWatching = 0;
                state = res.state;
              }
            } else if (step.kind === "sleep_reset") {
              const res = Incident.predict(
                state,
                new ResetRecoveryWindow({ reason: "wake", coverage: "healthy" }),
                { id, now: stepNow },
              );
              if (res._tag === "Accepted") {
                consecutiveHealthyWhileWatching = 0;
                state = res.state;
              }
            } else if (step.kind === "clean") {
              const res = Incident.predict(
                state,
                new RecordCleanWindow({ coverage: step.coverage, observedAtMs: 2000 + i * 1000 }),
                { id, now: stepNow },
              );
              if (step.coverage !== "healthy") {
                expect(res._tag).toBe("Rejected");
              } else if (res._tag === "Accepted") {
                if (state.status === "watching") {
                  consecutiveHealthyWhileWatching += 1;
                }
                state = res.state;
                if (state.status === "resolved") {
                  expect(consecutiveHealthyWhileWatching).toBeGreaterThanOrEqual(targetK);
                }
              }
            } else if (step.kind === "try_resolve") {
              const res = Incident.predict(state, new ResolveIncident({ reason: "auto" }), {
                id,
                now: stepNow,
              });
              if (consecutiveHealthyWhileWatching < targetK || state.status !== "watching") {
                expect(res._tag).toBe("Rejected");
              }
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  test("Evidence invariant: every persisted Finding cites >= 1 EvidenceId", () => {
    const id = "inc-ev" as IncidentId;
    const opened = Incident.predict(
      Incident.definition.initial,
      new OpenIncident({
        appId: "api",
        envId: "prod",
        headline: "Error rate elevated",
        severity: "warn",
        signal: {
          signalId: "s1",
          watchRuleId: "r1",
          fingerprint: "fp1",
          summary: "5xx > 2%",
          severity: "warn",
          evidenceId: "ev_1" as EvidenceId,
          observedAtMs: 1000,
        },
      }),
      { id, now: NOW },
    );
    if (opened._tag !== "Accepted") throw new Error("Expected open");

    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 120 }), (summary) => {
        const res = Incident.predict(
          opened.state,
          new RecordFinding({
            findingId: "f1",
            kind: "root_cause",
            summary,
            confidence: 0.9,
            evidenceIds: [],
          }),
          { id, now: NOW },
        );
        expect(res._tag).toBe("Rejected");
      }),
      { numRuns: 50 },
    );
  });

  test("Action approval invariant: Propose actions cannot execute before AskApproved", () => {
    const actionId = "act-prop" as ActionId;
    const req = Action.predict(
      Action.definition.initial,
      new RequestAction({
        kind: "open_draft_pr",
        appId: "api",
        envId: "prod",
        repo: "org/api",
        title: "Fix bug",
        body: "details",
        evidenceIds: ["ev_1" as EvidenceId],
        autonomy: "propose",
      }),
      { id: actionId, now: NOW },
    );
    if (req._tag !== "Accepted") throw new Error("Expected request accepted");

    const beforeApproval = Action.predict(req.state, new StartActionExecution({}), {
      id: actionId,
      now: NOW,
    });
    expect(beforeApproval._tag).toBe("Rejected");

    const approved = Action.predict(
      req.state,
      new ApproveAction({ askId: "ask_act_act-prop" as any }),
      { id: actionId, now: NOW },
    );
    if (approved._tag !== "Accepted") throw new Error("Expected approved");

    const afterApproval = Action.predict(approved.state, new StartActionExecution({}), {
      id: actionId,
      now: NOW,
    });
    expect(afterApproval._tag).toBe("Accepted");
  });

  test("Output budget invariants enforce hard char/word/bullet caps", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 81, maxLength: 160 }), (longHeadline) => {
        expect(validateHeadline(longHeadline)).toBeDefined();
      }),
    );

    expect(
      validateUnderstanding([
        { text: "Bullet 1", evidenceIds: ["ev_1"] },
        { text: "Bullet 2", evidenceIds: ["ev_2"] },
        { text: "Bullet 3", evidenceIds: ["ev_3"] },
        { text: "Bullet 4 exceeds max 3", evidenceIds: ["ev_4"] },
      ]),
    ).toBeDefined();

    expect(
      validateAskBudget({
        question: "Proceed?",
        whyItMatters: "Prod deploy",
        options: [{ id: "only-one" }],
      }),
    ).toBeDefined();

    expect(
      validateInsightBudget({
        claim: "N+1 query detected",
        whyItMatters: "Adds 450ms to checkout",
        evidenceIds: [],
      }),
    ).toBeDefined();

    const seventyWords = Array.from(
      { length: BUDGET_LIMITS.stakeholderMaxWords + 10 },
      () => "word",
    ).join(" ");
    expect(validateStakeholderUpdate(seventyWords)).toBeDefined();
  });
});
