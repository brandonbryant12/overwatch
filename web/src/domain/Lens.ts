/**
 * Declarative GenUI Visual Lens, Commit Watcher, and OpenCode Handoff Schemas.
 * Strictly data-only (zero view-layer imports): every visual block is a typed, bounded structure that renders through
 * Foldkit's safe element builder with zero raw HTML injection and explicit evidence-handle grounding.
 */
import { Schema } from "effect";

const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

export const LensTone = Schema.Literals(["neutral", "warn", "error", "ok"]);
export type LensTone = typeof LensTone.Type;

export const LensOrigin = Schema.Literals(["telemetry", "code", "history", "generated"]);
export type LensOrigin = typeof LensOrigin.Type;

export const CausalStep = Schema.Struct({
  label: Schema.String,
  detail: Schema.String,
  tone: LensTone,
  handle: Maybe(Schema.String),
});
export type CausalStep = typeof CausalStep.Type;

export const CausalFlowBlock = Schema.Struct({
  kind: Schema.Literal("causal_flow"),
  title: Schema.String,
  steps: Schema.Array(CausalStep),
});
export type CausalFlowBlock = typeof CausalFlowBlock.Type;

export const SpanEntry = Schema.Struct({
  label: Schema.String,
  service: Schema.String,
  durationMs: Schema.Number,
  offsetMs: Schema.Number,
  status: Schema.Literals(["ok", "slow", "error"]),
  handle: Maybe(Schema.String),
});
export type SpanEntry = typeof SpanEntry.Type;

export const SpanWaterfallBlock = Schema.Struct({
  kind: Schema.Literal("span_waterfall"),
  title: Schema.String,
  p50Ms: Maybe(Schema.Number),
  slowMs: Maybe(Schema.Number),
  spans: Schema.Array(SpanEntry),
});
export type SpanWaterfallBlock = typeof SpanWaterfallBlock.Type;

export const MetricCompareRow = Schema.Struct({
  label: Schema.String,
  before: Schema.String,
  after: Schema.String,
  beforeNum: Maybe(Schema.Number),
  afterNum: Maybe(Schema.Number),
  unit: Maybe(Schema.String),
  delta: Schema.String,
  tone: LensTone,
  handle: Maybe(Schema.String),
});
export type MetricCompareRow = typeof MetricCompareRow.Type;

export const MetricCompareBlock = Schema.Struct({
  kind: Schema.Literal("metric_compare"),
  title: Schema.String,
  rows: Schema.Array(MetricCompareRow),
});
export type MetricCompareBlock = typeof MetricCompareBlock.Type;

export const CommitRiskItem = Schema.Struct({
  sha: Schema.String,
  subject: Schema.String,
  files: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number,
  flags: Schema.Array(Schema.String),
  deployed: Schema.Boolean,
  handle: Maybe(Schema.String),
});
export type CommitRiskItem = typeof CommitRiskItem.Type;

export const CommitRiskBlock = Schema.Struct({
  kind: Schema.Literal("commit_risk"),
  title: Schema.String,
  commits: Schema.Array(CommitRiskItem),
});
export type CommitRiskBlock = typeof CommitRiskBlock.Type;

export const TimelineEvent = Schema.Struct({
  at: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["deploy", "spike", "span", "finding", "fix"]),
  handle: Maybe(Schema.String),
});
export type TimelineEvent = typeof TimelineEvent.Type;

export const TimelineBlock = Schema.Struct({
  kind: Schema.Literal("timeline"),
  title: Schema.String,
  events: Schema.Array(TimelineEvent),
});
export type TimelineBlock = typeof TimelineBlock.Type;

export const KeyFactItem = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  origin: LensOrigin,
  handle: Maybe(Schema.String),
});
export type KeyFactItem = typeof KeyFactItem.Type;

export const KeyFactsBlock = Schema.Struct({
  kind: Schema.Literal("key_facts"),
  title: Schema.String,
  facts: Schema.Array(KeyFactItem),
});
export type KeyFactsBlock = typeof KeyFactsBlock.Type;

export const LensBlock = Schema.Union([
  CausalFlowBlock,
  SpanWaterfallBlock,
  MetricCompareBlock,
  CommitRiskBlock,
  TimelineBlock,
  KeyFactsBlock,
]);
export type LensBlock = typeof LensBlock.Type;

export const LensSpec = Schema.Struct({
  source: Schema.Literals(["ai", "derived"]),
  title: Schema.String,
  summary: Schema.String,
  model: Maybe(Schema.String),
  generatedAt: Schema.Number,
  verifiedHandles: Schema.Array(Schema.String),
  blocks: Schema.Array(LensBlock),
});
export type LensSpec = typeof LensSpec.Type;

export const LensReply = Schema.Struct({ lens: LensSpec });
export type LensReply = typeof LensReply.Type;

export const CommitSummary = Schema.Struct({
  app: Schema.String,
  sha: Schema.String,
  parent: Schema.NullOr(Schema.String),
  committedAt: Schema.Number,
  subject: Schema.String,
  files: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number,
  flags: Schema.Array(Schema.String),
  paths: Schema.Array(Schema.String),
  deployedEnvs: Schema.Array(Schema.String),
});
export type CommitSummary = typeof CommitSummary.Type;

export const HandoffBundle = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  app: Schema.String,
  env: Schema.String,
  checkout: Maybe(Schema.String),
  deploy: Maybe(Schema.String),
  previousDeploy: Maybe(Schema.String),
  handles: Schema.Array(Schema.String),
  mcpTools: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  prompt: Schema.String,
  markdown: Schema.String,
});
export type HandoffBundle = typeof HandoffBundle.Type;
