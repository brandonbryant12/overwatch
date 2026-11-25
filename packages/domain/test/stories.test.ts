import { describe, test } from "bun:test";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import {
  Action,
  ActionApproved,
  ActionCompleted,
  ActionExecutionStarted,
  ActionId,
  ActionRequested,
  AnswerAsk,
  Ask,
  AskAlreadyResolved,
  AskAnswered,
  AskId,
  AskOpened,
  Catalog,
  CleanWindowRecorded,
  EnterWatching,
  EvidenceId,
  GLOBAL_CATALOG_ID,
  GLOBAL_VIEW_KEY,
  GitHubExternal,
  HostWakeRecorded,
  Incident,
  IncidentEnteredMitigating,
  IncidentEnteredWatching,
  IncidentId,
  IncidentOpened,
  IncidentResolved,
  NeedsMeView,
  NotifierExternal,
  OpenAsk,
  OpenCodeExternal,
  OpenIncident,
  OverwatchHandlersLive,
  OverwatchModel,
  PrematureRecovery,
  RecordCleanWindow,
  RecordHostWake,
  RecordVerificationBundle,
  RecoveryWindowReset,
  RequestAction,
  ResolveIncident,
  Run,
  RunId,
  RunStarted,
  StartRun,
  SyncExternalAskResolution,
  UncoveredTelemetry,
  VerificationBundleRecorded,
} from "../src/index.ts";

const story = Story.make(OverwatchModel, {
  layer: OverwatchHandlersLive,
  stub: [OpenCodeExternal, GitHubExternal, NotifierExternal],
});

const runStory = (eff: Effect.Effect<void, unknown, never>) => Effect.runPromise(eff);

