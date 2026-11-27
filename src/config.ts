/**
 * The configuration file: its grammar and the operating limits `check` enforces (specification section 10). Keys
 * outside the grammar, duplicate watchers and anything beyond a limit are refused, offline, before anything runs.
 */
import { Context, Effect, FileSystem, Layer, Predicate, Schema, SchemaGetter } from "effect";
import { ConfigError } from "./errors.ts";
import { setRedactPatterns } from "./redact.ts";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const LIMITS = {
  watchers: 50, sourcesPerWatcher: 4, minEveryMs: 60_000, occurrencesPerSlice: 50_000, problemsPerSlice: 500,
  bytesPerPodCall: 4 * 1024 * 1024, podsPerSource: 20, overlapMs: { kubernetes: 120_000, datadog: 300_000 },
  catchUpMs: 14 * 86_400_000, sliceMs: 6 * 3_600_000, retryAfterMaxS: 30, retryAfterTimes: 2, probeMs: 300_000,
  wakeDelayMs: 5_000, freshIntervals: 3, freeFloorBytes: 256 * 1024 ** 2, databaseBudgetBytes: 1024 ** 3,
  reclaimBytes: 16 * 1024 ** 2, quietIntervals: 3, linesPerProblem: 200, pieceBytes: 16_384, piecesPerSession: 400,
  toolCallsPerRun: 8, runActiveMs: 300_000, concurrentJobs: 2,
} as const;

export const READINGS = { kubernetes: ["logs", "events", "workloads", "usage"], datadog: ["logs", "monitors", "metrics"] } as const;
export const DATADOG_READINGS = ["logs", "monitors", "metrics", "spans"] as const;
export type Kind = keyof typeof READINGS;

export interface SpanPolicy { readonly slowMs: number; readonly warnMs?: number; readonly query?: string }
export interface CommitWatch { readonly branch?: string; readonly paths?: ReadonlyArray<string>; readonly limit?: number }
export interface Source {
  readonly id: string; readonly app: string; readonly environment: string; readonly name: string; readonly kind: Kind;
  readonly everyMs: number; readonly readings: ReadonlyArray<string>; readonly excluded: ReadonlyArray<string>; readonly checkout: string;
  readonly context?: string; readonly namespace?: string; readonly selector?: string;
  readonly baseUrl?: string; readonly apiKey?: string; readonly appKey?: string; readonly query?: string; readonly metric?: string;
  readonly words: Words;
  readonly capacity?: { readonly resource: "disk" | "memory" | "quota"; readonly unit: "bytes" | "units"; readonly limit: number };
  readonly spans?: SpanPolicy;
}
export interface Fixes { readonly remote: string; readonly base: string; readonly paths: ReadonlyArray<string>; readonly verify: ReadonlyArray<ReadonlyArray<string>>; readonly mode?: "propose" | "draft_pr" }
/** Files a fix may never touch, whatever the allowlist says: build, dependency, CI, hooks and credential files. */
export const FORBIDDEN = /(^|\/)(\.git|\.github|\.gitlab-ci\.yml|\.circleci|\.husky|\.buildkite)(\/|$)|(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|pyproject\.toml|Makefile|Dockerfile|Jenkinsfile|[^/]*\.gradle(\.kts)?|pom\.xml|\.env[^/]*|[^/]*\.(pem|key|p12)|credentials[^/]*|\.npmrc)$/;
export interface Words { readonly error: ReadonlyArray<string>; readonly warn: ReadonlyArray<string> }
export const DEFAULT_WORDS: Words = { error: ["error", "fatal", "panic", "exception", "critical"], warn: ["warn", "warning"] };
export interface Watcher { readonly app: string; readonly environment: string; readonly everyMs: number; readonly sources: ReadonlyArray<Source> }
export interface Config {
  readonly file: string; readonly dataDir: string; readonly port: number; readonly mcpToken: string | null;
  readonly opencode: { readonly url: string | null; readonly model: string | null; readonly password: string | null; readonly concurrency: number; readonly toolCalls: number; readonly genUi: boolean };
  readonly readings: number; readonly redactPatterns: ReadonlyArray<string>;
  readonly apps: Readonly<Record<string, { readonly checkout: string; readonly words: Words; readonly fixes?: Fixes; readonly promotion?: { readonly staging: string; readonly production: string }; readonly commitWatch?: CommitWatch }>>;
  readonly watchers: ReadonlyArray<Watcher>; readonly sources: ReadonlyArray<Source>;
}

