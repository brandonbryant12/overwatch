import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import {
  Action,
  CompleteAction,
  FailAction,
  StartActionExecution,
} from "./aggregates/Action.ts";
import { Incident, LinkActionToIncident } from "./aggregates/Incident.ts";
import { GitHubExternal, NotifierExternal } from "./externals.ts";
import { ActionId, ActionKind, IncidentId } from "./ids.ts";

/**
 * Crash-safe outward side-effect Saga (`ExecuteAction`):
 * 1. Marks action executing (rejects if approval required and not yet approved).
 * 2. Reconciles via `overwatch-action-id` marker lookup before writing, so a crash
 *    between GitHub write and domain commit adopts the existing artifact with zero duplicates!
 * 3. Creates the Issue / Draft PR or sends the Brief and commits `ActionCompleted`.
 */
export class ExecuteAction extends Domain.Saga(
  "ExecuteAction",
  {
    key: ActionId,
    input: {
      kind: ActionKind,
      repo: Schema.String,
      title: Schema.String,
      body: Schema.String,
      branch: Schema.optional(Schema.String),
      baseBranch: Schema.optional(Schema.String),
      worktreePath: Schema.optional(Schema.String),
      incidentId: Schema.optional(IncidentId),
    },
    result: {
      artifactUrl: Schema.String,
      reconciled: Schema.Boolean,
    },
  },
  {
    description:
      "Crash-safe idempotent dispatch for GitHub Issues, Draft PRs, and team Brief emails.",
  },
) {}

export const ExecuteActionLive = ExecuteAction.toLayer(
  Effect.gen(function* () {
    const actions = yield* Action;
    const incidents = yield* Incident;
    const github = yield* GitHubExternal;
    const notifier = yield* NotifierExternal;

    return Effect.fn(function* ({
      key,
      kind,
      repo,
      title,
      body,
      branch,
      baseBranch,
      worktreePath,
      incidentId,
    }) {
      yield* Activity.make({
        name: "mark-executing",
        execute: actions
          .send(key, new StartActionExecution({}))
          .pipe(Effect.asVoid, Effect.orDie),
      });

      if (kind === "send_brief") {
        const sent = yield* Activity.make({
          name: "send-brief",
          success: Schema.Struct({ messageId: Schema.String }),
          execute: notifier
            .sendBriefEmail({
              briefId: key,
              kind: "daily_digest",
              recipients: ["team@overwatch.local"],
              subject: title,
              markdownBody: body,
            })
            .pipe(Effect.orDie),
        });
        const artifactUrl = `mailto:${sent.messageId}`;
        yield* Activity.make({
          name: "complete-brief-action",
          execute: actions
            .send(
              key,
              new CompleteAction({
                artifactUrl,
                reconciled: false,
              }),
            )
            .pipe(Effect.asVoid, Effect.orDie),
        });
        return { artifactUrl, reconciled: false };
      }

      const ghKind: "create_github_issue" | "open_draft_pr" =
        kind === "create_github_issue" ? "create_github_issue" : "open_draft_pr";

      const existing = yield* Activity.make({
        name: "reconcile-existing",
        success: Schema.Struct({
          found: Schema.Boolean,
          url: Schema.optional(Schema.String),
          number: Schema.optional(Schema.Number),
        }),
        execute: github
          .findExistingArtifact({
            repo,
            actionId: key,
            kind: ghKind,
            branch,
          })
          .pipe(Effect.orDie),
      });

      let artifactUrl: string;
      let artifactNumber: number | undefined;
      let reconciled = false;

      if (existing.found && existing.url) {
        artifactUrl = existing.url;
        artifactNumber = existing.number;
        reconciled = true;
      } else {
        const markedBody = `${body}\n\n<!-- overwatch-action-id: ${key} -->`;
        const created = yield* Activity.make({
          name: "dispatch-github",
          success: Schema.Struct({
            url: Schema.String,
            number: Schema.Number,
          }),
          execute: (
            ghKind === "create_github_issue"
              ? github.createIssue({
                  repo,
                  actionId: key,
                  title,
                  body: markedBody,
                  labels: ["overwatch"],
                })
              : github.pushAndOpenDraftPr({
                  repo,
                  actionId: key,
                  worktreePath: worktreePath ?? ".",
                  branch: branch ?? `overwatch/${key}`,
                  baseBranch: baseBranch ?? "main",
                  title,
                  body: markedBody,
                })
          ).pipe(
            Effect.catchTag("ExternalCallFailed", (err) =>
              actions
                .send(key, new FailAction({ reason: err.reason }))
                .pipe(Effect.orDie, Effect.andThen(Effect.die(err))),
            ),
          ),
        });
        artifactUrl = created.url;
        artifactNumber = created.number;
      }

      yield* Activity.make({
        name: "complete-action",
        execute: actions
          .send(
            key,
            new CompleteAction({
              artifactUrl,
              artifactNumber,
              reconciled,
            }),
          )
          .pipe(Effect.asVoid, Effect.orDie),
      });

      if (incidentId) {
        yield* Activity.make({
          name: "link-incident-action",
          execute: incidents
            .send(incidentId, new LinkActionToIncident({ actionId: key }))
            .pipe(Effect.catch(() => Effect.void)),
        });
      }

      return { artifactUrl, reconciled };
    });
  }),
);
