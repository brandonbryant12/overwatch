import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  Action,
  ActionApproved,
  ActionRequested,
  ApproveAction,
  RejectAction,
} from "./aggregates/Action.ts";
import {
  Ask,
  AskAnswered,
  AskOpened,
  OpenAsk,
} from "./aggregates/Ask.ts";
import { Catalog, HostWakeRecorded } from "./aggregates/Catalog.ts";
import { Incident, ResetRecoveryWindow } from "./aggregates/Incident.ts";
import { ResumeRun, Run } from "./aggregates/Run.ts";
import { NotifierExternal, OpenCodeExternal } from "./externals.ts";
import { ActionId, AskId, GLOBAL_VIEW_KEY, omitUndefined } from "./ids.ts";
import { ExecuteAction } from "./sagas.ts";
import { NowView } from "./views.ts";

/**
 * Gates `Propose`-level actions behind an `Ask` in Needs Me, and immediately
 * dispatches `Act`-level actions to `ExecuteAction`.
 */
export class ActionGatePolicy extends Domain.Policy("ActionGatePolicy", {
  from: Action,
  on: [ActionRequested],
}) {}

export const ActionGatePolicyLive = ActionGatePolicy.toLayer(
  Effect.gen(function* () {
    const asks = yield* Ask;
    const executeAction = yield* ExecuteAction;
    return Effect.fn(function* ({ source, event }) {
      const actionId = source.id as ActionId;
      if (event.requiresApproval) {
        const askId = `ask_act_${actionId}` as AskId;
        const label =
          event.kind === "open_draft_pr"
            ? `Open draft PR: ${event.title}`
            : event.kind === "create_github_issue"
              ? `Create GitHub issue: ${event.title}`
              : `Approve ${event.kind}: ${event.title}`;
        yield* asks
          .send(
            askId,
            new OpenAsk(
              omitUndefined({
                kind: "action_approval" as const,
                question: label.slice(0, 140),
                whyItMatters: `Outward ${event.kind} for ${event.appId}/${event.envId} requires operator sign-off.`.slice(
                  0,
                  140,
                ),
                options: [
                  { id: "approve", label: "Approve and execute" },
                  { id: "reject", label: "Reject action" },
                ],
                recommendedOptionId: "approve",
                incidentId: event.incidentId,
                runId: event.runId,
                actionId,
              }),
            ),
          )
          .pipe(Effect.catch(() => Effect.void));
      } else {
        yield* executeAction.start(actionId, {
          kind: event.kind,
          repo: event.repo,
          title: event.title,
          body: event.body,
          branch: event.branch,
          baseBranch: event.baseBranch,
          worktreePath: event.worktreePath,
          incidentId: event.incidentId,
        });
      }
    });
  }),
);

/**
 * Dispatches approved actions to the crash-safe `ExecuteAction` Saga.
 */
export class ActionDispatchPolicy extends Domain.Policy("ActionDispatchPolicy", {
  from: Action,
  on: [ActionApproved],
}) {}

export const ActionDispatchPolicyLive = ActionDispatchPolicy.toLayer(
  Effect.gen(function* () {
    const nowView = yield* NowView;
    const executeAction = yield* ExecuteAction;
    return Effect.fn(function* ({ source }) {
      const actionId = source.id as ActionId;
      const nowOpt = yield* nowView
        .get(GLOBAL_VIEW_KEY)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const now = Option.getOrUndefined(nowOpt);
      const summary = now?.actions[actionId];
      if (!summary) return;
      yield* executeAction.start(actionId, {
        kind: summary.kind,
        repo: summary.repo,
        title: summary.title,
        body: `Executed via Overwatch action ${actionId}.`,
        branch: summary.branch,
        incidentId: summary.incidentId,
      });
    });
  }),
);

/**
 * Routes Ask answers to:
 * - Action approval / rejection (`ApproveAction` / `RejectAction`)
 * - Suspended agent run resumption (`ResumeRun` + `OpenCodeExternal.promptSession`)
 * - OpenCode permission reply when answered in the dashboard (`OpenCodeExternal.replyPermission`)
 */
export class AskResolutionPolicy extends Domain.Policy("AskResolutionPolicy", {
  from: Ask,
  on: [AskAnswered],
}) {}

