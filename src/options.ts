import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseDuration } from "./duration.ts";
import type { MetricRule } from "./detection.ts";

/**
 * Overwatch configuration, read from the plugin entry's `options` in the user's own OpenCode config.
 * Nothing here has an environment-specific default: apps, checkouts, contexts and queries all come from the user.
 */
export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface SourceConfig {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface DeployedCommitConfig {
  /** Name of a kubernetes source in the same environment, read from its running pods. */
  readonly source?: string;
  /** `image-tag` (default), `label:<key>` or `annotation:<key>`. */
  readonly from?: string;
  /** Command whose trimmed stdout is the deployed commit or ref. */
  readonly command?: ReadonlyArray<string>;
}

export interface EnvironmentConfig {
  readonly sources: Readonly<Record<string, SourceConfig>>;
  readonly deployedCommit?: DeployedCommitConfig;
  readonly metrics?: ReadonlyArray<MetricRule>;
}

export interface AppConfig {
  readonly name: string;
  /** Local checkout of the app's repository. */
  readonly checkout: string;
  /** Branch draft pull requests target. */
  readonly baseBranch: string;
  /** Commands that must pass before a draft pull request is opened. No commands, no pull requests. */
  readonly verify: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly environments: Readonly<Record<string, EnvironmentConfig>>;
}

export interface WatcherConfig {
  readonly id: string;
  readonly app: string;
  readonly environment: string;
  readonly everyMs: number;
  /** Source names to watch. Defaults to every source in the environment. */
  readonly sources: ReadonlyArray<string>;
  readonly skills: ReadonlyArray<string>;
  readonly investigate: boolean;
  /** Let an investigation that finds a fixable cause try a fix and open a draft pull request. */
  readonly fix: boolean;
  /** Occurrences in one run before a log or event group opens an incident. */
  readonly minCount: number;
  /** Consecutive clean runs before an incident resolves. */
  readonly resolveAfter: number;
}

export interface Options {
  readonly apps: Readonly<Record<string, AppConfig>>;
  readonly watchers: ReadonlyArray<WatcherConfig>;
  readonly datadog?: {
    readonly site: string;
    readonly apiUrl: string;
    readonly apiKey: string;
    readonly appKey: string;
  };
  readonly lookback: {
    readonly initialMs: number;
    readonly maxMs: number;
    readonly overlapMs: number;
    readonly sliceMs: number;
  };
  readonly timeouts: {
    /** One call to a source: one `kubectl` command, one HTTP request, one program. */
    readonly sourceMs: number;
    /** One source collecting one slice, however many calls that takes. */
    readonly sliceMs: number;
    readonly investigationMs: number;
    readonly fixMs: number;
    readonly verifyMs: number;
  };
  readonly concurrency: {
    readonly investigations: number;
    readonly watchers: number;
    /** Calls one source makes at once within a slice, such as `kubectl logs` across pods. */
    readonly sourceCalls: number;
  };
  readonly redaction: {
    readonly entropy: boolean;
    readonly allow: ReadonlyArray<RegExp>;
    readonly patterns: ReadonlyArray<RegExp>;
  };
  readonly schedule: boolean;
  readonly notify: boolean;
  readonly dataDir: string;
  /** `provider/model` for investigation and fix sessions. Defaults to the server's default model. */
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly permissions: {
    readonly investigator: ReadonlyArray<PermissionRule>;
    readonly fixer: ReadonlyArray<PermissionRule>;
  };
}

export interface ParsedOptions {
  readonly options: Options;
  readonly errors: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function expandPath(path: string, base?: string): string {
  const home = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(home) ? home : resolve(base ?? process.cwd(), home);
}

function defaultDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share"), "opencode-overwatch");
}

function permissionRules(value: unknown, path: string, errors: string[]): PermissionRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a list of { action, resource, effect } rules`);
    return [];
  }
  return value.flatMap((rule, index) => {
    if (
      isRecord(rule) &&
      typeof rule.action === "string" &&
      typeof rule.resource === "string" &&
      (rule.effect === "allow" || rule.effect === "deny" || rule.effect === "ask")
    ) {
      return [{ action: rule.action, resource: rule.resource, effect: rule.effect }];
    }
    errors.push(`${path}[${index}] must be { action, resource, effect }`);
    return [];
  });
}

function duration(value: unknown, fallback: string, path: string, errors: string[]): number {
  const parsed = parseDuration(value ?? fallback);
  if (parsed === undefined) {
    errors.push(`${path} must be a duration such as "15m", "24h" or "14d"`);
    return parseDuration(fallback)!;
  }
  return parsed;
}

function positiveInt(value: unknown, fallback: number, path: string, errors: string[]): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  errors.push(`${path} must be a positive integer`);
  return fallback;
}

function patterns(value: unknown, flags: string, path: string, errors: string[]): RegExp[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be a list of regular expressions`);
    return [];
  }
  return value.flatMap((source, index) => {
    try {
      if (typeof source !== "string" || !source) throw new Error("empty");
      return [new RegExp(source, flags)];
    } catch {
      errors.push(`${path}[${index}] is not a valid regular expression`);
      return [];
    }
  });
}

