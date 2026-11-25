import * as Schema from "effect/Schema";
import * as Domain from "@alchemy.run/domain";

export const IncidentId = Schema.String.pipe(Schema.brand("IncidentId"));
export type IncidentId = typeof IncidentId.Type;

export const RunId = Schema.String.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const AskId = Schema.String.pipe(Schema.brand("AskId"));
export type AskId = typeof AskId.Type;

export const ActionId = Schema.String.pipe(Schema.brand("ActionId"));
export type ActionId = typeof ActionId.Type;

export const BriefId = Schema.String.pipe(Schema.brand("BriefId"));
export type BriefId = typeof BriefId.Type;

export const InsightId = Schema.String.pipe(Schema.brand("InsightId"));
export type InsightId = typeof InsightId.Type;

export const EvidenceId = Schema.String.pipe(Schema.brand("EvidenceId"));
export type EvidenceId = typeof EvidenceId.Type;

export const WatchRuleId = Schema.String.pipe(Schema.brand("WatchRuleId"));
export type WatchRuleId = typeof WatchRuleId.Type;

export const CatalogId = Schema.String.pipe(Schema.brand("CatalogId"));
export type CatalogId = typeof CatalogId.Type;

export const ScopeKey = Schema.String;
export type ScopeKey = typeof ScopeKey.Type;

export const GLOBAL_CATALOG_ID = "global" as CatalogId;
export const GLOBAL_VIEW_KEY = "global";

export const Severity = Schema.Literals(["page", "warn", "info"]);
export type Severity = typeof Severity.Type;

export const IncidentStatus = Schema.Literals([
  "investigating",
  "mitigating",
  "watching",
  "resolved",
  "dismissed",
  "merged",
]);
export type IncidentStatus = typeof IncidentStatus.Type;

export const ConnectorCoverage = Schema.Literals([
  "healthy",
  "auth_expired",
  "unreachable",
  "rate_limited",
  "unconfigured",
]);
export type ConnectorCoverage = typeof ConnectorCoverage.Type;

export const AutonomyLevel = Schema.Literals(["act", "propose", "never"]);
export type AutonomyLevel = typeof AutonomyLevel.Type;

export const AgentRole = Schema.Literals([
  "collect",
  "triage",
  "investigate",
  "explore",
  "fix",
  "brief",
  "judge",
  "propose_improvement",
]);
export type AgentRole = typeof AgentRole.Type;

export const RunTrigger = Schema.Literals([
  "signal",
  "intent",
  "schedule",
  "ask_resume",
  "wake_sweep",
]);
export type RunTrigger = typeof RunTrigger.Type;

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "awaiting_ask",
  "completed",
  "budget_exhausted",
  "failed",
  "interrupted",
]);
export type RunStatus = typeof RunStatus.Type;

export const AskKind = Schema.Literals([
  "permission",
  "form",
  "domain_decision",
  "action_approval",
]);
export type AskKind = typeof AskKind.Type;

export const AskStatus = Schema.Literals([
  "pending",
  "answered",
  "superseded_by_chat",
  "expired",
]);
export type AskStatus = typeof AskStatus.Type;

export const ActionKind = Schema.Literals([
  "create_github_issue",
  "push_branch",
  "open_draft_pr",
  "send_brief",
]);
export type ActionKind = typeof ActionKind.Type;

export const ActionStatus = Schema.Literals([
  "requested",
  "awaiting_approval",
  "approved",
  "executing",
  "completed",
  "rejected",
  "failed",
]);
export type ActionStatus = typeof ActionStatus.Type;

export const FindingKind = Schema.Literals([
  "root_cause",
  "ruled_out",
  "correlation",
  "drift",
  "trace_bottleneck",
]);
export type FindingKind = typeof FindingKind.Type;

export const BriefKind = Schema.Literals([
  "engineer_update",
  "stakeholder_update",
  "postmortem",
  "daily_digest_tech",
  "daily_digest_exec",
]);
export type BriefKind = typeof BriefKind.Type;

export const BriefStatus = Schema.Literals(["draft", "approved", "sent"]);
export type BriefStatus = typeof BriefStatus.Type;

export const FeedbackReason = Schema.Literals([
  "wrong_cause",
  "noisy",
  "too_verbose",
  "missing_evidence",
  "bad_severity",
  "unnecessary_ask",
  "accurate",
]);
export type FeedbackReason = typeof FeedbackReason.Type;

export const CallerActorSchema = Schema.Struct({
  kind: Schema.Literals(["operator", "agent", "system"]),
  id: Schema.String,
  role: Schema.optional(AgentRole),
  sessionId: Schema.optional(Schema.String),
});
export type CallerActorValue = typeof CallerActorSchema.Type;

export class CallerActor extends Domain.RequestContext<CallerActor>()(
  "Overwatch/CallerActor",
  CallerActorSchema,
) {}

/**
 * Strips keys whose value is `undefined` so `Schema.TaggedClass` instances
 * have identical own-property sets before and after JSON serialization.
 */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

