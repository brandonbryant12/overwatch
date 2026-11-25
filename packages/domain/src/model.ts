import * as Domain from "@alchemy.run/domain";
import * as Layer from "effect/Layer";
import { Action } from "./aggregates/Action.ts";
import { Ask } from "./aggregates/Ask.ts";
import { Brief } from "./aggregates/Brief.ts";
import { Catalog } from "./aggregates/Catalog.ts";
import { Incident } from "./aggregates/Incident.ts";
import { Run } from "./aggregates/Run.ts";
import {
  ActionDispatchPolicy,
  ActionGatePolicy,
  AskNotificationPolicy,
  AskResolutionPolicy,
  OverwatchPoliciesLive,
  WakeRecoveryResetPolicy,
} from "./policies.ts";
import { ExecuteAction, ExecuteActionLive } from "./sagas.ts";
import {
  BriefListView,
  IncidentDetailView,
  InsightFeedView,
  NeedsMeView,
  NowView,
  RunListView,
  ScorecardView,
} from "./views.ts";

export class OverwatchModel extends Domain.Model("Overwatch", {
  aggregates: [Incident, Run, Ask, Action, Brief, Catalog],
  views: [
    NowView,
    IncidentDetailView,
    NeedsMeView,
    InsightFeedView,
    RunListView,
    ScorecardView,
    BriefListView,
  ],
  policies: [
    ActionGatePolicy,
    ActionDispatchPolicy,
    AskResolutionPolicy,
    AskNotificationPolicy,
    WakeRecoveryResetPolicy,
  ],
  sagas: [ExecuteAction],
}) {}

export const OverwatchHandlersLive = Layer.mergeAll(OverwatchPoliciesLive, ExecuteActionLive);

/**
 * Operator API published over HTTP + OpenAPI + SSE (`DomainHttp.toHttpApi`).
 */
export class OperatorApi extends Domain.Api("OperatorApi", {
  model: OverwatchModel,
}) {}

/**
 * Scoped Agent API published as MCP tools (`ow_<name>_<op>`, guaranteed <= 64 chars).
 */
export class AgentApi extends Domain.Api("ow", {
  model: OverwatchModel,
  commands: [
    "UpdateUnderstanding",
    "RecordFinding",
    "SplitIncident",
    "RecordVerificationBundle",
    "PostIncidentChat",
    "OpenAsk",
    "RequestAction",
    "RecordInsight",
    "SaveBriefDraft",
    "RecordVerdict",
    "CompleteRun",
  ],
  views: ["NowView", "IncidentDetailView", "NeedsMeView", "InsightFeedView"],
}) {}
