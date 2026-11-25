import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startOverwatchEmulatorStack } from "../packages/emulator/src/index.ts";

/**
 * Full Closed-Loop Emulated Verification & OpenCode Free-Tier Self-Improvement Harness.
 *
 * Usage:
 *   bun run loop:emulated                      # Deterministic closed-loop verification
 *   OVERWATCH_USE_OPENCODE=1 bun run loop:emulated  # Also invokes OpenCode free-tier model (`opencode/big-pickle`)
 */
const useOpenCode = process.env.OVERWATCH_USE_OPENCODE === "1" || process.argv.includes("--opencode");
const freeModel = process.env.OVERWATCH_FREE_MODEL ?? "opencode/big-pickle";

const stack = await startOverwatchEmulatorStack();
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "overwatch-emu-worktree-"));

try {
  console.info("[1/6] Emulated ops stack ready (K8s, Datadog, Jenkins, vercel-labs/emulate GitHub)");

  // Copy sample checkout-api app into an isolated temporary worktree
  const sampleSrc = path.resolve(import.meta.dir, "../examples/checkout-api");
  fs.cpSync(sampleSrc, workDir, { recursive: true });

  // Gather redacted evidence from the stateful emulators
  const podLogs = await (
    await fetch(`${stack.kubernetesUrl}/api/v1/namespaces/checkout/pods/checkout-api-9f31c2a-7b4d/log`)
  ).text();
  const traceDiff = (await (
    await fetch(`${stack.datadogUrl}/api/v1/overwatch/trace-diff`)
  ).json()) as any;
  const jenkins = (await (
    await fetch(`${stack.jenkinsUrl}/job/payments/job/checkout-api/job/main/api/json`)
  ).json()) as any;

  const dbSpan = traceDiff.spans.find((s: any) => s.operation === "pg.query") ?? traceDiff.spans[0];
  console.info(
    `[2/6] Collected emulated telemetry: build #${jenkins.builds[0]?.number}, suspect span ${dbSpan?.operation} (${dbSpan?.slowCallCount}x vs ${dbSpan?.medianCallCount}x, N+1=${dbSpan?.nPlusOneSuspect})`,
  );

  // Confirm reproduction test FAILS on unpatched worktree when N+1 guard is enabled
  const beforeTest = Bun.spawnSync(["bun", "test"], {
    cwd: workDir,
    env: { ...process.env, ENFORCE_NO_N_PLUS_ONE: "1" },
  });
  console.info(`[3/6] Local reproduction before fix: exit=${beforeTest.exitCode} (expected non-zero)`);

  // Step 4: Patch via OpenCode free-tier model (if enabled) OR deterministic fixer patch
  if (useOpenCode) {
    console.info(`[4/6] Invoking OpenCode free-tier model (${freeModel}) inside isolated worktree...`);
    const prompt = [
      "Fix the N+1 query regression in src/checkout.ts so `ENFORCE_NO_N_PLUS_ONE=1 bun test` passes.",
      "Evidence from Datadog trace diff:",
      JSON.stringify(traceDiff.spans[0]),
      "Evidence from Kubernetes pod log:",
      podLogs,
      "Use db.findDiscountsByTiers() to batch promo tier lookups in one query.",
    ].join("\n\n");
    const oc = Bun.spawnSync(
      ["opencode", "run", "-m", freeModel, prompt],
      { cwd: workDir, stdout: "inherit", stderr: "inherit" },
    );
    console.info(`OpenCode run exited with code ${oc.exitCode}`);
  } else {
    console.info("[4/6] Applying deterministic fixer patch inside isolated worktree (pass --opencode to use free-tier LLM)...");
    const targetFile = path.join(workDir, "src/checkout.ts");
    const patched = fs
      .readFileSync(targetFile, "utf8")
      .replace(
        `  let totalCents = 0;\n  for (const item of items) {\n    const discount = await db.findDiscountByTier(item.promoTier);\n    totalCents += Math.round(item.unitCents * item.qty * (1 - discount));\n  }`,
        `  const discounts = await db.findDiscountsByTiers(items.map((i) => i.promoTier));\n  let totalCents = 0;\n  for (const item of items) {\n    const discount = discounts.get(item.promoTier) ?? 0;\n    totalCents += Math.round(item.unitCents * item.qty * (1 - discount));\n  }`,
      );
    fs.writeFileSync(targetFile, patched);
  }

  // Verify locally!
  const afterTest = Bun.spawnSync(["bun", "test"], {
    cwd: workDir,
    env: { ...process.env, ENFORCE_NO_N_PLUS_ONE: "1" },
  });
  if (afterTest.exitCode !== 0) {
    throw new Error(`Worktree verification failed after patch (exit=${afterTest.exitCode})`);
  }
  console.info("[5/6] Local worktree verification PASSED (ENFORCE_NO_N_PLUS_ONE=1 bun test -> exit 0)");

  // Record Issue/PR artifact on vercel-labs/emulate GitHub and roll out build #483
  const issueResp = await fetch(`${stack.githubUrl}/repos/${stack.githubRepo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${stack.githubToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "[Overwatch] Batch promo tier lookup in checkout confirm (INC-42)",
      body: "Verified locally in isolated worktree (`ENFORCE_NO_N_PLUS_ONE=1 bun test` passed).\n\n<!-- overwatch-action-id: act-loop-42 -->",
    }),
  });
  const issue = (await issueResp.json()) as { html_url?: string; number?: number };

  const deployed = await stack.deployRelease({
    commitSha: "7e88f2c11223344556677889900aabbccddeeff0",
    commitMessage: "fix(promos): batch cart_line_items lookup via findDiscountsByTiers",
    healthy: true,
  });

  const postMetrics = (await (
    await fetch(`${stack.datadogUrl}/api/v1/overwatch/metrics`)
  ).json()) as { degraded: boolean; p95LatencyMs: number };

  console.info(
    `[6/6] Closed loop complete! Emulated GitHub artifact #${issue.number}, deployed Jenkins #${deployed.buildNumber} (${deployed.revision}), Datadog p95=${postMetrics.p95LatencyMs}ms (degraded=${postMetrics.degraded})`,
  );
} finally {
  await stack.close();
  fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
