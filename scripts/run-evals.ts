import * as fs from "node:fs";
import * as path from "node:path";
import {
  validateHeadline,
  validateUnderstanding,
} from "../packages/domain/src/budgets.ts";
import { diffTraceTrees } from "../packages/connectors/src/datadog.ts";

interface EvalCase {
  readonly id: string;
  readonly description: string;
  readonly expectedRootCauseKeyword: string;
  readonly proposedHeadline: string;
  readonly proposedUnderstanding: ReadonlyArray<{
    readonly text: string;
    readonly evidenceIds: ReadonlyArray<string>;
  }>;
  readonly traceFixture: {
    readonly route: string;
    readonly releaseVersion: string;
    readonly slowTraces: ReadonlyArray<any>;
    readonly medianTraces: ReadonlyArray<any>;
  };
}

const casesDir = path.resolve(import.meta.dir, "../evals/cases");
const files = fs.existsSync(casesDir)
  ? fs.readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
  : [];

if (files.length === 0) {
  console.error("No frozen eval cases found in evals/cases/");
  process.exit(1);
}

let passed = 0;
for (const file of files) {
  const evalCase = JSON.parse(
    fs.readFileSync(path.join(casesDir, file), "utf8"),
  ) as EvalCase;
  const headlineErr = validateHeadline(evalCase.proposedHeadline);
  const understandingErr = validateUnderstanding(evalCase.proposedUnderstanding);
  const diff = diffTraceTrees(evalCase.traceFixture);
  const topSpan = diff.spans[0];
  const grounded =
    !headlineErr &&
    !understandingErr &&
    Boolean(topSpan?.nPlusOneSuspect) &&
    evalCase.proposedUnderstanding.some((b) =>
      b.text.toLowerCase().includes(evalCase.expectedRootCauseKeyword.toLowerCase()),
    );

  if (grounded) {
    passed++;
    console.info(`PASS ${evalCase.id}: topSpan=${topSpan?.operation} delta=+${topSpan?.deltaMs}ms`);
  } else {
    console.error(`FAIL ${evalCase.id}: headlineErr=${headlineErr?.message ?? "none"} understandingErr=${understandingErr?.message ?? "none"}`);
  }
}

console.info(`Eval replay complete: ${passed}/${files.length} cases passed.`);
if (passed !== files.length) process.exit(1);
