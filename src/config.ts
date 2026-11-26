/**
 * The configuration file: its grammar and the operating limits `check` enforces (specification section 10). Keys
 * outside the grammar, duplicate watchers and anything beyond a limit are refused, offline, before anything runs.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const LIMITS = {
  watchers: 50,
  sourcesPerWatcher: 4,
  minEveryMs: 60_000,
  occurrencesPerSlice: 50_000,
  problemsPerSlice: 500,
  bytesPerPodCall: 4 * 1024 * 1024,
  podsPerSource: 20,
  overlapMs: { kubernetes: 120_000, datadog: 300_000 },
  catchUpMs: 14 * 86_400_000,
  sliceMs: 6 * 3_600_000,
  retryAfterMaxS: 30,
  retryAfterTimes: 2,
  probeMs: 300_000,
  wakeDelayMs: 5_000,
  freshIntervals: 3,
  freeFloorBytes: 256 * 1024 ** 2,
  databaseBudgetBytes: 1024 ** 3,
  reclaimBytes: 16 * 1024 ** 2,
  quietIntervals: 3,
  linesPerProblem: 200,
  pieceBytes: 16_384,
  piecesPerSession: 400,
  toolCallsPerRun: 8,
  runActiveMs: 300_000,
  concurrentJobs: 2,
} as const;

export const READINGS = { kubernetes: ["logs", "events", "workloads", "usage"], datadog: ["logs", "monitors", "metrics"] } as const;
export type Kind = keyof typeof READINGS;

export interface Source {
  readonly id: string;
  readonly app: string;
  readonly environment: string;
  readonly name: string;
  readonly kind: Kind;
  readonly everyMs: number;
  readonly readings: ReadonlyArray<string>;
  readonly excluded: ReadonlyArray<string>;
  readonly checkout: string;
  readonly context?: string;
  readonly namespace?: string;
  readonly selector?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly appKey?: string;
  readonly query?: string;
  readonly metric?: string;
  /** The app's problem words: literal whole words per class (`problemPatterns`), else the defaults. */
  readonly words: Words;
}

/** Literal whole words that make a line an error or a warning; an empty list disables the class. */
export interface Words {
  readonly error: ReadonlyArray<string>;
  readonly warn: ReadonlyArray<string>;
}
export const DEFAULT_WORDS: Words = { error: ["error", "fatal", "panic", "exception", "critical"], warn: ["warn", "warning"] };

export interface Watcher {
  readonly app: string;
  readonly environment: string;
  readonly everyMs: number;
  readonly sources: ReadonlyArray<Source>;
}

export interface Config {
  readonly file: string;
  readonly dataDir: string;
  readonly port: number;
  readonly mcpToken: string | null;
  readonly opencode: { readonly url: string | null; readonly model: string | null; readonly password: string | null };
  readonly readings: number;
  readonly apps: Readonly<Record<string, { readonly checkout: string; readonly words: Words }>>;
  readonly watchers: ReadonlyArray<Watcher>;
  readonly sources: ReadonlyArray<Source>;
}

export class ConfigError extends Error {}

export function defaultConfigFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "overwatch", "config.json");
}