export const AskResolutionPolicyLive = AskResolutionPolicy.toLayer(
  Effect.gen(function* () {
    const actions = yield* Action;
    const runs = yield* Run;
    const opencode = yield* OpenCodeExternal;
    const needsMe = yield* NowView;

    return Effect.fn(function* ({ source, event }) {
      const askId = source.id as AskId;
      // Inspect metadata carried in pending asks or deterministic action ask id prefix
      const actionIdFromPrefix = askId.startsWith("ask_act_")
        ? (askId.slice("ask_act_".length) as ActionId)
        : undefined;

      if (actionIdFromPrefix) {
        if (event.selectedOptionId === "approve") {
          yield* actions
            .send(actionIdFromPrefix, new ApproveAction({ askId }))
            .pipe(Effect.catch(() => Effect.void));
        } else {
          yield* actions
            .send(
              actionIdFromPrefix,
              new RejectAction({
                askId,
                reason: event.note ?? `Operator selected ${event.selectedOptionId}`,
              }),
            )
            .pipe(Effect.catch(() => Effect.void));
        }
      }

      // Resume any suspended run awaiting this ask
      const nowOpt = yield* needsMe
        .get(GLOBAL_VIEW_KEY)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const now = Option.getOrUndefined(nowOpt);
      if (now) {
        for (const run of Object.values(now.activeRuns)) {
          if (run.status === "awaiting_ask") {
            yield* runs
              .send(
                run.runId,
                new ResumeRun({
                  reason: `Ask ${askId} answered: ${event.selectedOptionId}`,
                }),
              )
              .pipe(Effect.catch(() => Effect.void));
            if (run.sessionId) {
              yield* opencode
                .promptSession({
                  sessionId: run.sessionId,
                  delivery: "queue",
                  text: `Operator answered Ask ${askId}: selected "${event.selectedOptionId}"${event.note ? ` (${event.note})` : ""}.`,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
        }
      }
    });
  }),
);

/**
 * Notifies operator when a blocking Ask opens.
 */
export class AskNotificationPolicy extends Domain.Policy("AskNotificationPolicy", {
  from: Ask,
  on: [AskOpened],
}) {}

export const AskNotificationPolicyLive = AskNotificationPolicy.toLayer(
  Effect.gen(function* () {
    const notifier = yield* NotifierExternal;
    return Effect.fn(function* ({ event }) {
      yield* notifier
        .notifyOperator({
          title: "Overwatch needs your decision",
          subtitle: event.kind,
          body: event.question,
          urgency: event.kind === "action_approval" ? "page" : "warn",
        })
        .pipe(Effect.catch(() => Effect.void));
    });
  }),
);

/**
 * Sleep-native invariant: when the laptop wakes from a sleep gap, reset clean-window
 * counters on any incident currently in `watching` so stale pre-sleep windows never
 * prematurely resolve an incident.
 */
export class WakeRecoveryResetPolicy extends Domain.Policy("WakeRecoveryResetPolicy", {
  from: Catalog,
  on: [HostWakeRecorded],
}) {}

export const WakeRecoveryResetPolicyLive = WakeRecoveryResetPolicy.toLayer(
  Effect.gen(function* () {
    const nowView = yield* NowView;
    const incidents = yield* Incident;
    return Effect.fn(function* ({ event }) {
      const nowOpt = yield* nowView
        .get(GLOBAL_VIEW_KEY)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const now = Option.getOrUndefined(nowOpt);
      if (!now) return;
      for (const inc of Object.values(now.incidents)) {
        if (inc.status === "watching") {
          yield* incidents
            .send(
              inc.incidentId,
              new ResetRecoveryWindow({
                reason: `Host woke after ${Math.round(event.gapMs / 60_000)}m sleep gap (${event.tier})`,
                coverage: "healthy",
              }),
            )
            .pipe(Effect.catch(() => Effect.void));
        }
      }
    });
  }),
);

export const OverwatchPoliciesLive = Layer.mergeAll(
  ActionGatePolicyLive,
  ActionDispatchPolicyLive,
  AskResolutionPolicyLive,
  AskNotificationPolicyLive,
  WakeRecoveryResetPolicyLive,
);
