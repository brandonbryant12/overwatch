/**
 * A finding as an agent files it, decoded with a schema before anything is recorded. Limits are part of the schema
 * the agent sees and are enforced here; quotes are checked against what the session was shown by the service
 * (`src/service/citations.ts`), never by a model.
 */
import * as Schema from "effect/Schema";

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const Evidence = Schema.Struct({
  /** A telemetry source name, or a file path relative to the working directory. */
  source: text(40),
  /** Copied exactly from a query result, the brief, or the file. */
  quote: text(300),
});

export const FindingInput = Schema.Struct({
  product: Schema.Struct({
    impact: text(200),
    affected: text(200),
    since: text(200),
    status: text(200),
  }),
  engineering: Schema.Struct({
    verdict: Schema.Literals(["real", "not_real", "unsure"]),
    confidence: Schema.Literals(["high", "medium", "low"]),
    cause: text(240),
    causeBasis: Schema.Literals(["observed", "inferred"]),
    evidence: Schema.Array(Evidence).check(Schema.isMaxLength(3)),
    codeLocation: Schema.optionalKey(text(200)),
    notChecked: Schema.Array(text(140)).check(Schema.isMaxLength(4)),
    nextCheck: text(200),
  }),
  /** Hypotheses this session ruled out, so a later session does not check them again. */
  ruledOut: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMaxLength(6))),
});
export type FindingInput = typeof FindingInput.Type;

/** A finding as recorded: the input, with each quote marked verified or not by code. */
export const CheckedEvidence = Schema.Struct({ source: Schema.String, quote: Schema.String, verified: Schema.Boolean });
export const Finding = Schema.Struct({
  product: FindingInput.fields.product,
  engineering: Schema.Struct({
    ...FindingInput.fields.engineering.fields,
    evidence: Schema.Array(CheckedEvidence),
  }),
  ruledOut: Schema.Array(Schema.String),
});
export type Finding = typeof Finding.Type;