export function duration(text: unknown, where: string): number {
  const m = typeof text === "string" ? /^(\d+)(ms|s|m|h|d)$/.exec(text.trim()) : null;
  if (!m) throw new ConfigError(`${where} must be a duration such as "90s", "2m" or "1h"`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s"];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function keys(value: unknown, where: string, allowed: ReadonlyArray<string>, required: ReadonlyArray<string> = []): Record<string, unknown> {
  if (!isObject(value)) throw new ConfigError(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ConfigError(`${where}.${key} is not a setting (allowed: ${allowed.join(", ")})`);
  for (const key of required) if (value[key] === undefined) throw new ConfigError(`${where}.${key} is required`);
  return value;
}

const text = (value: unknown, where: string): string => {
  if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${where} must be a non-empty string`);
  return value;
};

const secretRef = (value: unknown, where: string): string => {
  const ref = text(value, where);
  if (!/^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^/]+\/.+)$/.test(ref)) throw new ConfigError(`${where} must be "env:NAME" or "keychain:service/account"`);
  return ref;
};

/** Parses and validates a configuration. Throws ConfigError with what to fix. */
export function parseConfig(raw: unknown, file: string): Config {
  const root = keys(raw, "config", ["version", "dataDir", "port", "mcpToken", "opencode", "apps", "watchers", "readings"], ["version", "apps", "watchers"]);
  if (root.version !== 2) throw new ConfigError("config.version must be 2 (this is the simple-core configuration)");
  const base = dirname(resolve(file));
  const path = (p: string) => (isAbsolute(p) ? p : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p));
  const port = root.port === undefined ? 7331 : root.port;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) throw new ConfigError("config.port must be 0 or a port number");
  const readings = root.readings === undefined ? 3 : root.readings;
  if (!Number.isInteger(readings) || (readings as number) < 1 || (readings as number) > 3) throw new ConfigError("config.readings must be 1, 2 or 3");
  const oc = root.opencode === undefined ? {} : keys(root.opencode, "config.opencode", ["url", "model", "password"]);
  if (oc.url !== undefined && !/^https?:\/\//.test(text(oc.url, "config.opencode.url"))) throw new ConfigError("config.opencode.url must be an http(s) URL");

  const apps: Record<string, { checkout: string; words: Words }> = {};
  const envSources = new Map<string, Source[]>();
  for (const [app, appValue] of Object.entries(keys(root.apps, "config.apps", Object.keys(isObject(root.apps) ? root.apps : {})))) {
    const a = keys(appValue, `apps.${app}`, ["checkout", "environments", "problemPatterns"], ["checkout", "environments"]);
    const patterns = a.problemPatterns === undefined ? {} : keys(a.problemPatterns, `apps.${app}.problemPatterns`, ["error", "warn"]);
    const words = (k: "error" | "warn") => {
      if (patterns[k] === undefined) return DEFAULT_WORDS[k];
      const list = patterns[k];
      if (!Array.isArray(list) || list.some((w) => typeof w !== "string" || !/^\S+$/.test(w) || w.length > 100) || list.length > 50)
        throw new ConfigError(`apps.${app}.problemPatterns.${k} must be a list of at most 50 nonempty words without spaces`);
      return list as string[];
    };
    apps[app] = { checkout: path(text(a.checkout, `apps.${app}.checkout`)), words: { error: words("error"), warn: words("warn") } };
    for (const [environment, envValue] of Object.entries(keys(a.environments, `apps.${app}.environments`, Object.keys(isObject(a.environments) ? a.environments : {})))) {
      const e = keys(envValue, `apps.${app}.environments.${environment}`, ["sources"], ["sources"]);
      const list: Source[] = [];
      for (const [name, sourceValue] of Object.entries(keys(e.sources, `apps.${app}.environments.${environment}.sources`, Object.keys(isObject(e.sources) ? e.sources : {})))) {
        const where = `apps.${app}.environments.${environment}.sources.${name}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)) throw new ConfigError(`${where}: a source name is letters, digits, "-" and "_"`);
        const s = keys(sourceValue, where, ["type", "context", "namespace", "selector", "readings", "baseUrl", "apiKey", "appKey", "query", "metric"], ["type"]);
        const kind = s.type;
        if (kind !== "kubernetes" && kind !== "datadog") throw new ConfigError(`${where}.type must be "kubernetes" or "datadog"`);
        const all: ReadonlyArray<string> = READINGS[kind];
        const chosen = s.readings === undefined ? [...all] : s.readings;
        if (!Array.isArray(chosen) || chosen.some((r) => !all.includes(r)) || new Set(chosen).size !== chosen.length)
          throw new ConfigError(`${where}.readings must list some of: ${all.join(", ")}`);
        const common = { id: `${app}/${environment}/${name}`, app, environment, name, kind: kind as "kubernetes" | "datadog", everyMs: 0, readings: chosen as string[], excluded: all.filter((r) => !chosen.includes(r)), checkout: apps[app].checkout, words: apps[app].words };
        if (kind === "kubernetes") {
          for (const k of ["baseUrl", "apiKey", "appKey", "query", "metric"]) if (s[k] !== undefined) throw new ConfigError(`${where}.${k} is a Datadog setting`);
          list.push({ ...common, context: text(s.context, `${where}.context`), namespace: text(s.namespace, `${where}.namespace`), selector: text(s.selector, `${where}.selector`) });
        } else {
          for (const k of ["context", "namespace", "selector"]) if (s[k] !== undefined) throw new ConfigError(`${where}.${k} is a Kubernetes setting`);
          const baseUrl = text(s.baseUrl ?? "https://api.datadoghq.com", `${where}.baseUrl`).replace(/\/+$/, "");
          if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) throw new ConfigError(`${where}.baseUrl must use https`);
          if ((chosen as string[]).includes("metrics") && s.metric === undefined) throw new ConfigError(`${where}.metric is required when metrics is read`);
          list.push({ ...common, baseUrl, apiKey: secretRef(s.apiKey, `${where}.apiKey`), appKey: secretRef(s.appKey, `${where}.appKey`), query: text(s.query, `${where}.query`), ...(s.metric !== undefined ? { metric: text(s.metric, `${where}.metric`) } : {}) });
        }
      }
      envSources.set(`${app}/${environment}`, list);
    }
  }

  if (!Array.isArray(root.watchers)) throw new ConfigError("config.watchers must be a list");
  if (root.watchers.length > LIMITS.watchers) throw new ConfigError(`config.watchers has ${root.watchers.length}; the limit is ${LIMITS.watchers}`);
  const watchers: Watcher[] = [];
  const seen = new Set<string>();
  root.watchers.forEach((value, i) => {
    const w = keys(value, `watchers[${i}]`, ["app", "environment", "every"], ["app", "environment"]);
    const key = `${text(w.app, `watchers[${i}].app`)}/${text(w.environment, `watchers[${i}].environment`)}`;
    if (seen.has(key)) throw new ConfigError(`watchers[${i}]: ${key} is watched twice`);
    seen.add(key);
    const list = envSources.get(key);
    if (!list) throw new ConfigError(`watchers[${i}]: there is no environment ${key} under apps`);
    if (list.length === 0) throw new ConfigError(`watchers[${i}]: ${key} has no sources`);
    if (list.length > LIMITS.sourcesPerWatcher) throw new ConfigError(`watchers[${i}]: ${key} has ${list.length} sources; the limit is ${LIMITS.sourcesPerWatcher}`);
    const everyMs = w.every === undefined ? (/^(prod|production)$/.test(String(w.environment)) ? 120_000 : 600_000) : duration(w.every, `watchers[${i}].every`);
    if (everyMs < LIMITS.minEveryMs) throw new ConfigError(`watchers[${i}].every is ${everyMs / 1000}s; the shortest polling interval is 60s`);
    watchers.push({ app: String(w.app), environment: String(w.environment), everyMs, sources: list.map((s) => ({ ...s, everyMs })) });
  });
  return {
    file: resolve(file),
    dataDir: path(typeof root.dataDir === "string" ? root.dataDir : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "overwatch")),
    port: port as number,
    mcpToken: root.mcpToken === undefined ? null : secretRef(root.mcpToken, "config.mcpToken"),
    opencode: {
      url: typeof oc.url === "string" ? oc.url.replace(/\/+$/, "") : null,
      model: oc.model === undefined ? null : text(oc.model, "config.opencode.model"),
      password: oc.password === undefined ? null : secretRef(oc.password, "config.opencode.password"),
    },
    readings: readings as number,
    apps,
    watchers,
    sources: watchers.flatMap((w) => w.sources),
  };
}

export function loadConfig(file: string): Config {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  try {
    return parseConfig(JSON.parse(raw), file);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${file} is not valid JSON`);
  }
}
