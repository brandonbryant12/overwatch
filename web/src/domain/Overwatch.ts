/**
 * What the page reads of the service's JSON (docs/plans/simple-core-interfaces.md), as Schemas. Each Struct names only
 * the fields the page shows; anything else the service sends is dropped on decode. A field the service may leave out
 * or send as null is `Maybe`, so a page fixture that sends less still decodes.
 */
import { Schema } from "effect";
import { CommitSummary, HandoffBundle, LensReply, LensSpec } from "./Lens.ts";

export { CommitSummary, HandoffBundle, LensReply, LensSpec };

const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

export const Way = Schema.Struct({
  kind: Schema.String,
  seq: Schema.Number,
  untilMs: Maybe(Schema.Number),
  when: Maybe(Schema.String),
  reason: Maybe(Schema.String),
});
export type Way = typeof Way.Type;

export const Incident = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  count: Schema.Number,
  exact: Schema.Boolean,
  severity: Schema.String,
  app: Schema.String,
  environment: Schema.String,
  active: Schema.Boolean,
  group: Maybe(Schema.String),
  decidedSeq: Maybe(Schema.Number),
  way: Maybe(Way),
  returned: Maybe(Schema.Struct({ code: Schema.String, reason: Schema.String })),
  seenSeq: Maybe(Schema.Number),
  firstSeq: Schema.Number,
  lastSeq: Schema.Number,
  firstMs: Schema.Number,
  lastMs: Schema.Number,
  // An hour the service has no count for can be null; it is drawn as none.
  spark: Schema.Array(Schema.NullOr(Schema.Number)),
});
export type Incident = typeof Incident.Type;

export const Reading = Schema.Struct({
  source: Schema.String,
  reading: Schema.String,
  state: Maybe(Schema.String),
  okMs: Schema.NullOr(Schema.Number),
});

export const Environment = Schema.Struct({
  app: Schema.String,
  environment: Schema.String,
  subject: Schema.String,
  health: Schema.String,
  readings: Schema.Array(Reading),
  freshForMs: Schema.Number,
  excluded: Schema.Array(Schema.String),
});
export type Environment = typeof Environment.Type;

export const Source = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  app: Schema.String,
  environment: Schema.String,
  kind: Schema.String,
  checkpointMs: Maybe(Schema.Number),
  failure: Maybe(Schema.String),
  suspended: Schema.Boolean,
  fix: Maybe(Schema.String),
});
export type Source = typeof Source.Type;

export const Inbox = Schema.Struct({
  groups: Schema.Struct({
    needsYou: Schema.Array(Schema.String),
    new: Schema.Array(Schema.String),
    working: Schema.Array(Schema.String),
    quiet: Schema.Array(Schema.String),
  }),
});
export type Inbox = typeof Inbox.Type;

export const Forecast = Schema.Struct({
  source: Schema.String,
  resource: Schema.String,
  unit: Maybe(Schema.String),
  limit: Schema.Number,
  state: Schema.String,
  reason: Maybe(Schema.String),
  asOfMs: Schema.NullOr(Schema.Number),
  etaMinutes: Maybe(Schema.Number),
  samples: Maybe(Schema.Number),
  ratePerMinute: Maybe(Schema.Number),
  intervalMs: Schema.Number,
});
export type Forecast = typeof Forecast.Type;

export const Comparison = Schema.Struct({
  app: Schema.String,
  staging: Schema.String,
  state: Schema.String,
  reason: Maybe(Schema.String),
  stagingRevision: Maybe(Schema.String),
  productionRevision: Maybe(Schema.String),
  stagingCount: Maybe(Schema.Number),
  productionCount: Maybe(Schema.Number),
});
export type Comparison = typeof Comparison.Type;

export const Outlook = Schema.Struct({
  forecasts: Schema.Array(Forecast),
  comparisons: Schema.Array(Comparison),
  commits: Maybe(Schema.Array(CommitSummary)),
});
export type Outlook = typeof Outlook.Type;

export const Snapshot = Schema.Struct({
  seq: Schema.Number,
  atMs: Schema.Number,
  paused: Maybe(Schema.String),
  pausedFix: Maybe(Schema.String),
  environments: Schema.Array(Environment),
  sources: Schema.Array(Source),
  incidents: Schema.Array(Incident),
  inbox: Inbox,
  coverage: Schema.Array(Schema.Struct({
    source: Schema.String,
    reading: Schema.String,
    toMs: Schema.Number,
    state: Schema.String,
    missed: Maybe(Schema.Number),
  })),
  metrics: Schema.Array(Schema.Struct({ source: Schema.String, name: Schema.String, value: Schema.Number, breach: Schema.Boolean })),
  deploys: Schema.Array(Schema.Struct({ app: Schema.String, environment: Schema.String, revision: Schema.String, previous: Maybe(Schema.String), seq: Schema.Number })),
  outlook: Maybe(Outlook),
  causes: Schema.Array(Schema.Struct({ kind: Schema.String, sources: Schema.Array(Schema.String), fix: Maybe(Schema.String) })),
});
export type Snapshot = typeof Snapshot.Type;

/** A decision's answer: the state after it, and the action's position. */
export const Decided = Schema.Struct({
  ...Snapshot.fields,
  action: Schema.Struct({ seq: Schema.NullOr(Schema.Number) }),
});
export type Decided = typeof Decided.Type;

/** A heartbeat: the service is there, and its clock. */
export const Heartbeat = Schema.Struct({ atMs: Schema.optional(Schema.Number) });

export const Piece = Schema.Struct({ handle: Schema.String, source: Schema.String, text: Schema.String });
export type Piece = typeof Piece.Type;

