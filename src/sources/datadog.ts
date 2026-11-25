import { iso } from "../duration.ts";
import type { Options, SourceConfig } from "../options.ts";
import { redactText } from "../redact.ts";
import { resolveSecret } from "../secrets.ts";
import { normalizeMessage, type Occurrence, type Sample, type Signal } from "../signals.ts";
import { emptyResult, str, type CollectResult, type SourceContext, type SourceType } from "./types.ts";

/** Datadog through its HTTP API, read-only (search and list endpoints only). */
async function request(context: SourceContext, method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const dd = context.options.datadog;
  if (!dd) throw new Error("datadog is not configured in the Overwatch options");
  const [apiKey, appKey] = await Promise.all([resolveSecret(dd.apiKey, context.exec), resolveSecret(dd.appKey, context.exec)]);
  const response = await context.fetch(`${dd.apiUrl}${path}`, {
    method,
    headers: {
      "DD-API-KEY": apiKey,
      "DD-APPLICATION-KEY": appKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(context.options.timeouts.sourceMs)]),
  });
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? " (check the Datadog keys)" : response.status === 429 ? " (rate limited)" : "";
    throw new Error(`Datadog ${path} returned HTTP ${response.status}${hint}`);
  }
  return response.json();
}

const appUrl = (options: Options) => `https://app.${options.datadog?.site ?? "datadoghq.com"}`;

interface LogEvent {
  readonly id: string;
  readonly at: number;
  readonly status: string;
  readonly service: string;
  readonly message: string;
}

async function searchLogs(
  context: SourceContext,
  query: string,
  indexes: ReadonlyArray<string> | undefined,
  from: number,
  to: number,
  max: number,
): Promise<{ events: LogEvent[]; capped: boolean }> {
  const events: LogEvent[] = [];
  let cursor: string | undefined;
  do {
    const body = await request(context, "POST", "/api/v2/logs/events/search", {
      filter: { query, from: iso(from), to: iso(to), ...(indexes?.length ? { indexes } : {}) },
      sort: "timestamp",
      page: { limit: Math.min(1000, max - events.length), ...(cursor ? { cursor } : {}) },
    });
    for (const item of body?.data ?? []) {
      const attributes = item.attributes ?? {};
      events.push({
        id: String(item.id),
        at: Date.parse(attributes.timestamp),
        status: String(attributes.status ?? ""),
        service: String(attributes.service ?? ""),
        message: String(attributes.message ?? attributes.attributes?.message ?? attributes.attributes?.error?.message ?? ""),
      });
    }
    cursor = body?.meta?.page?.after;
  } while (cursor && events.length < max);
  return { events, capped: Boolean(cursor) };
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
    const { events, capped } = await searchLogs(context, query, indexes, window.from, window.to, max);
    const groups = new Map<string, { base: Omit<Signal, "occurrences" | "total">; occurrences: Occurrence[]; total: number }>();
    for (const event of events) {
      if (!Number.isFinite(event.at)) continue;
      const message = redactText(event.message, { maxBytes: 400 });
      const key = `log:${event.service}:${normalizeMessage(message)}`;
      const entry = groups.get(key) ?? {
        base: {
          source: context.name,
          kind: "log",
          key,
          title: message.split("\n")[0]!.slice(0, 120) || "(empty message)",
          severity: event.status === "warn" || event.status === "warning" ? "warn" : "error",
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
      notes: capped ? [`${context.name}: more than ${max} logs between ${iso(window.from)} and ${iso(window.to)}; only the first ${max} were grouped`] : [],
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

async function listMonitors(config: SourceConfig, context: SourceContext): Promise<Array<Record<string, any>>> {
  const tags = Array.isArray(config.tags) ? config.tags.map(String) : [];
  const params = new URLSearchParams({ group_states: "all", page_size: "1000" });
  if (tags.length) params.set("monitor_tags", tags.join(","));
  if (typeof config.name === "string") params.set("name", config.name);
  const body = await request(context, "GET", `/api/v1/monitor?${params}`);
  return Array.isArray(body) ? body : [];
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
    const states = Array.isArray(config.states) ? config.states.map(String) : ALERTING;
    const signals: Signal[] = (await listMonitors(config, context))
      .filter((m) => states.includes(String(m.overall_state)))
      .map((m) => {
        const modified = Date.parse(m.overall_state_modified ?? "");
        return {
          source: context.name,
          kind: "monitor",
          key: `monitor:${m.id}`,
          title: `${String(m.name).slice(0, 100)} is ${m.overall_state}`,
          severity: m.overall_state === "Warn" ? "warn" : "error",
          occurrences: Number.isFinite(modified) ? [{ at: modified, id: `${m.id}:${modified}` }] : [],
          total: 1,
          state: true,
          sample: `monitor ${m.id} "${m.name}" ${m.overall_state} since ${Number.isFinite(modified) ? iso(modified) : "unknown"}: ${redactText(String(m.query ?? ""), { maxBytes: 300 })}`,
          query: String(m.query ?? ""),
          url: `${appUrl(context.options)}/monitors/${m.id}`,
        };
      });
    return { signals, samples: [], notes: [] };
  },
  query: async (config, _input, context) => {
    const lines = (await listMonitors(config, context)).map(
      (m) => `${m.id} [${m.overall_state}] ${m.name}\n  query: ${m.query}\n  modified: ${m.overall_state_modified ?? "?"}`,
    );
    return redactText(lines.join("\n") || "No monitors match.", { maxBytes: 24_000 });
  },
};

async function queryMetric(context: SourceContext, query: string, from: number, to: number): Promise<Array<{ at: number; value: number }>> {
  const params = new URLSearchParams({ from: String(Math.floor(from / 1000)), to: String(Math.floor(to / 1000)), query });
  const body = await request(context, "GET", `/api/v1/query?${params}`);
  const points: Array<[number | null, number | null]> = body?.series?.[0]?.pointlist ?? [];
  return points.flatMap(([at, value]) =>
    typeof at === "number" && typeof value === "number" && Number.isFinite(value) ? [{ at, value }] : [],
  );
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
    for (const [metric, query] of Object.entries(config.queries as Record<string, string>)) {
      for (const point of await queryMetric(context, String(query), window.from, window.to)) samples.push({ metric, ...point });
    }
    return { signals: [], samples, notes: [] };
  },
  query: async (_config, input, context) => {
    const query = str(input.args.query);
    if (!query) return "Pass args.query.";
    const points = await queryMetric(context, query, input.since, input.until);
    return points.slice(-200).map((p) => `${iso(p.at)} ${p.value}`).join("\n") || "No datapoints.";
  },
};