export { ConfigError };

export function defaultConfigFile(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "overwatch", "config.json");
}

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** A duration such as "90s", "2m" or "1h", in milliseconds. */
export const Duration = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\s*\d+(ms|s|m|h|d)\s*$/, { message: 'must be a duration such as "90s", "2m" or "1h"' })),
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((text: string) => {
      const m = /^(\d+)(ms|s|m|h|d)$/.exec(text.trim())!;
      return Number(m[1]) * UNITS[m[2] as keyof typeof UNITS]; }),
    encode: SchemaGetter.transform((ms: number) => `${ms}ms`),}));
export function duration(text: unknown, where: string): number {
  const decoded = Schema.decodeUnknownOption(Duration)(text);
  if (decoded._tag === "None") throw new ConfigError({ message: `${where} must be a duration such as "90s", "2m" or "1h"` });
  return decoded.value;
}

// ---- The grammar, as schemas. Unknown keys are refused (`onExcessProperty: "error"`); each check says what to fix.
const Text = Schema.String.pipe(Schema.check(Schema.makeFilter((s: string) => s.trim() !== "", { message: "must be a non-empty string" })));
const SecretRef = Text.pipe(Schema.check(Schema.isPattern(/^(env:[A-Za-z_][A-Za-z0-9_]*|keychain:[^/]+\/.+)$/, { message: 'must be "env:NAME" or "keychain:service/account"' })));
const GitName = Text.pipe(Schema.check(Schema.makeFilter((t: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(t) && !t.includes(".."), { message: "must be a Git name" })));
const Word = Schema.String.pipe(Schema.check(Schema.isPattern(/^\S{1,100}$/)));
const Words = Schema.Array(Word).pipe(Schema.check(Schema.isMaxLength(50)), Schema.annotate({ message: "must be a list of at most 50 nonempty words without spaces" }));
const FixPath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (p: string) => /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,200}$/.test(p) && !p.split("/").includes("..") && !p.endsWith("/") && !FORBIDDEN.test(p),
      { message: "is not an exact repository-relative file a fix may change" })));
const Argv = Schema.Array(Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)))).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.annotate({ message: "each command is a list of nonempty strings" }));
const RedactPattern = Text.pipe(Schema.check(Schema.isMaxLength(300), Schema.makeFilter((p: string) => { try { new RegExp(p, "g"); return true; } catch { return false; } }, { message: "must be a valid regular expression" })));
const FixesConfig = Schema.Struct({
  remote: GitName, base: GitName,
  paths: Schema.Array(FixPath).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10, { message: "must list 1 to 10 files" }))),
  verify: Schema.Array(Argv).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4, { message: "must list 1 to 4 commands" }))),
  mode: Schema.optionalKey(Schema.Literals(["propose", "draft_pr"]).annotate({ message: 'is "propose" or "draft_pr"' })),
}).pipe(Schema.check(Schema.makeFilter((f) => !f.verify.some((argv) => argv.some((a) => f.paths.includes(a))), { message: "verify: a verify input cannot also be a file a fix may change" })));

const PosNum = Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.annotate({ message: "is a positive number" }));
const Capacity = Schema.Struct({ resource: Schema.Literals(["disk", "memory", "quota"]).annotate({ message: "is disk, memory or quota" }), unit: Schema.Literals(["bytes", "units"]).annotate({ message: "is bytes or units" }), limit: PosNum });
const SpansConfig = Schema.Struct({ slowMs: PosNum, warnMs: Schema.optionalKey(PosNum), query: Schema.optionalKey(Text) });
const CommitWatchConfig = Schema.Struct({ branch: Schema.optionalKey(GitName), paths: Schema.optionalKey(Schema.Array(Text).pipe(Schema.check(Schema.isMaxLength(50)))), limit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 })))) });
const KubeSource = Schema.Struct({
  type: Schema.Literal("kubernetes"), context: Text, namespace: Text, selector: Text,
  readings: Schema.optionalKey(Schema.Array(Schema.Literals(READINGS.kubernetes)).pipe(Schema.check(Schema.isUnique()), Schema.annotate({ message: `must list some of: ${READINGS.kubernetes.join(", ")}` }))), });
