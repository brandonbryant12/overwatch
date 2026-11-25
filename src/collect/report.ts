import { iso } from "./duration.ts";

/**
 * One finding, rendered two ways: a product summary anyone can paste, and an engineering section.
 * Limits are part of the schema the agent sees and are enforced again here, so a long answer is rejected
 * with the reason and the agent shortens it.
 */
export const LIMITS = {
  productWords: 80,
  productField: 200,
  cause: 240,
  evidence: 3,
  evidenceQuote: 300,
  evidenceSource: 40,
  notChecked: 4,
  notCheckedItem: 140,
  nextCheck: 200,
  fixPlan: 400,
} as const;

export type Verdict = "real" | "not_real" | "unsure";

export interface Finding {
  readonly product: {
    /** What users see, in plain language. */
    readonly impact: string;
    /** Who is affected. */
    readonly affected: string;
    /** Since when, as a time or "unknown". */
    readonly since: string;
    /** Ongoing, recovered, intermittent, or not happening. */
    readonly status: string;
  };
  readonly engineering: {
    readonly verdict: Verdict;
    readonly confidence: "high" | "medium" | "low";
    /** One sentence. */
    readonly cause: string;
    readonly causeBasis: "observed" | "inferred";
    /** At most three, each a quoted line or a query that shows it. */
    readonly evidence: ReadonlyArray<{
      readonly source: string;
      readonly quote: string;
      /**
       * Set by Overwatch, never by the agent: whether the quote was found in what the investigation was shown.
       * `false` means it could not be checked (it came from a skill or tool Overwatch cannot see).
       */
      readonly verified?: boolean;
    }>;
    /** `path:line` at the deployed commit, when the cause is in code. */
    readonly codeLocation?: string;
    readonly notChecked: ReadonlyArray<string>;
    readonly nextCheck: string;
  };
  readonly fix?: { readonly possible: boolean; readonly plan?: string };
}

const words = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates against the schema's limits. Returns the finding or the list of problems. */
export function validateFinding(input: unknown): { ok: true; finding: Finding } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const need = (value: unknown, path: string, max: number) => {
    if (typeof value !== "string" || value.trim().length === 0) errors.push(`${path} is required`);
    else if (value.length > max) errors.push(`${path} is ${value.length} characters; the limit is ${max}`);
  };
  const oneOf = (value: unknown, path: string, allowed: ReadonlyArray<string>) => {
    if (typeof value !== "string" || !allowed.includes(value)) errors.push(`${path} must be one of ${allowed.join(", ")}`);
  };
  if (!isRecord(input)) return { ok: false, errors: ["the finding must be an object"] };
  const product = isRecord(input.product) ? input.product : {};
  const engineering = isRecord(input.engineering) ? input.engineering : {};
  for (const key of ["impact", "affected", "since", "status"]) need(product[key], `product.${key}`, LIMITS.productField);
  const productWords = ["impact", "affected", "since", "status"].reduce(
    (sum, key) => sum + (typeof product[key] === "string" ? words(product[key] as string) : 0),
    0,
  );
  if (productWords > LIMITS.productWords) {
    errors.push(`the product summary is ${productWords} words; the limit is ${LIMITS.productWords}`);
  }
  oneOf(engineering.verdict, "engineering.verdict", ["real", "not_real", "unsure"]);
  oneOf(engineering.confidence, "engineering.confidence", ["high", "medium", "low"]);
  oneOf(engineering.causeBasis, "engineering.causeBasis", ["observed", "inferred"]);
  need(engineering.cause, "engineering.cause", LIMITS.cause);
  need(engineering.nextCheck, "engineering.nextCheck", LIMITS.nextCheck);
  const evidence = Array.isArray(engineering.evidence) ? engineering.evidence : [];
  if (!Array.isArray(engineering.evidence)) errors.push("engineering.evidence must be a list (it may be empty)");
  if (evidence.length > LIMITS.evidence) errors.push(`engineering.evidence has ${evidence.length} items; the limit is ${LIMITS.evidence}`);
  evidence.forEach((item, index) => {
    const record = isRecord(item) ? item : {};
    need(record.source, `engineering.evidence[${index}].source`, LIMITS.evidenceSource);
    need(record.quote, `engineering.evidence[${index}].quote`, LIMITS.evidenceQuote);
  });
  if (engineering.verdict === "real" && evidence.length === 0) errors.push("a real verdict needs at least one piece of evidence");
  if (engineering.causeBasis === "observed" && evidence.length === 0) errors.push("an observed cause needs evidence; otherwise mark it inferred");
  const notChecked = Array.isArray(engineering.notChecked) ? engineering.notChecked : [];
  if (!Array.isArray(engineering.notChecked)) errors.push("engineering.notChecked must be a list (it may be empty)");
  if (notChecked.length > LIMITS.notChecked) errors.push(`engineering.notChecked has ${notChecked.length} items; the limit is ${LIMITS.notChecked}`);
  notChecked.forEach((item, index) => need(item, `engineering.notChecked[${index}]`, LIMITS.notCheckedItem));
  if (engineering.codeLocation !== undefined) {
    if (typeof engineering.codeLocation !== "string" || !/^[^\s:]+:\d+(-\d+)?$/.test(engineering.codeLocation)) {
      errors.push("engineering.codeLocation must be path:line");
    }
  }
  let fix: Finding["fix"];
  if (input.fix !== undefined) {
    if (!isRecord(input.fix) || typeof input.fix.possible !== "boolean") errors.push("fix.possible must be true or false");
    else {
      if (input.fix.plan !== undefined) need(input.fix.plan, "fix.plan", LIMITS.fixPlan);
      fix = { possible: input.fix.possible, ...(typeof input.fix.plan === "string" ? { plan: input.fix.plan } : {}) };
    }
  }
  if (errors.length) return { ok: false, errors };
  const finding: Finding = {
    product: {
      impact: String(product.impact).trim(),
      affected: String(product.affected).trim(),
      since: String(product.since).trim(),
      status: String(product.status).trim(),
    },
    engineering: {
      verdict: engineering.verdict as Verdict,
      confidence: engineering.confidence as Finding["engineering"]["confidence"],
      cause: String(engineering.cause).trim(),
      causeBasis: engineering.causeBasis as "observed" | "inferred",
      evidence: evidence.map((item) => ({ source: String(item.source).trim(), quote: String(item.quote).trim() })),
      ...(typeof engineering.codeLocation === "string" ? { codeLocation: engineering.codeLocation } : {}),
      notChecked: notChecked.map((item) => String(item).trim()),
      nextCheck: String(engineering.nextCheck).trim(),
    },
    ...(fix ? { fix } : {}),
  };
  return { ok: true, finding };
}

