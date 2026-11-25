import { iso } from "../duration.ts";
import type { Options, SourceConfig } from "../options.ts";
import { redactText } from "../redact.ts";
import { resolveSecret } from "../secrets.ts";
import { normalizeMessage, type Occurrence, type Sample, type Signal } from "../signals.ts";
import { list, num, parseJson, pick, rec, records, text, time } from "../tolerant.ts";
import { emptyResult, str, type CollectResult, type SourceContext, type SourceType } from "./types.ts";

/** Statuses worth another try: rate limits and the gateway errors a busy or restarting API answers with. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const MAX_WAIT_MS = 60_000;

/** How long the response asks us to wait: `Retry-After` (seconds or a date) or Datadog's `X-RateLimit-Reset` (seconds). */
export function retryAfterMs(headers: Headers, now: number): number | undefined {
  for (const name of ["retry-after", "x-ratelimit-reset"]) {
    const value = headers.get(name)?.trim();
    if (!value) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return undefined;
}

async function keys(context: SourceContext): Promise<[string, string]> {
  const dd = context.options.datadog;
  if (!dd) throw new Error("datadog is not configured in the Overwatch options");
  // Resolved once per run: a keychain lookup is a process, and retries should not repeat it.
  const cached = context.scratch.get("datadog-keys") as Promise<[string, string]> | undefined;
  if (cached) return cached;
  const resolved = Promise.all([resolveSecret(dd.apiKey, context.exec), resolveSecret(dd.appKey, context.exec)]);
  context.scratch.set("datadog-keys", resolved);
  resolved.catch(() => context.scratch.delete("datadog-keys"));
  return resolved;
}

/**
 * Datadog through its HTTP API, read-only (search and list endpoints only).
 *
 * A rate limit (429), a gateway error (500, 502, 503, 504) or a dropped connection is retried up to five times,
 * waiting as long as the response asks (`Retry-After`, `X-RateLimit-Reset`) or backing off from one second, and
 * never past the slice's deadline. Anything else, and a retry that runs out, fails the slice so its checkpoint
 * stays put: an API that is down must not look like a quiet one.
 */
async function request(context: SourceContext, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const dd = context.options.datadog;
  if (!dd) throw new Error("datadog is not configured in the Overwatch options");
  const [apiKey, appKey] = await keys(context);
  const what = `Datadog ${path.split("?")[0]}`;
  for (let attempt = 1; ; attempt++) {
    const budget = Math.max(1_000, Math.min(context.options.timeouts.sourceMs, context.deadline - Date.now()));
    let problem: string;
    let wait: number | undefined;
    try {
      const response = await context.fetch(`${dd.apiUrl}${path}`, {
        method,
        headers: {
          "DD-API-KEY": apiKey,
          "DD-APPLICATION-KEY": appKey,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(budget)]),
      });
      const raw = await response.text();
      if (response.ok) {
        try {
          return parseJson(raw, what);
        } catch (error) {
          // A 200 that is not JSON is a proxy or sign-in page standing in for the API; retrying will not change it.
          throw new Error(`${error instanceof Error ? error.message : String(error)}; is a proxy or sign-in page answering for ${dd.apiUrl}?`);
        }
      }
      const detail = redactText(raw.replace(/\s+/g, " ").trim(), { maxBytes: 160 });
      if (!RETRYABLE.has(response.status)) {
        const hint = response.status === 401 || response.status === 403 ? " (check the Datadog keys and their scopes)" : "";
        throw new Error(`${what} returned HTTP ${response.status}${hint}${detail && !detail.startsWith("<") ? `: ${detail}` : ""}`);
      }
      problem = `HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}`;
      wait = retryAfterMs(response.headers, Date.now());
    } catch (error) {
      if (context.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Datadog ")) throw error;
      const name = error instanceof Error ? error.name : "";
      problem = name === "TimeoutError" || name === "AbortError" ? `no answer in ${Math.round(budget / 1000)}s` : `connection failed (${message})`;
    }
    if (attempt >= MAX_ATTEMPTS) throw new Error(`${what} failed ${attempt} times, last with ${problem}`);
    const delay = Math.min(MAX_WAIT_MS, wait ?? 1_000 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));
    if (Date.now() + delay >= context.deadline - 1_000) {
      throw new Error(`${what}: ${problem}; waiting ${Math.ceil(delay / 1000)}s to retry would run past this slice's time limit`);
    }
    await context.sleep(delay, context.signal);
    if (context.signal.aborted) throw new Error(`${what}: ${problem}; stopped while waiting to retry`);
  }
}

const appUrl = (options: Options) => `https://app.${options.datadog?.site ?? "datadoghq.com"}`;

interface LogEvent {
  readonly id: string;
  readonly at: number;
  readonly status: string;
  readonly service: string;
  readonly message: string;
}

const MAX_PAGES = 200;