const DatadogSource = Schema.Struct({
  type: Schema.Literal("datadog"), baseUrl: Schema.optionalKey(Text), apiKey: SecretRef, appKey: SecretRef, query: Text,
  metric: Schema.optionalKey(Text), capacity: Schema.optionalKey(Capacity), spans: Schema.optionalKey(SpansConfig),
  readings: Schema.optionalKey(Schema.Array(Schema.Literals(DATADOG_READINGS)).pipe(Schema.check(Schema.isUnique()), Schema.annotate({ message: `must list some of: ${DATADOG_READINGS.join(", ")}` }))), });
const SourceConfig = Schema.Union([KubeSource, DatadogSource]).annotate({ message: 'must be a Kubernetes source (type "kubernetes": context, namespace, selector) or a Datadog source (type "datadog": apiKey, appKey, query)' });
const SourceName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/, { message: 'a source name is letters, digits, "-" and "_"' })));
const AppConfigFile = Schema.Struct({
  checkout: Text,
  environments: Schema.Record(Schema.String, Schema.Struct({ sources: Schema.Record(SourceName, SourceConfig) })),
  problemPatterns: Schema.optionalKey(Schema.Struct({ error: Schema.optionalKey(Words), warn: Schema.optionalKey(Words) })),
  fixes: Schema.optionalKey(FixesConfig),
  promotion: Schema.optionalKey(Schema.Struct({ staging: Text, production: Text })),
  commitWatch: Schema.optionalKey(CommitWatchConfig), });
const WatcherConfig = Schema.Struct({ app: Text, environment: Text, every: Schema.optionalKey(Duration) });
/** The configuration file as written, version 2. */
export const ConfigFile = Schema.Struct({
  version: Schema.Literal(2).annotate({ message: "must be 2 (this is the simple-core configuration)" }),
  extends: Schema.optionalKey(Schema.Union([Text, Schema.Array(Text).pipe(Schema.check(Schema.isMaxLength(10)))])),
  dataDir: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 65_535 })), Schema.annotate({ message: "must be 0 or a port number" }))),
  mcpToken: Schema.optionalKey(SecretRef),
  redactPatterns: Schema.optionalKey(Schema.Array(RedactPattern).pipe(Schema.check(Schema.isMaxLength(50)))),
  opencode: Schema.optionalKey(Schema.Struct({
    url: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\//, { message: "must be an http(s) URL" })))),
    model: Schema.optionalKey(Text), password: Schema.optionalKey(SecretRef),
    concurrency: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 6 })), Schema.annotate({ message: "must be 1 to 6" }))),
    toolCalls: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 8, maximum: 24 })), Schema.annotate({ message: "must be 8 to 24" }))),
    genUi: Schema.optionalKey(Schema.Boolean), })),
  readings: Schema.optionalKey(Schema.Literals([1, 2, 3, 5]).annotate({ message: "must be 1, 2, 3 or 5" })),
  apps: Schema.Record(Schema.String, AppConfigFile),
  watchers: Schema.Array(WatcherConfig).annotate({ message: "must be a list" }), });
export type ConfigFile = typeof ConfigFile.Type;

const validate = Schema.toStandardSchemaV1(ConfigFile, { parseOptions: { onExcessProperty: "error", errors: "first" } });

/** The first problem in a configuration, as `config.apps.shop.checkout must be a non-empty string`. */
function decodeFile(raw: unknown): ConfigFile {
  const result = validate["~standard"].validate(raw);
  if (result instanceof Promise) throw new Error("the configuration schema is synchronous");
  if (!result.issues) return result.value;
  const issue = result.issues[0]!;
  const segments = (issue.path ?? []).map((p) => String(Predicate.isObject(p) && "key" in p ? p.key : p));
  const where = ["config", ...segments].join(".").replace(/^config\.watchers\.(\d+)/, "watchers[$1]").replace(/^config\.apps\./, "apps.");
  const message = issue.message.startsWith("Expected") || issue.message.startsWith("Missing") || issue.message.startsWith("Unexpected") ? `: ${issue.message}` : ` ${issue.message}`;
  throw new ConfigError({ message: `${where}${message}` });
}