describe("Mandatory Concurrent Domain.Story Specifications", () => {
  test("1. Concurrent Tab Ask Race: conflicting tab answers commit exactly once", async () => {
    const ask = Ask.ref("ask-race-1" as AskId);
    await runStory(
      story(
        Story.clock("2026-11-24T12:00:00Z"),
        Story.when(
          ask,
          new OpenAsk({
            kind: "domain_decision",
            question: "Roll back checkout-api to build #481?",
            whyItMatters: "p95 latency jumped 0.9s to 2.1s on #482.",
            options: [
              { id: "rollback", label: "Prepare rollback" },
              { id: "patch", label: "Patch forward" },
            ],
            recommendedOptionId: "patch",
          }),
        ),
        Story.then(
          ask,
          new AskOpened({
            kind: "domain_decision",
            question: "Roll back checkout-api to build #481?",
            whyItMatters: "p95 latency jumped 0.9s to 2.1s on #482.",
            options: [
              { id: "rollback", label: "Prepare rollback" },
              { id: "patch", label: "Patch forward" },
            ],
            recommendedOptionId: "patch",
            openedAtMs: Date.parse("2026-11-24T12:00:00Z"),
          }),
        ),
        Story.call(NotifierExternal.notifyOperator, {
          title: "Overwatch needs your decision",
          subtitle: "domain_decision",
          body: "Roll back checkout-api to build #481?",
          urgency: "warn",
        }),
        Story.succeed(NotifierExternal.notifyOperator, { delivered: true }),
        // Tab A answers first
        Story.when(ask, new AnswerAsk({ selectedOptionId: "patch" })),
        Story.then(
          ask,
          new AskAnswered({
            selectedOptionId: "patch",
            resolvedVia: "dashboard",
            resolvedAtMs: Date.parse("2026-11-24T12:00:00Z"),
          }),
        ),
        Story.replied({ selectedOptionId: "patch", resolvedVia: "dashboard" as const }),
        // Tab B submits a conflicting answer immediately after
        Story.when(ask, new AnswerAsk({ selectedOptionId: "rollback" })),
        Story.rejected(
          new AskAlreadyResolved({
            askId: "ask-race-1" as AskId,
            status: "answered",
            selectedOptionId: "patch",
            resolvedVia: "dashboard",
          }),
        ),
      ),
    );
  });

  test("2. Crash Mid-External Write: ExecuteAction reconciles existing Draft PR with zero duplicates", async () => {
    const actionId = "act-pr-42" as ActionId;
    const action = Action.ref(actionId);
    const ask = Ask.ref(`ask_act_${actionId}` as AskId);

    await runStory(
      story(
        Story.clock("2026-11-24T12:10:00Z"),
        Story.when(
          action,
          new RequestAction({
            kind: "open_draft_pr",
            appId: "checkout-api",
            envId: "prod",
            repo: "brandonbryant12/checkout-api",
            title: "Fix N+1 checkout query plan",
            body: "Adds composite index hint verified locally.",
            branch: "overwatch/inc-42-query-plan",
            baseBranch: "main",
            worktreePath: "/tmp/wt/inc-42",
            evidenceIds: ["ev_trace_42" as EvidenceId],
            autonomy: "propose",
          }),
        ),
        Story.then(
          action,
          new ActionRequested({
            kind: "open_draft_pr",
            appId: "checkout-api",
            envId: "prod",
            repo: "brandonbryant12/checkout-api",
            title: "Fix N+1 checkout query plan",
            body: "Adds composite index hint verified locally.",
            branch: "overwatch/inc-42-query-plan",
            baseBranch: "main",
            worktreePath: "/tmp/wt/inc-42",
            evidenceIds: ["ev_trace_42" as EvidenceId],
            autonomy: "propose",
            requiresApproval: true,
            requestedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
        ),
        Story.then(
          ask,
          new AskOpened({
            kind: "action_approval",
            question: "Open draft PR: Fix N+1 checkout query plan",
            whyItMatters: "Outward open_draft_pr for checkout-api/prod requires operator sign-off.",
            options: [
              { id: "approve", label: "Approve and execute" },
              { id: "reject", label: "Reject action" },
            ],
            recommendedOptionId: "approve",
            actionId,
            openedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
        ),
        Story.call(NotifierExternal.notifyOperator, {
          title: "Overwatch needs your decision",
          subtitle: "action_approval",
          body: "Open draft PR: Fix N+1 checkout query plan",
          urgency: "page",
        }),
        Story.succeed(NotifierExternal.notifyOperator, { delivered: true }),
        // Operator approves in Needs Me
        Story.when(ask, new AnswerAsk({ selectedOptionId: "approve" })),
        Story.then(
          ask,
          new AskAnswered({
            selectedOptionId: "approve",
            resolvedVia: "dashboard",
            resolvedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
        ),
        Story.replied({ selectedOptionId: "approve", resolvedVia: "dashboard" as const }),
        Story.then(
          action,
          new ActionApproved({
            askId: `ask_act_${actionId}` as AskId,
            approvedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
          new ActionExecutionStarted({
            startedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
        ),
        // Simulate restart reconciliation finding an existing PR created before a crash!
        Story.call(GitHubExternal.findExistingArtifact, {
          repo: "brandonbryant12/checkout-api",
          actionId,
          kind: "open_draft_pr",
          branch: "overwatch/inc-42-query-plan",
        }),
        Story.succeed(GitHubExternal.findExistingArtifact, {
          found: true,
          url: "https://github.com/brandonbryant12/checkout-api/pull/918",
          number: 918,
        }),
        // Note: GitHubExternal.pushAndOpenDraftPr is NOT called! Zero duplicate PRs!
        Story.then(
          action,
          new ActionCompleted({
            artifactUrl: "https://github.com/brandonbryant12/checkout-api/pull/918",
            artifactNumber: 918,
            reconciled: true,
            completedAtMs: Date.parse("2026-11-24T12:10:00Z"),
          }),
        ),
      ),
    );
  });

  test("3. OpenCode External Reply Race: TUI approval + dashboard reject converge cleanly", async () => {
    const ask = Ask.ref("ask-perm-9" as AskId);
    await runStory(
      story(
        Story.clock("2026-11-24T12:20:00Z"),
        Story.when(
          ask,
          new OpenAsk({
            kind: "permission",
            question: "Allow git status in worktree?",
            whyItMatters: "Fixer agent requested read-only git inspection.",
            options: [
              { id: "once", label: "Allow once" },
              { id: "reject", label: "Reject" },
            ],
            recommendedOptionId: "once",
            sessionId: "ses_abc123",
            externalRequestId: "perm_req_9",
          }),
        ),
        Story.then(
          ask,
          new AskOpened({
            kind: "permission",
            question: "Allow git status in worktree?",
            whyItMatters: "Fixer agent requested read-only git inspection.",
            options: [
              { id: "once", label: "Allow once" },
              { id: "reject", label: "Reject" },
            ],
            recommendedOptionId: "once",
            sessionId: "ses_abc123",
            externalRequestId: "perm_req_9",
            openedAtMs: Date.parse("2026-11-24T12:20:00Z"),
          }),
        ),
        Story.call(NotifierExternal.notifyOperator, {
          title: "Overwatch needs your decision",
          subtitle: "permission",
          body: "Allow git status in worktree?",
          urgency: "warn",
        }),
        Story.succeed(NotifierExternal.notifyOperator, { delivered: true }),
        // Operator approves directly in OpenCode TUI
        Story.when(ask, new SyncExternalAskResolution({ selectedOptionId: "once" })),
        Story.then(
          ask,
          new AskAnswered({
            selectedOptionId: "once",
            resolvedVia: "opencode_tui",
            resolvedAtMs: Date.parse("2026-11-24T12:20:00Z"),
          }),
        ),
        // Dashboard click arrives milliseconds later with Reject -> cleanly rejected, NeedsMe empty
        Story.when(ask, new AnswerAsk({ selectedOptionId: "reject" })),
        Story.rejected(
          new AskAlreadyResolved({
            askId: "ask-perm-9" as AskId,
            status: "answered",
            selectedOptionId: "once",
            resolvedVia: "opencode_tui",
          }),
        ),
        Story.view(NeedsMeView, GLOBAL_VIEW_KEY, {
          pending: [],
          recent: [
            {
              askId: "ask-perm-9" as AskId,
              kind: "permission",
              status: "answered",
              question: "Allow git status in worktree?",
              whyItMatters: "Fixer agent requested read-only git inspection.",
              options: [
                { id: "once", label: "Allow once" },
                { id: "reject", label: "Reject" },
              ],
              recommendedOptionId: "once",
              sessionId: "ses_abc123",
              selectedOptionId: "once",
              resolvedVia: "opencode_tui",
              openedAtMs: Date.parse("2026-11-24T12:20:00Z"),
              resolvedAtMs: Date.parse("2026-11-24T12:20:00Z"),
            },
          ],
        }),
      ),
    );
  });

  test("4. Premature Recovery Rejection: local tests & unreachable telemetry never resolve incident", async () => {
    const inc = Incident.ref("inc-42" as IncidentId);
    const nowMs = Date.parse("2026-11-24T12:30:00Z");

    await runStory(
      story(
        Story.clock("2026-11-24T12:30:00Z"),
        Story.when(
          inc,
          new OpenIncident({
            appId: "checkout-api",
            envId: "prod",
            headline: "checkout-api prod p95 latency jumped 0.9s -> 2.1s",
            severity: "page",
            signal: {
              signalId: "sig-1",
              watchRuleId: "rule-p95",
              fingerprint: "fp-checkout-p95",
              summary: "p95 latency 2150ms > 1200ms",
              severity: "page",
              evidenceId: "ev_p95_1" as EvidenceId,
              observedAtMs: nowMs,
            },
            recoveryTargetK: 3,
          }),
        ),
        Story.then(
          inc,
          new IncidentOpened({
            appId: "checkout-api",
            envId: "prod",
            headline: "checkout-api prod p95 latency jumped 0.9s -> 2.1s",
            severity: "page",
            signal: {
              signalId: "sig-1",
              watchRuleId: "rule-p95",
              fingerprint: "fp-checkout-p95",
              summary: "p95 latency 2150ms > 1200ms",
              severity: "page",
              evidenceId: "ev_p95_1" as EvidenceId,
              observedAtMs: nowMs,
            },
            tags: {},
            recoveryTargetK: 3,
            openedAtMs: nowMs,
          }),
        ),
        // Fixer passes local tests -> moves to mitigating, NEVER resolved
        Story.when(
          inc,
          new RecordVerificationBundle({
            bundle: {
              runId: "run-fix-1" as RunId,
              reproducedLocally: true,
              commandsRun: ["bun test checkout"],
              exitCodes: [0],
              beforeAfterSummary: "42ms vs 890ms",
              diffStat: "1 file changed, 14 insertions(+)",
              unknowns: [],
            },
          }),
        ),
        Story.then(
          inc,
          new VerificationBundleRecorded({
            bundle: {
              runId: "run-fix-1" as RunId,
              reproducedLocally: true,
              commandsRun: ["bun test checkout"],
              exitCodes: [0],
              beforeAfterSummary: "42ms vs 890ms",
              diffStat: "1 file changed, 14 insertions(+)",
              unknowns: [],
            },
          }),
          new IncidentEnteredMitigating({ reason: "Local verification bundle recorded" }),
        ),
        // Automated resolve attempt must be rejected!
        Story.when(inc, new ResolveIncident({ reason: "PR opened" })),
        Story.rejected(
          new PrematureRecovery({
            incidentId: "inc-42" as IncidentId,
            cleanWindows: 0,
            requiredWindows: 3,
            coverage: "healthy",
            reason:
              "Automated resolution requires K consecutive clean windows on healthy connectors.",
          }),
        ),
        // Enter watching, then attempt clean window while connector is unreachable -> rejected!
        Story.when(inc, new EnterWatching({ reason: "Deploy #483 detected" })),
        Story.then(inc, new IncidentEnteredWatching({ reason: "Deploy #483 detected" })),
        Story.when(
          inc,
          new RecordCleanWindow({ coverage: "unreachable", observedAtMs: nowMs + 60_000 }),
        ),
        Story.rejected(
          new UncoveredTelemetry({
            incidentId: "inc-42" as IncidentId,
            coverage: "unreachable",
          }),
        ),
      ),
    );
  });

  test("5. Overnight Laptop Sleep Mid-Incident: watching resets 2/3 -> 0/3 and active Run survives sleep", async () => {
    const inc = Incident.ref("inc-sleep-1" as IncidentId);
    const run = Run.ref("run-sleep-1" as RunId);
    const cat = Catalog.ref(GLOBAL_CATALOG_ID);
    const startMs = Date.parse("2026-11-24T22:00:00Z");
    const wakeMs = startMs + 10 * 60 * 60 * 1000; // +10h overnight sleep

    await runStory(
      story(
        Story.clock("2026-11-24T22:00:00Z"),
        Story.when(
          inc,
          new OpenIncident({
            appId: "checkout-api",
            envId: "prod",
            headline: "checkout-api prod p95 elevated after deploy",
            severity: "warn",
            signal: {
              signalId: "sig-s1",
              watchRuleId: "rule-p95",
              fingerprint: "fp-sleep-1",
              summary: "p95 1600ms",
              severity: "warn",
              evidenceId: "ev_s1" as EvidenceId,
              observedAtMs: startMs,
            },
            recoveryTargetK: 3,
          }),
        ),
        Story.then(
          inc,
          new IncidentOpened({
            appId: "checkout-api",
            envId: "prod",
            headline: "checkout-api prod p95 elevated after deploy",
            severity: "warn",
            signal: {
              signalId: "sig-s1",
              watchRuleId: "rule-p95",
              fingerprint: "fp-sleep-1",
              summary: "p95 1600ms",
              severity: "warn",
              evidenceId: "ev_s1" as EvidenceId,
              observedAtMs: startMs,
            },
            tags: {},
            recoveryTargetK: 3,
            openedAtMs: startMs,
          }),
        ),
        Story.when(
          run,
          new StartRun({
            role: "investigate",
            trigger: "signal",
            appId: "checkout-api",
            envId: "prod",
            incidentId: "inc-sleep-1" as IncidentId,
            model: "claude-sonnet-4-5",
            budget: {
              maxAwakeMs: 120_000,
              maxConnectorCalls: 12,
              maxTotalToolCalls: 24,
              maxUsd: 0.75,
            },
          }),
        ),
        Story.then(
          run,
          new RunStarted({
            role: "investigate",
            trigger: "signal",
            appId: "checkout-api",
            envId: "prod",
            incidentId: "inc-sleep-1" as IncidentId,
            model: "claude-sonnet-4-5",
            budget: {
              maxAwakeMs: 120_000,
              maxConnectorCalls: 12,
              maxTotalToolCalls: 24,
              maxUsd: 0.75,
            },
            startedAtMs: startMs,
          }),
        ),
        Story.when(inc, new EnterWatching({ reason: "Latency dipped below threshold" })),
        Story.then(inc, new IncidentEnteredWatching({ reason: "Latency dipped below threshold" })),
        Story.when(inc, new RecordCleanWindow({ coverage: "healthy", observedAtMs: startMs + 60_000 })),
        Story.then(
          inc,
          new CleanWindowRecorded({
            cleanWindows: 1,
            requiredWindows: 3,
            observedAtMs: startMs + 60_000,
          }),
        ),
        Story.when(inc, new RecordCleanWindow({ coverage: "healthy", observedAtMs: startMs + 120_000 })),
        Story.then(
          inc,
          new CleanWindowRecorded({
            cleanWindows: 2,
            requiredWindows: 3,
            observedAtMs: startMs + 120_000,
          }),
        ),
        // Clock jumps +10 hours while laptop sleeps!
        Story.advance("10 hours"),
        Story.when(
          cat,
          new RecordHostWake({
            sleptAtMs: startMs,
            wokeAtMs: wakeMs,
            gapMs: wakeMs - startMs,
          }),
        ),
        Story.then(
          cat,
          new HostWakeRecorded({
            sleptAtMs: startMs,
            wokeAtMs: wakeMs,
            gapMs: wakeMs - startMs,
            tier: "overnight",
          }),
        ),
        // WakeRecoveryResetPolicy automatically resets watching counter 2/3 -> 0/3!
        Story.then(
          inc,
          new RecoveryWindowReset({
            reason: "Host woke after 600m sleep gap (overnight)",
            coverage: "healthy",
          }),
        ),
        // Run-1 is still cleanly running (awakeElapsedMs = 0, not falsely timed out!)
        Story.state(run, {
          exists: true,
          role: "investigate",
          trigger: "signal",
          appId: "checkout-api",
          envId: "prod",
          incidentId: "inc-sleep-1" as IncidentId,
          model: "claude-sonnet-4-5",
          status: "running",
          budget: {
            maxAwakeMs: 120_000,
            maxConnectorCalls: 12,
            maxTotalToolCalls: 24,
            maxUsd: 0.75,
          },
          awakeElapsedMs: 0,
          connectorCalls: 0,
          totalToolCalls: 0,
          spentUsd: 0,
          budgetWarningIssued: false,
          startedAtMs: startMs,
        }),
        // Three fresh post-wake clean windows finally resolve the incident
        Story.when(inc, new RecordCleanWindow({ coverage: "healthy", observedAtMs: wakeMs + 20_000 })),
        Story.then(
          inc,
          new CleanWindowRecorded({ cleanWindows: 1, requiredWindows: 3, observedAtMs: wakeMs + 20_000 }),
        ),
        Story.when(inc, new RecordCleanWindow({ coverage: "healthy", observedAtMs: wakeMs + 40_000 })),
        Story.then(
          inc,
          new CleanWindowRecorded({ cleanWindows: 2, requiredWindows: 3, observedAtMs: wakeMs + 40_000 }),
        ),
        Story.when(inc, new RecordCleanWindow({ coverage: "healthy", observedAtMs: wakeMs + 60_000 })),
        Story.then(
          inc,
          new CleanWindowRecorded({ cleanWindows: 3, requiredWindows: 3, observedAtMs: wakeMs + 60_000 }),
          new IncidentResolved({
            resolvedAtMs: wakeMs,
            byOperatorOverride: false,
            reason: "Verified 3/3 consecutive healthy post-anomaly windows",
          }),
        ),
      ),
    );
  });
});