async function searchLogs(
  context: SourceContext,
  query: string,
  indexes: ReadonlyArray<string> | undefined,
  from: number,
  to: number,
  max: number,
): Promise<{ events: LogEvent[]; capped: boolean; undated: number }> {
  const events: LogEvent[] = [];
  let undated = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await request(context, "POST", "/api/v2/logs/events/search", {
      filter: { query, from: iso(from), to: iso(to), ...(indexes?.length ? { indexes } : {}) },
      sort: "timestamp",
      page: { limit: Math.min(1000, max - events.length), ...(cursor ? { cursor } : {}) },
    });
    const data = records(pick(body, "data"));
    for (const item of data) {
      const attributes = rec(item.attributes);
      const nested = rec(attributes.attributes);
      const at = time(pick(attributes, "timestamp", "date") ?? pick(nested, "timestamp", "@timestamp", "date"));
      if (!Number.isFinite(at)) {
        undated++;
        continue;
      }
      events.push({
        id: text(item.id, `${at}:${events.length}`),
        at,
        status: text(pick(attributes, "status") ?? pick(nested, "status", "level")).toLowerCase(),
        service: text(pick(attributes, "service") ?? pick(nested, "service")),
        message: text(pick(attributes, "message", "msg") ?? pick(nested, "message", "msg") ?? pick(rec(nested.error), "message") ?? nested.error),
      });
    }
    const next = text(pick(pick(pick(body, "meta"), "page"), "after"));
    // An empty page or a cursor that does not move would otherwise page forever.
    if (!next || next === cursor || data.length === 0) return { events, capped: false, undated };
    cursor = next;
    if (events.length >= max) break;
  }
  return { events, capped: true, undated };
}

export const datadogLogsSource: SourceType = {
  type: "datadog-logs",
  queryHelp:
    'args: { query?: string, limit?: number }. Datadog log search between since and until; defaults to this source\'s query. Returns timestamped lines, newest last.',
  validate: (config, options) => [
    ...(typeof config.query === "string" && config.query ? [] : ['datadog-logs source needs "query", e.g. "service:api env:prod status:error"']),
    ...(options.datadog ? [] : ["datadog-logs needs the top-level datadog option"]),
  ],
  collect: async (config, { window }, context): Promise<CollectResult> => {
    const query = String(config.query);
    const indexes = Array.isArray(config.indexes) ? config.indexes.map(String) : undefined;
    const max = typeof config.maxLogs === "number" ? config.maxLogs : 5000;
    const { events, capped, undated } = await searchLogs(context, query, indexes, window.from, window.to, max);
    const groups = new Map<string, { base: Omit<Signal, "occurrences" | "total">; occurrences: Occurrence[]; total: number }>();
    for (const event of events) {
      const message = redactText(event.message, { maxBytes: 400 });
      const key = `log:${event.service}:${normalizeMessage(message)}`;
      const entry = groups.get(key) ?? {
        base: {
          source: context.name,
          kind: "log",
          key,
          title: message.split("\n")[0]!.slice(0, 120) || "(empty message)",
          severity: event.status.startsWith("warn") ? "warn" : "error",
          sample: `${iso(event.at)} ${event.service} ${event.status} ${message.split("\n")[0]}`,
          query,
          url: `${appUrl(context.options)}/logs?query=${encodeURIComponent(query)}&from_ts=${window.from}&to_ts=${window.to}`,
        },
        occurrences: [],
        total: 0,
      };
      entry.total++;
      if (entry.occurrences.length < 200) entry.occurrences.push({ at: event.at, id: event.id });
      groups.set(key, entry);
    }
    return {
      signals: [...groups.values()].map((g) => ({ ...g.base, occurrences: g.occurrences, total: g.total })),
      samples: [],
      notes: [
        ...(capped ? [`${context.name}: more than ${max} logs between ${iso(window.from)} and ${iso(window.to)}; only the first ${max} were grouped`] : []),
        ...(undated ? [`${context.name}: ${undated} log(s) had no readable timestamp and were not counted`] : []),
      ],
    };
  },
  query: async (config, input, context) => {
    const query = str(input.args.query) ?? String(config.query);
    const limit = Math.min(200, Number(input.args.limit ?? 50) || 50);
    const indexes = Array.isArray(config.indexes) ? config.indexes.map(String) : undefined;
    const { events, capped } = await searchLogs(context, query, indexes, input.since, input.until, limit);
    const lines = events.map((e) => `${iso(e.at)} ${e.service} ${e.status} ${e.message.split("\n")[0]}`);
    return redactText([`query: ${query}`, ...lines, ...(capped ? [`(more than ${limit} results; narrow the query)`] : [])].join("\n"), { maxBytes: 24_000 });
  },
};

const ALERTING = ["Alert", "Warn", "No Data"];

/** "No Data", "no_data" and "NO DATA" are the same state. */
const stateKey = (value: unknown) => text(value).toLowerCase().replace(/[^a-z]/g, "");

interface Monitor {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly modified: number;
  readonly query: string;
}