function parseModel(value: unknown, errors: string[]): Options["model"] {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^[^/\s]+\/\S+$/.test(value)) {
    const slash = value.indexOf("/");
    return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
  }
  errors.push(`model must be "provider/model"`);
  return undefined;
}

function parseEnvironment(value: unknown, path: string, errors: string[]): EnvironmentConfig {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object with sources`);
    return { sources: {} };
  }
  const sources: Record<string, SourceConfig> = {};
  if (!isRecord(value.sources) || Object.keys(value.sources).length === 0) {
    errors.push(`${path}.sources must name at least one source`);
  } else {
    for (const [name, source] of Object.entries(value.sources)) {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) errors.push(`${path}.sources.${name}: use letters, digits, - or _`);
      if (!isRecord(source) || typeof source.type !== "string") {
        errors.push(`${path}.sources.${name} needs a "type"`);
        continue;
      }
      sources[name] = source as SourceConfig;
    }
  }
  const metrics: MetricRule[] = [];
  if (value.metrics !== undefined) {
    if (!Array.isArray(value.metrics)) errors.push(`${path}.metrics must be a list`);
    else
      value.metrics.forEach((rule, index) => {
        const where = `${path}.metrics[${index}]`;
        if (
          !isRecord(rule) ||
          typeof rule.metric !== "string" ||
          typeof rule.threshold !== "number" ||
          !["gt", "gte", "lt", "ratio_gt"].includes(String(rule.operator ?? "gt"))
        ) {
          errors.push(`${where} needs metric, threshold and an operator of gt, gte, lt or ratio_gt`);
          return;
        }
        metrics.push({
          metric: rule.metric,
          operator: (rule.operator ?? "gt") as MetricRule["operator"],
          threshold: rule.threshold,
          hysteresis: positiveInt(rule.hysteresis, 2, `${where}.hysteresis`, errors),
        });
      });
  }
  let deployedCommit: DeployedCommitConfig | undefined;
  if (value.deployedCommit !== undefined) {
    const dc = value.deployedCommit;
    if (!isRecord(dc)) errors.push(`${path}.deployedCommit must be an object`);
    else {
      if (dc.command !== undefined && strings(dc.command).length === 0)
        errors.push(`${path}.deployedCommit.command must be a non-empty list of strings`);
      if (dc.source !== undefined && (typeof dc.source !== "string" || !sources[dc.source]))
        errors.push(`${path}.deployedCommit.source must name a source in this environment`);
      if (dc.from !== undefined && !/^(image-tag|label:.+|annotation:.+)$/.test(String(dc.from)))
        errors.push(`${path}.deployedCommit.from must be image-tag, label:<key> or annotation:<key>`);
      deployedCommit = {
        ...(typeof dc.source === "string" ? { source: dc.source } : {}),
        ...(typeof dc.from === "string" ? { from: dc.from } : {}),
        ...(dc.command !== undefined ? { command: strings(dc.command) } : {}),
      };
    }
  }
  return { sources, ...(metrics.length ? { metrics } : {}), ...(deployedCommit ? { deployedCommit } : {}) };
}

/** Validates plugin options. Errors are collected rather than thrown so the status command can show them. */
export function parseOptions(raw: unknown, base?: string): ParsedOptions {
  const errors: string[] = [];
  const input = isRecord(raw) ? raw : {};
  const apps: Record<string, AppConfig> = {};
  if (input.apps !== undefined && !isRecord(input.apps)) errors.push("apps must be an object keyed by app name");
  for (const [name, value] of Object.entries(isRecord(input.apps) ? input.apps : {})) {
    const path = `apps.${name}`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof value.checkout !== "string" || value.checkout.length === 0) {
      errors.push(`${path}.checkout must be the path to the app's local checkout`);
    }
    const environments: Record<string, EnvironmentConfig> = {};
    if (!isRecord(value.environments) || Object.keys(value.environments).length === 0) {
      errors.push(`${path}.environments must name at least one environment`);
    } else {
      for (const [env, envValue] of Object.entries(value.environments)) {
        environments[env] = parseEnvironment(envValue, `${path}.environments.${env}`, errors);
      }
    }
    apps[name] = {
      name,
      checkout: typeof value.checkout === "string" ? expandPath(value.checkout, base) : "",
      baseBranch: typeof value.baseBranch === "string" ? value.baseBranch : "main",
      verify: strings(value.verify),
      skills: strings(value.skills),
      environments,
    };
  }

  const watchers: WatcherConfig[] = [];
  if (input.watchers !== undefined && !Array.isArray(input.watchers)) errors.push("watchers must be a list");
  (Array.isArray(input.watchers) ? input.watchers : []).forEach((value, index) => {
    const path = `watchers[${index}]`;
    if (!isRecord(value) || typeof value.app !== "string" || typeof value.environment !== "string") {
      errors.push(`${path} needs app and environment`);
      return;
    }
    const app = apps[value.app];
    const env = app?.environments[value.environment];
    if (!app) errors.push(`${path}.app "${value.app}" is not in apps`);
    else if (!env) errors.push(`${path}.environment "${value.environment}" is not an environment of ${value.app}`);
    const id = `${value.app}/${value.environment}`;
    if (watchers.some((w) => w.id === id)) errors.push(`${path}: ${id} is watched twice`);
    const sources = value.sources === undefined ? Object.keys(env?.sources ?? {}) : strings(value.sources);
    for (const source of sources) {
      if (env && !env.sources[source]) errors.push(`${path}.sources: ${source} is not a source of ${id}`);
    }
    watchers.push({
      id,
      app: value.app,
      environment: value.environment,
      everyMs: duration(value.every, "15m", `${path}.every`, errors),
      sources,
      skills: [...(app?.skills ?? []), ...strings(value.skills)],
      investigate: value.investigate !== false,
      fix: value.fix === true,
      minCount: positiveInt(value.minCount, 1, `${path}.minCount`, errors),
      resolveAfter: positiveInt(value.resolveAfter, 3, `${path}.resolveAfter`, errors),
    });
  });

  let datadog: Options["datadog"];
  if (input.datadog !== undefined) {
    const dd = input.datadog;
    if (!isRecord(dd) || typeof dd.apiKey !== "string" || typeof dd.appKey !== "string") {
      errors.push('datadog needs apiKey and appKey secret references such as "env:DD_API_KEY"');
    } else {
      const site = typeof dd.site === "string" ? dd.site : "datadoghq.com";
      datadog = {
        site,
        apiUrl: (typeof dd.apiUrl === "string" ? dd.apiUrl : `https://api.${site}`).replace(/\/+$/, ""),
        apiKey: dd.apiKey,
        appKey: dd.appKey,
      };
      for (const ref of [dd.apiKey, dd.appKey]) {
        if (!/^(env|keychain):.+/.test(ref)) errors.push(`datadog keys must be "env:NAME" or "keychain:service/account"`);
      }
    }
  }

  const lookback = isRecord(input.lookback) ? input.lookback : {};
  const timeouts = isRecord(input.timeouts) ? input.timeouts : {};
  const concurrency = isRecord(input.concurrency) ? input.concurrency : {};
  const permissions = isRecord(input.permissions) ? input.permissions : {};
  const redaction = isRecord(input.redaction) ? input.redaction : {};
  const options: Options = {
    apps,
    watchers,
    ...(datadog ? { datadog } : {}),
    lookback: {
      initialMs: duration(lookback.initial, "24h", "lookback.initial", errors),
      maxMs: duration(lookback.max, "14d", "lookback.max", errors),
      overlapMs: duration(lookback.overlap, "2m", "lookback.overlap", errors),
      sliceMs: duration(lookback.slice, "6h", "lookback.slice", errors),
    },
    timeouts: {
      sourceMs: duration(timeouts.source, "60s", "timeouts.source", errors),
      // Left unset, a slice gets at least as long as one call, so raising timeouts.source alone stays valid.
      sliceMs: Math.max(duration(timeouts.slice, "10m", "timeouts.slice", errors), timeouts.slice === undefined ? duration(timeouts.source, "60s", "timeouts.source", []) : 0),
      investigationMs: duration(timeouts.investigation, "20m", "timeouts.investigation", errors),
      fixMs: duration(timeouts.fix, "30m", "timeouts.fix", errors),
      verifyMs: duration(timeouts.verify, "10m", "timeouts.verify", errors),
    },
    concurrency: {
      investigations: positiveInt(concurrency.investigations, 2, "concurrency.investigations", errors),
      watchers: positiveInt(concurrency.watchers, 2, "concurrency.watchers", errors),
      sourceCalls: positiveInt(concurrency.sourceCalls, 4, "concurrency.sourceCalls", errors),
    },
    redaction: {
      entropy: redaction.entropy !== false,
      allow: patterns(redaction.allow, "", "redaction.allow", errors),
      patterns: patterns(redaction.patterns, "g", "redaction.patterns", errors),
    },
    schedule: input.schedule !== false,
    notify: input.notify === undefined ? process.platform === "darwin" : input.notify === true,
    dataDir: typeof input.dataDir === "string" ? expandPath(input.dataDir, base) : defaultDataDir(),
    ...(input.model !== undefined ? { model: parseModel(input.model, errors) } : {}),
    permissions: {
      investigator: permissionRules(permissions.investigator, "permissions.investigator", errors),
      fixer: permissionRules(permissions.fixer, "permissions.fixer", errors),
    },
  };
  if (options.lookback.initialMs > options.lookback.maxMs) errors.push("lookback.initial cannot exceed lookback.max");
  if (options.timeouts.sliceMs < options.timeouts.sourceMs) errors.push("timeouts.slice cannot be shorter than timeouts.source");
  return { options, errors };
}
