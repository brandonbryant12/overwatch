/** The Overwatch model: every aggregate, view, policy and query, and the Api clients use. */
import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Incident } from "./incident.ts";
import { Deadline, DeadlineLive, Dispatch, DispatchLive, Outcome, OutcomeLive, Triage, triageLive, type TriageOptions } from "./policies.ts";
import { Run } from "./run.ts";
import { Search, SearchLive } from "./search.ts";
import { Thread } from "./thread.ts";
import { Inbox, IncidentPage, PendingRuns, ThreadPage } from "./views.ts";
import { Watcher } from "./watcher.ts";

export class Overwatch extends Domain.Model("Overwatch", {
  aggregates: [Watcher, Incident, Thread, Run],
  views: [Inbox, IncidentPage, ThreadPage, PendingRuns],
  policies: [Triage, Dispatch, Outcome, Deadline],
  queries: [Search],
}) {}

/** Every policy and query implementation. The query needs a `SearchStore`. */
export const handlers = (options: TriageOptions) => Layer.mergeAll(triageLive(options), DispatchLive, OutcomeLive, DeadlineLive, SearchLive);

/**
 * What the page, the command line and agents may call. Everything else (signals, runs, handoffs) is sent by the
 * service itself through the model's own clients.
 */
export class OverwatchApi extends Domain.Api("OverwatchApi", {
  model: Overwatch,
  commands: ["MarkDone", "Defer", "Mute", "Restore", "AskThread"],
  views: ["Inbox", "IncidentPage", "ThreadPage"],
  streams: [],
  queries: ["Search"],
}) {}

/** The Api's version. The plugin and the page check it; bump it when a client would break. */
export const API_VERSION = 2;