/** Parses and validates a configuration. Throws ConfigError with what to fix. */
export function parseConfig(raw: unknown, file: string): Config {
  const root = decodeFile(raw);
  const base = dirname(resolve(file));
  const path = (p: string) => (isAbsolute(p) ? p : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p));
  const fail = (message: string): never => {
    throw new ConfigError({ message });
  };

  const apps: Record<string, { checkout: string; words: Words; fixes?: Fixes; promotion?: { staging: string; production: string }; commitWatch?: CommitWatch }> = {};
  const envSources = new Map<string, Source[]>();
  for (const [app, a] of Object.entries(root.apps)) {
    const words: Words = { error: a.problemPatterns?.error ?? DEFAULT_WORDS.error, warn: a.problemPatterns?.warn ?? DEFAULT_WORDS.warn };
    apps[app] = { checkout: path(a.checkout), words, ...(a.fixes ? { fixes: a.fixes } : {}), ...(a.commitWatch ? { commitWatch: a.commitWatch } : {}) };
    if (a.promotion) {
      if (a.promotion.staging === a.promotion.production) fail(`apps.${app}.promotion names the same environment twice`);
      apps[app]!.promotion = a.promotion;
    }
    for (const [environment, e] of Object.entries(a.environments)) {
      const list: Source[] = [];
      for (const [name, s] of Object.entries(e.sources)) {
        const where = `apps.${app}.environments.${environment}.sources.${name}`;
        const all: ReadonlyArray<string> = READINGS[s.type];
        const chosen: ReadonlyArray<string> = s.readings ?? (s.type === "datadog" && s.spans ? [...all, "spans"] : all);
        const common = { id: `${app}/${environment}/${name}`, app, environment, name, kind: s.type, everyMs: 0, readings: [...chosen], excluded: all.filter((r) => !chosen.includes(r)), checkout: apps[app]!.checkout, words };
        if (s.type === "kubernetes") {
          list.push({ ...common, context: s.context, namespace: s.namespace, selector: s.selector });
        } else {
          const baseUrl = (s.baseUrl ?? "https://api.datadoghq.com").replace(/\/+$/, "");
          if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(baseUrl)) fail(`${where}.baseUrl must use https`);
          if (chosen.includes("metrics") && s.metric === undefined) fail(`${where}.metric is required when metrics is read`);
          if (s.capacity && !chosen.includes("metrics")) fail(`${where}.capacity needs the metrics reading`);
          if (chosen.includes("spans") && !s.spans) fail(`${where}.spans is required when spans is read`);
          if (s.spans?.warnMs !== undefined && s.spans.warnMs >= s.spans.slowMs) fail(`${where}.spans.warnMs must be less than slowMs`);
          list.push({ ...common, baseUrl, apiKey: s.apiKey, appKey: s.appKey, query: s.query, ...(s.metric !== undefined ? { metric: s.metric } : {}), ...(s.capacity ? { capacity: s.capacity } : {}), ...(s.spans ? { spans: s.spans } : {}) });
        }}
      envSources.set(`${app}/${environment}`, list);
    }}

  if (root.watchers.length > LIMITS.watchers) fail(`config.watchers has ${root.watchers.length}; the limit is ${LIMITS.watchers}`);
  const watchers: Watcher[] = [];
  const seen = new Set<string>();
  root.watchers.forEach((w, i) => {
    const key = `${w.app}/${w.environment}`;
    if (seen.has(key)) fail(`watchers[${i}]: ${key} is watched twice`);
    seen.add(key);
    const list = envSources.get(key) ?? fail(`watchers[${i}]: there is no environment ${key} under apps`);
    if (list.length === 0) fail(`watchers[${i}]: ${key} has no sources`);
    if (list.length > LIMITS.sourcesPerWatcher) fail(`watchers[${i}]: ${key} has ${list.length} sources; the limit is ${LIMITS.sourcesPerWatcher}`);
    const everyMs = w.every ?? (/^(prod|production)$/.test(w.environment) ? 120_000 : 600_000);
    if (everyMs < LIMITS.minEveryMs) fail(`watchers[${i}].every is ${everyMs / 1000}s; the shortest polling interval is 60s`);
    watchers.push({ app: w.app, environment: w.environment, everyMs, sources: list.map((s) => ({ ...s, everyMs })) }); });
  for (const [app, a] of Object.entries(apps)) {
    if (!a.promotion) continue;
    const every = (env: string) => watchers.find((w) => w.app === app && w.environment === env)?.everyMs;
    const [st, pr] = [every(a.promotion.staging), every(a.promotion.production)];
    if (st === undefined || pr === undefined) fail(`apps.${app}.promotion must name two watched environments of ${app}`);
    if (st !== pr) fail(`apps.${app}.promotion: ${a.promotion.staging} and ${a.promotion.production} must be polled at the same interval`);
  }
  const redactPatterns = root.redactPatterns ?? [];
  setRedactPatterns(redactPatterns);
  return {
    file: resolve(file),
    dataDir: path(root.dataDir ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "overwatch")),
    port: root.port ?? 7331, mcpToken: root.mcpToken ?? null, redactPatterns,
    opencode: {
      url: root.opencode?.url !== undefined ? root.opencode.url.replace(/\/+$/, "") : null,
      model: root.opencode?.model ?? null, password: root.opencode?.password ?? null,
      concurrency: root.opencode?.concurrency ?? LIMITS.concurrentJobs,
      toolCalls: root.opencode?.toolCalls ?? LIMITS.toolCallsPerRun,
      genUi: root.opencode?.genUi ?? false, },
    readings: root.readings ?? 3, apps, watchers, sources: watchers.flatMap((w) => w.sources), };
}