export const Challenge = Schema.Struct({
  outcome: Maybe(Schema.String),
  reason: Maybe(Schema.String),
  pieces: Maybe(Schema.Array(Piece)),
});

export const InvestigationResult = Schema.Struct({
  verdict: Schema.String,
  planned: Schema.Number,
  counts: Maybe(Schema.Struct({
    real: Schema.optional(Schema.Number),
    not_real: Schema.optional(Schema.Number),
    unsure: Schema.optional(Schema.Number),
    missing: Schema.optional(Schema.Number),
  })),
  challenge: Maybe(Challenge),
  observed: Maybe(Schema.Boolean),
  observations: Maybe(Schema.Number),
  readings: Schema.Array(Schema.Struct({
    slot: Schema.Union([Schema.Number, Schema.String]),
    verdict: Maybe(Schema.String),
    findingId: Maybe(Schema.String),
    reason: Maybe(Schema.String),
  })),
});
export type InvestigationResult = typeof InvestigationResult.Type;

export const Finding = Schema.Struct({
  id: Schema.String,
  verdict: Schema.String,
  claims: Maybe(Schema.Array(Schema.Struct({ statement: Schema.String, pieces: Maybe(Schema.Array(Piece)) }))),
  body: Maybe(Schema.Struct({
    cause: Maybe(Schema.String),
    ruled_out: Maybe(Schema.Array(Schema.String)),
    not_checked: Maybe(Schema.Array(Schema.String)),
    challenge: Schema.optional(Schema.Unknown),
  })),
});
export type Finding = typeof Finding.Type;

export const Fix = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  reason: Maybe(Schema.String),
  host: Maybe(Schema.String),
  action: Maybe(Schema.Struct({ label: Schema.String, effect: Schema.String })),
  deployed: Maybe(Schema.String),
  previous: Maybe(Schema.String),
  diff: Maybe(Schema.String),
  verification: Schema.Array(Schema.Struct({
    argv: Schema.Array(Schema.String),
    exitCode: Schema.NullOr(Schema.Number),
    elapsedMs: Schema.Number,
  })),
  pr: Maybe(Schema.Struct({ number: Schema.Number, url: Schema.String })),
  publishedMs: Maybe(Schema.Number),
});
export type Fix = typeof Fix.Type;

/** An event in an item's history; what each kind carries is read in words by the page. */
export const HistoryEvent = Schema.Struct({
  atMs: Schema.Number,
  kind: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type HistoryEvent = typeof HistoryEvent.Type;

/** GET /v2/items/:id */
export const ItemDetail = Schema.Struct({
  incident: Incident,
  history: Schema.Array(HistoryEvent),
  findings: Schema.Array(Finding),
  investigations: Schema.Array(Schema.Struct({
    jobId: Schema.String,
    state: Schema.String,
    result: Schema.NullOr(InvestigationResult),
  })),
  turns: Schema.Array(Schema.Struct({
    text: Schema.String,
    state: Schema.String,
    answer: Maybe(Schema.String),
    reason: Maybe(Schema.String),
    reads: Maybe(Schema.Number),
  })),
  corrections: Schema.Array(Schema.Struct({ date: Schema.String, text: Schema.String })),
  fixable: Schema.Boolean,
  fixes: Schema.Array(Fix),
  comparison: Maybe(Comparison),
  lens: Maybe(LensSpec),
  lenses: Maybe(Schema.Array(LensSpec)),
});
export type ItemDetail = typeof ItemDetail.Type;

/** GET /v2/focus: where a prompt on a subject goes, and a request key for one write. */
export const Focus = Schema.Struct({
  subject: Schema.String,
  label: Schema.String,
  promptTarget: Schema.Struct({ subject: Schema.String, mode: Schema.String }),
  requestKey: Schema.String,
});
export type Focus = typeof Focus.Type;

export const SearchHit = Schema.Struct({ id: Schema.String, title: Schema.String, excerpt: Schema.String });
export type SearchHit = typeof SearchHit.Type;

/** GET /v2/search: one page of matches and the cursor of the next. */
export const SearchPage = Schema.Struct({ items: Schema.Array(SearchHit), nextCursor: Schema.NullOr(Schema.String) });
export type SearchPage = typeof SearchPage.Type;

export const Audience = Schema.Literals(["owner", "team"]);
export type Audience = typeof Audience.Type;

/** GET /v2/brief */
export const Brief = Schema.Struct({ audience: Schema.String, text: Schema.String });
export type Brief = typeof Brief.Type;

/** POST /v2/ask */
export const Asked = Schema.Struct({ target: Schema.Struct({ subject: Schema.String, mode: Schema.String }) });
export type Asked = typeof Asked.Type;

/** POST /v2/open */
export const Opened = Schema.Struct({ url: Schema.String });

/** POST /v2/fixes/:id/publish */
export const Published = Schema.Struct({
  fix: Maybe(Schema.Struct({ pr: Maybe(Schema.Struct({ number: Schema.Number })), reason: Maybe(Schema.String) })),
});
export type Published = typeof Published.Type;

/** A request the service refused or could not answer: its HTTP status (0 when nothing answered) and its words. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The page's own clocks, sampled together. */
export const Sample = Schema.Struct({ wallMs: Schema.Number, monoMs: Schema.Number });
export type Sample = typeof Sample.Type;

/** A way out, as the page sends it. */
export const WayOutBody = Schema.Struct({
  action: Schema.Literals(["done", "later", "never"]),
  when: Schema.optional(Schema.Literal("worse")),
  untilMs: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});
export type WayOutBody = typeof WayOutBody.Type;
