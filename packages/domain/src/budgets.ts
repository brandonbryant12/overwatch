import * as Domain from "@alchemy.run/domain";

export const BUDGET_LIMITS = {
  incidentHeadlineMaxChars: 80,
  understandingMaxBullets: 3,
  understandingBulletMaxChars: 140,
  chatReplyMaxChars: 400,
  chatReplyMaxLines: 4,
  askQuestionMaxChars: 140,
  askWhyMaxChars: 140,
  askMinOptions: 2,
  askMaxOptions: 3,
  insightClaimMaxChars: 100,
  insightWhyMaxChars: 120,
  stakeholderMaxWords: 60,
} as const;

export class OutputBudgetExceeded extends Domain.Rejection("OutputBudgetExceeded", {
  field: Schema.String,
  limit: Schema.Number,
  actual: Schema.Number,
  hint: Schema.String,
}) {}

import * as Schema from "effect/Schema";

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function validateHeadline(headline: string): OutputBudgetExceeded | undefined {
  if (headline.trim().length === 0) {
    return new OutputBudgetExceeded({
      field: "headline",
      limit: BUDGET_LIMITS.incidentHeadlineMaxChars,
      actual: 0,
      hint: "Headline must be non-empty and include the primary metric or symptom delta.",
    });
  }
  if (headline.length > BUDGET_LIMITS.incidentHeadlineMaxChars) {
    return new OutputBudgetExceeded({
      field: "headline",
      limit: BUDGET_LIMITS.incidentHeadlineMaxChars,
      actual: headline.length,
      hint: `Keep incident headline <= ${BUDGET_LIMITS.incidentHeadlineMaxChars} characters.`,
    });
  }
  return undefined;
}

export function validateUnderstanding(
  bullets: ReadonlyArray<{ readonly text: string; readonly evidenceIds: ReadonlyArray<string> }>,
): OutputBudgetExceeded | undefined {
  if (bullets.length === 0 || bullets.length > BUDGET_LIMITS.understandingMaxBullets) {
    return new OutputBudgetExceeded({
      field: "understanding",
      limit: BUDGET_LIMITS.understandingMaxBullets,
      actual: bullets.length,
      hint: `Provide 1 to ${BUDGET_LIMITS.understandingMaxBullets} understanding bullets.`,
    });
  }
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i]!;
    if (b.text.length > BUDGET_LIMITS.understandingBulletMaxChars) {
      return new OutputBudgetExceeded({
        field: `understanding[${i}].text`,
        limit: BUDGET_LIMITS.understandingBulletMaxChars,
        actual: b.text.length,
        hint: `Each understanding bullet must be <= ${BUDGET_LIMITS.understandingBulletMaxChars} characters.`,
      });
    }
    if (b.evidenceIds.length === 0) {
      return new OutputBudgetExceeded({
        field: `understanding[${i}].evidenceIds`,
        limit: 1,
        actual: 0,
        hint: "Every understanding bullet must cite at least one EvidenceId.",
      });
    }
  }
  return undefined;
}

export function validateAskBudget(input: {
  readonly question: string;
  readonly whyItMatters: string;
  readonly options: ReadonlyArray<unknown>;
}): OutputBudgetExceeded | undefined {
  if (input.question.length > BUDGET_LIMITS.askQuestionMaxChars) {
    return new OutputBudgetExceeded({
      field: "question",
      limit: BUDGET_LIMITS.askQuestionMaxChars,
      actual: input.question.length,
      hint: `Ask question must be <= ${BUDGET_LIMITS.askQuestionMaxChars} characters.`,
    });
  }
  if (input.whyItMatters.length > BUDGET_LIMITS.askWhyMaxChars) {
    return new OutputBudgetExceeded({
      field: "whyItMatters",
      limit: BUDGET_LIMITS.askWhyMaxChars,
      actual: input.whyItMatters.length,
      hint: `whyItMatters must be <= ${BUDGET_LIMITS.askWhyMaxChars} characters.`,
    });
  }
  if (
    input.options.length < BUDGET_LIMITS.askMinOptions ||
    input.options.length > BUDGET_LIMITS.askMaxOptions
  ) {
    return new OutputBudgetExceeded({
      field: "options",
      limit: BUDGET_LIMITS.askMaxOptions,
      actual: input.options.length,
      hint: `Provide ${BUDGET_LIMITS.askMinOptions} to ${BUDGET_LIMITS.askMaxOptions} structured options.`,
    });
  }
  return undefined;
}

export function validateInsightBudget(input: {
  readonly claim: string;
  readonly whyItMatters: string;
  readonly evidenceIds: ReadonlyArray<string>;
}): OutputBudgetExceeded | undefined {
  if (input.claim.length > BUDGET_LIMITS.insightClaimMaxChars) {
    return new OutputBudgetExceeded({
      field: "claim",
      limit: BUDGET_LIMITS.insightClaimMaxChars,
      actual: input.claim.length,
      hint: `Insight claim must be <= ${BUDGET_LIMITS.insightClaimMaxChars} characters.`,
    });
  }
  if (input.whyItMatters.length > BUDGET_LIMITS.insightWhyMaxChars) {
    return new OutputBudgetExceeded({
      field: "whyItMatters",
      limit: BUDGET_LIMITS.insightWhyMaxChars,
      actual: input.whyItMatters.length,
      hint: `Insight whyItMatters must be <= ${BUDGET_LIMITS.insightWhyMaxChars} characters.`,
    });
  }
  if (input.evidenceIds.length === 0) {
    return new OutputBudgetExceeded({
      field: "evidenceIds",
      limit: 1,
      actual: 0,
      hint: "Every insight must cite at least one EvidenceId.",
    });
  }
  return undefined;
}

export function validateStakeholderUpdate(body: string): OutputBudgetExceeded | undefined {
  const words = countWords(body);
  if (words === 0 || words > BUDGET_LIMITS.stakeholderMaxWords) {
    return new OutputBudgetExceeded({
      field: "body",
      limit: BUDGET_LIMITS.stakeholderMaxWords,
      actual: words,
      hint: `Stakeholder updates must be 1 to ${BUDGET_LIMITS.stakeholderMaxWords} words.`,
    });
  }
  return undefined;
}