export interface ReportContext {
  readonly title: string;
  readonly app: string;
  readonly environment?: string;
  readonly window: { readonly from: number; readonly to: number };
  /** Deployed commit the code was read at, if known. */
  readonly commit?: string;
  /** When the current rollout began, if the cluster could tell. */
  readonly rolledOutAt?: number;
  /** Coverage gaps the plugin knows about (failed sources, capped lookback); always shown. */
  readonly coverage: ReadonlyArray<string>;
  readonly pullRequest?: string;
  readonly fixNote?: string;
}

const sentence = (value: string) => (/[.!?]$/.test(value) ? value : `${value}.`);

export function renderProductSummary(finding: Finding): string {
  const p = finding.product;
  return [sentence(p.impact), `Affected: ${sentence(p.affected)}`, `Since: ${sentence(p.since)}`, `Status: ${sentence(p.status)}`].join(" ");
}

export function renderEngineering(finding: Finding, context: ReportContext): string {
  const e = finding.engineering;
  const verdict = { real: "Real", not_real: "Not real", unsure: "Unsure" }[e.verdict];
  const lines = [
    `Verdict: ${verdict} (${e.confidence} confidence)`,
    `Cause (${e.causeBasis}): ${e.cause}`,
  ];
  if (e.evidence.length) {
    lines.push("Evidence:");
    e.evidence.forEach((item, index) => lines.push(`  ${index + 1}. [${item.source}${item.verified === false ? ", not verified" : ""}] ${item.quote}`));
  }
  if (e.codeLocation) lines.push(`Code: ${e.codeLocation}${context.commit ? ` @ ${context.commit.slice(0, 12)}` : ""}`);
  const notChecked = [...context.coverage, ...e.notChecked];
  if (notChecked.length) lines.push(`Not checked: ${notChecked.join("; ")}`);
  lines.push(`Next check: ${e.nextCheck}`);
  if (context.pullRequest) lines.push(`Draft PR: ${context.pullRequest}`);
  else if (context.fixNote) lines.push(`Fix: ${context.fixNote}`);
  return lines.join("\n");
}

export function renderReport(finding: Finding, context: ReportContext): string {
  const scope = context.environment ? `${context.app}/${context.environment}` : context.app;
  return [
    `## ${context.title}`,
    `${scope} · ${iso(context.window.from)} to ${iso(context.window.to)}${context.commit ? ` · deployed ${context.commit.slice(0, 12)}` : ""}${context.rolledOutAt !== undefined ? ` · rolled out ${iso(context.rolledOutAt)}` : ""}`,
    "",
    "**Product summary**",
    "",
    renderProductSummary(finding),
    "",
    "**Engineering**",
    "",
    "```text",
    renderEngineering(finding, context),
    "```",
  ].join("\n");
}

/** A finding as Overwatch stored it. It was validated when it was filed, so only its shape is checked here. */
export function storedFinding(raw: unknown): Finding | undefined {
  return isRecord(raw) && isRecord(raw.product) && isRecord(raw.engineering) && Array.isArray(raw.engineering.evidence) ? (raw as unknown as Finding) : undefined;
}

/** Applies `fn` to every piece of text in a finding, such as redaction before it is stored and shown. */
export function mapFindingText(finding: Finding, fn: (value: string) => string): Finding {
  const e = finding.engineering;
  return {
    product: { impact: fn(finding.product.impact), affected: fn(finding.product.affected), since: fn(finding.product.since), status: fn(finding.product.status) },
    engineering: {
      ...e,
      cause: fn(e.cause),
      evidence: e.evidence.map((item) => ({ ...item, quote: fn(item.quote) })),
      notChecked: e.notChecked.map(fn),
      nextCheck: fn(e.nextCheck),
    },
    ...(finding.fix ? { fix: { ...finding.fix, ...(finding.fix.plan !== undefined ? { plan: fn(finding.fix.plan) } : {}) } } : {}),
  };
}

/** What the report says when the agent never submitted a finding (timeout, failure). */
export function missingFinding(reason: string): Finding {
  return {
    product: { impact: "Unknown; the investigation did not finish", affected: "unknown", since: "unknown", status: "unknown" },
    engineering: {
      verdict: "unsure",
      confidence: "low",
      cause: `No finding: ${reason}`.slice(0, LIMITS.cause),
      causeBasis: "inferred",
      evidence: [],
      notChecked: [],
      nextCheck: "Open the investigation session and read what it gathered, or run /investigate again.",
    },
  };
}
