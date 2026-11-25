import { describe, expect, test } from "./harness.ts";
import { findingJsonSchema, renderProductSummary, renderReport, validateFinding } from "../src/collect/report.ts";
import { realFinding } from "./helpers.ts";


describe("finding schema", () => {
  test("a complete finding validates", () => {
    expect(validateFinding(realFinding)).toEqual({ ok: true, finding: realFinding });
  });

  test("nothing found is a short, valid answer", () => {
    const nothing = {
      product: { impact: "Nothing user-visible", affected: "nobody", since: "unknown", status: "not happening" },
      engineering: {
        verdict: "not_real",
        confidence: "medium",
        cause: "Nothing found: no errors matching the report in logs or events for the window.",
        causeBasis: "inferred",
        evidence: [],
        notChecked: [],
        nextCheck: "Ask the reporter for a request ID.",
      },
    };
    expect(validateFinding(nothing).ok).toBe(true);
  });

  test("length limits are enforced, with reasons the agent can act on", () => {
    const long = {
      ...realFinding,
      product: { ...realFinding.product, impact: Array(90).fill("word").join(" ") },
      engineering: {
        ...realFinding.engineering,
        evidence: [...realFinding.engineering.evidence, ...realFinding.engineering.evidence],
        cause: "x".repeat(300),
        codeLocation: "somewhere in payments",
      },
    };
    const result = validateFinding(long);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("product summary is");
    expect(result.errors.join("\n")).toContain("evidence has 4 items; the limit is 3");
    expect(result.errors.join("\n")).toContain("cause is 300 characters");
    expect(result.errors.join("\n")).toContain("codeLocation must be path:line");
  });

  test("claims need evidence", () => {
    const unsupported = { ...realFinding, engineering: { ...realFinding.engineering, evidence: [] } };
    const result = validateFinding(unsupported);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("a real verdict needs at least one piece of evidence");
  });

  test("the JSON schema the agent sees carries the same limits", () => {
    const e = findingJsonSchema.properties.engineering.properties;
    expect(e.evidence.maxItems).toBe(3);
    expect(e.cause.maxLength).toBe(240);
    expect(findingJsonSchema.properties.product.description).toContain("80 words");
  });
});

describe("rendering", () => {
  test("the product summary is plain, copyable and under 80 words", () => {
    const summary = renderProductSummary(realFinding);
    expect(summary).toBe(
      "Some card payments fail at checkout. Affected: customers paying by card. Since: 2026-11-25 10:05 UTC. Status: ongoing.",
    );
    expect(summary.split(/\s+/).length).toBeLessThan(80);
  });

  test("the engineering section leads with the verdict and always lists coverage gaps", () => {
    const report = renderReport(realFinding, {
      title: "payment timeouts",
      app: "shop-api",
      environment: "production",
      window: { from: Date.parse("2026-11-25T09:35:00Z"), to: Date.parse("2026-11-25T12:00:00Z") },
      commit: "9f8e7d6c5b4a39281706",
      coverage: ["errors: 2026-11-10T12:00:00Z to 2026-11-11T12:00:00Z not checked (lookback is capped at 14d)"],
    });
    const engineering = report.slice(report.indexOf("```text") + 8);
    expect(engineering.startsWith("Verdict: Real (high confidence)")).toBe(true);
    expect(report).toContain("Cause (observed): The payments client timeout");
    expect(report).toContain("Code: payments.ts:1 @ 9f8e7d6c5b4a");
    expect(report).toContain("Not checked: errors: 2026-11-10T12:00:00Z to 2026-11-11T12:00:00Z not checked (lookback is capped at 14d); payment provider status page");
    expect(report).toContain("Next check: Compare p95");
  });
});