async function listMonitors(config: SourceConfig, context: SourceContext): Promise<Monitor[]> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  const params = new URLSearchParams({ group_states: "all", page_size: "1000" });
  if (tags.length) params.set("monitor_tags", tags.join(","));
  if (typeof config.name === "string") params.set("name", config.name);
  const body = await request(context, "GET", `/api/v1/monitor?${params}`);
  return records(Array.isArray(body) ? body : pick(body, "monitors", "data")).map((m) => ({
    id: text(m.id),
    name: text(m.name, "(unnamed monitor)"),
    state: text(pick(m, "overall_state", "overallState"), "Unknown"),
    modified: time(pick(m, "overall_state_modified", "overallStateModified")),
    query: text(m.query),
  }));
}

export const datadogMonitorsSource: SourceType = {
  type: "datadog-monitors",
  queryHelp: "args: {}. Lists the monitors this source watches with their current state and query.",
  validate: (config, options) => [
    ...(Array.isArray(config.tags) || typeof config.name === "string" ? [] : ['datadog-monitors source needs "tags" or "name"']),
    ...(options.datadog ? [] : ["datadog-monitors needs the top-level datadog option"]),
  ],
  collect: async (config, { window, final }, context) => {
    // Monitor state is current state; it is read once per run, in the newest slice.
    if (!final) return emptyResult;
    const states = (Array.isArray(config.states) ? config.states : ALERTING).map(stateKey);
    const signals: Signal[] = (await listMonitors(config, context))
      .filter((m) => m.id && states.includes(stateKey(m.state)))
      .map((m) => ({
        source: context.name,
        kind: "monitor",
        key: `monitor:${m.id}`,
        title: `${m.name.slice(0, 100)} is ${m.state}`,
        severity: stateKey(m.state) === "warn" ? "warn" : "error",
        occurrences: Number.isFinite(m.modified) ? [{ at: m.modified, id: `${m.id}:${m.modified}` }] : [],
        total: 1,
        state: true,
        sample: `monitor ${m.id} "${m.name}" ${m.state} since ${Number.isFinite(m.modified) ? iso(m.modified) : "unknown"}: ${redactText(m.query, { maxBytes: 300 })}`,
        query: m.query,
        url: `${appUrl(context.options)}/monitors/${m.id}`,
      }));
    return { signals, samples: [], notes: [] };
  },
  query: async (config, _input, context) => {
    const lines = (await listMonitors(config, context)).map(
      (m) => `${m.id} [${m.state}] ${m.name}\n  query: ${m.query}\n  modified: ${Number.isFinite(m.modified) ? iso(m.modified) : "?"}`,
    );
    return redactText(lines.join("\n") || "No monitors match.", { maxBytes: 24_000 });
  },
};

/** Points of a metric query. With several series (a query grouped by a tag) each timestamp keeps its highest value. */
async function queryMetric(context: SourceContext, query: string, from: number, to: number): Promise<{ points: Array<{ at: number; value: number }>; series: number }> {
  const params = new URLSearchParams({ from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)), query });
  const body = await request(context, "GET", `/api/v1/query?${params}`);
  if (text(pick(body, "status")).toLowerCase() === "error") {
    throw new Error(`Datadog rejected the metric query "${query.slice(0, 80)}": ${redactText(text(pick(body, "error", "errors")), { maxBytes: 200 })}`);
  }
  const series = records(pick(body, "series"));
  const worst = new Map<number, number>();
  for (const entry of series) {
    for (const point of list(pick(entry, "pointlist"))) {
      const [rawAt, rawValue] = Array.isArray(point) ? point : [];
      const at = time(rawAt);
      const value = num(rawValue);
      if (!Number.isFinite(at) || value === undefined) continue;
      worst.set(at, Math.max(worst.get(at) ?? Number.NEGATIVE_INFINITY, value));
    }
  }
  return { points: [...worst.entries()].sort((a, b) => a[0] - b[0]).map(([at, value]) => ({ at, value })), series: series.length };
}

export const datadogMetricsSource: SourceType = {
  type: "datadog-metrics",
  queryHelp: 'args: { query: string }. Datadog metric query between since and until; returns timestamped points.',
  validate: (config, options) => [
    ...(config.queries && typeof config.queries === "object" && Object.keys(config.queries).length
      ? []
      : ['datadog-metrics source needs "queries": { "<metric name>": "<datadog query>" }']),
    ...(options.datadog ? [] : ["datadog-metrics needs the top-level datadog option"]),
  ],
  collect: async (config, { window }, context) => {
    const samples: Sample[] = [];
    const notes: string[] = [];
    for (const [metric, query] of Object.entries(rec(config.queries))) {
      const result = await queryMetric(context, text(query), window.from, window.to);
      for (const point of result.points) samples.push({ metric, ...point });
      if (result.series > 1) notes.push(`${context.name}: ${metric} returned ${result.series} series; the highest value at each time is used`);
    }
    return { signals: [], samples, notes };
  },
  query: async (_config, input, context) => {
    const query = str(input.args.query);
    if (!query) return "Pass args.query.";
    const { points } = await queryMetric(context, query, input.since, input.until);
    return points.slice(-200).map((p) => `${iso(p.at)} ${p.value}`).join("\n") || "No datapoints.";
  },
};
