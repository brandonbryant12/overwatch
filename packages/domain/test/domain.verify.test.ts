import { describe, expect, test } from "bun:test";
import * as Domain from "@alchemy.run/domain";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { AgentApi, OverwatchModel } from "../src/model.ts";
import { defineConfig } from "../src/config.ts";

describe("Overwatch Domain Static Verification", () => {
  test("Domain.verify(OverwatchModel) finds zero definition errors", () => {
    const errors = Domain.verify(OverwatchModel);
    expect(errors).toEqual([]);
  });

  test("AgentApi MCP toolkit compiles cleanly with all tool names <= 64 chars", () => {
    const { toolkit } = DomainAi.toToolkit(AgentApi, {
      expose: [
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
        "NowView.get",
        "IncidentDetailView.get",
        "NeedsMeView.get",
        "InsightFeedView.get",
      ],
    });
    const names = Object.keys(toolkit.tools);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });

  test("defineConfig rejects raw secrets in SecretRef fields", () => {
    expect(() =>
      defineConfig({
        opencode: { binaryPath: "opencode", minVersion: "2.4.1" },
        budgets: {
          dailyUsdCap: 15,
          triage: { maxAwakeMs: 120_000, maxConnectorCalls: 12, maxUsd: 0.75 },
          explore: { maxAwakeMs: 180_000, maxConnectorCalls: 20, maxUsd: 1.0 },
          fix: { maxAwakeMs: 600_000, maxConnectorCalls: 15, maxUsd: 3.0 },
        },
        apps: [
          {
            id: "checkout-api",
            repoPath: "/tmp/checkout",
            defaultBranch: "main",
            worktreeSetup: [],
            verifyCommands: ["bun test"],
            tags: { team: "payments" },
            environments: {
              prod: {
                cadenceSeconds: 60,
                datadog: {
                  site: "datadoghq.com",
                  apiKey: "dd_raw_secret_should_fail",
                  appKey: "keychain:overwatch/dd-app",
                  indexes: ["main"],
                  service: "checkout-api",
                  env: "prod",
                },
                autonomy: {
                  investigate: "act",
                  prepareWorktreeFix: "act",
                  createGithubIssue: "propose",
                  openDraftPr: "propose",
                },
              },
            },
          },
        ],
      }),
    ).toThrow();
  });
});
