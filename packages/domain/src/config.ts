import * as Schema from "effect/Schema";
import { AutonomyLevel } from "./ids.ts";

/**
 * Credential-blind secret reference: never store raw PATs or API keys in config.
 * Supported schemes:
 * - keychain:<service>/<account>
 * - env:<ENV_VAR_NAME>
 */
export const SecretRefSchema = Schema.String.check(
  Schema.makeFilter((val) =>
    val.startsWith("keychain:") || val.startsWith("env:")
      ? undefined
      : 'Secret references must start with "keychain:" or "env:" (never raw credentials).',
  ),
);
export type SecretRef = typeof SecretRefSchema.Type;

export const RunBudgetSchema = Schema.Struct({
  maxAwakeMs: Schema.Number,
  maxConnectorCalls: Schema.Number,
  maxTotalToolCalls: Schema.optional(Schema.Number),
  maxUsd: Schema.Number,
});
export type RunBudget = typeof RunBudgetSchema.Type;

export const KubernetesEnvConfigSchema = Schema.Struct({
  context: Schema.String,
  namespace: Schema.String,
  selector: Schema.String,
  containerNames: Schema.optional(Schema.Array(Schema.String)),
});

export const DatadogEnvConfigSchema = Schema.Struct({
  site: Schema.String,
  apiKey: SecretRefSchema,
  appKey: SecretRefSchema,
  indexes: Schema.Array(Schema.String),
  service: Schema.String,
  env: Schema.String,
});

export const JenkinsEnvConfigSchema = Schema.Struct({
  baseUrl: Schema.String,
  username: SecretRefSchema,
  token: SecretRefSchema,
  jobPath: Schema.String,
  branchFilter: Schema.optional(Schema.String),
});

export const EnvAutonomySchema = Schema.Struct({
  investigate: AutonomyLevel,
  prepareWorktreeFix: AutonomyLevel,
  createGithubIssue: AutonomyLevel,
  openDraftPr: AutonomyLevel,
  sendBrief: Schema.optional(AutonomyLevel),
});
export type EnvAutonomy = typeof EnvAutonomySchema.Type;

export const EnvironmentConfigSchema = Schema.Struct({
  cadenceSeconds: Schema.Number,
  recoveryCleanWindows: Schema.optional(Schema.Number),
  region: Schema.optional(Schema.String),
  kubernetes: Schema.optional(KubernetesEnvConfigSchema),
  datadog: Schema.optional(DatadogEnvConfigSchema),
  jenkins: Schema.optional(JenkinsEnvConfigSchema),
  autonomy: EnvAutonomySchema,
});
export type EnvironmentConfig = typeof EnvironmentConfigSchema.Type;

export const AppConfigSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  repoPath: Schema.String,
  githubRepo: Schema.optional(Schema.String),
  defaultBranch: Schema.String,
  worktreeSetup: Schema.Array(Schema.String),
  verifyCommands: Schema.Array(Schema.String),
  tags: Schema.Record(Schema.String, Schema.String),
  environments: Schema.Record(Schema.String, EnvironmentConfigSchema),
});
export type AppConfig = typeof AppConfigSchema.Type;

export const WatchRuleConfigSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  appId: Schema.String,
  envId: Schema.String,
  metric: Schema.Literals([
    "p95_latency_ms",
    "error_rate_pct",
    "pod_restarts",
    "cpu_pct",
    "memory_pct",
    "build_failure",
  ]),
  operator: Schema.Literals(["gt", "gte", "ratio_gt"]),
  threshold: Schema.Number,
  hysteresisCount: Schema.Number,
  severity: Schema.Literals(["page", "warn", "info"]),
});
export type WatchRuleConfig = typeof WatchRuleConfigSchema.Type;

export const OverwatchConfigSchema = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["live", "demo"])),
  opencode: Schema.Struct({
    binaryPath: Schema.String,
    minVersion: Schema.String,
    serviceUrl: Schema.optional(Schema.String),
    models: Schema.optional(
      Schema.Struct({
        triage: Schema.String,
        investigator: Schema.String,
        explorer: Schema.String,
        fixer: Schema.String,
        scribe: Schema.String,
        judge: Schema.String,
      }),
    ),
  }),
  budgets: Schema.Struct({
    dailyUsdCap: Schema.Number,
    triage: RunBudgetSchema,
    investigate: Schema.optional(RunBudgetSchema),
    explore: RunBudgetSchema,
    fix: RunBudgetSchema,
  }),
  apps: Schema.Array(AppConfigSchema),
  watchRules: Schema.optional(Schema.Array(WatchRuleConfigSchema)),
});
export type OverwatchConfig = typeof OverwatchConfigSchema.Type;

const decodeConfigSync = Schema.decodeUnknownSync(OverwatchConfigSchema);

/**
 * Schema-validated credential-blind configuration builder for `overwatch.config.ts`.
 */
export function defineConfig(input: OverwatchConfig): OverwatchConfig {
  return decodeConfigSync(input);
}