const isRecord = (v: unknown): v is Record<string, unknown> => Predicate.isObject(v) && !Array.isArray(v);
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isRecord(v) && isRecord(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** Reads and validates the configuration file, resolving any `extends` base layers offline. */
export const loadConfig = (file: string): Effect.Effect<Config, ConfigError, FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const readLayer = (target: string, seen: Set<string>): Effect.Effect<Record<string, unknown>, ConfigError> => Effect.gen(function* () {
    const abs = resolve(target);
    if (seen.has(abs)) return yield* new ConfigError({ message: `circular extends in ${abs}` });
    const raw = yield* fs.readFileString(abs).pipe(Effect.mapError((e) => new ConfigError({ message: `cannot read ${abs}: ${e.reason._tag === "NotFound" ? "ENOENT" : e.reason._tag}` })));
    const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw).pipe(Effect.mapError(() => new ConfigError({ message: `${abs} is not valid JSON` })));
    if (!isRecord(value)) return value as unknown as Record<string, unknown>;
    const ext = value.extends;
    if (ext === undefined) return value;
    const refs = typeof ext === "string" ? [ext] : Array.isArray(ext) && ext.every((x) => typeof x === "string") ? ext : null;
    if (!refs) return yield* new ConfigError({ message: `config.extends must be a path or list of paths` });
    const next = new Set(seen).add(abs);
    let merged: Record<string, unknown> = {};
    for (const ref of refs) merged = deepMerge(merged, yield* readLayer(resolve(dirname(abs), ref), next));
    const { extends: _, ...rest } = value;
    return deepMerge(merged, rest);
  });
  const merged = yield* readLayer(file, new Set());
  return yield* Effect.try({ try: () => parseConfig(merged, file), catch: (e) => (e instanceof ConfigError ? e : new ConfigError({ message: String(e) })) });
});

/** The configuration this process runs with, as a service: read with `yield* AppConfig`. */
export class AppConfig extends Context.Service<AppConfig, Config>()("overwatch/AppConfig") {
  static readonly layer = (config: Config) => {
    setRedactPatterns(config.redactPatterns);
    return Layer.succeed(AppConfig, config);
  };
}
