/**
 * Datadog through its HTTP API: v2 logs search (paginated to the end), v1 monitors and a v1 metric query. Keys go
 * in request headers only, and are `Redacted` everywhere else. A rate limit's Retry-After is honoured up to 30
 * seconds, at most twice per read; beyond that the read fails as rate-limited and its checkpoint does not move.
 *
 * Replies are decoded by Schema, tolerantly: a reply is complete only when its recognised parts say so, and a part of
 * the wrong kind is absent, so it makes the reading a gap rather than a failure.
 */
import { Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { LIMITS, type Source } from "./config.ts";
import { secret } from "./exec.ts";
import { num, sDecode as decode, sField as field, sList as list, sObj as object, sText as text, sUnknown as unknown, time, type ProviderTime } from "./parse.ts";

/** Datadog refused or could not be reached: the HTTP status (0 when unreachable), and for a rate limit its wait. */
export class HttpFailure extends Schema.TaggedError<HttpFailure>()("HttpFailure", {
  status: Schema.Number,
  message: Schema.String,
  /** Seconds the provider asked to wait (a 429 only); Infinity when it gave no readable number. */
  retryAfterS: Schema.optional(Schema.Number),
}) {}

export type Requirements = HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner;

/** A 429 whose wait Overwatch honours: a readable number up to `retryAfterMaxS`, at most `retryAfterTimes` times. */
const rateLimited = Schedule.recurs(LIMITS.retryAfterTimes).pipe(
  Schedule.setInputType<HttpFailure>(),
  Schedule.while(({ input }) => input.status === 429 && input.retryAfterS !== undefined && Number.isFinite(input.retryAfterS) && input.retryAfterS <= LIMITS.retryAfterMaxS),
  Schedule.modifyDelay(({ input }) => Effect.succeed(Duration.seconds(Math.max(0, input.retryAfterS ?? 0)))));

const request = Effect.fnUntraced(function* (source: Source, path: string, body?: unknown) {
  const apiKey = yield* secret(source.apiKey!), appKey = yield* secret(source.appKey!);
  if (!apiKey || !appKey) return yield* new HttpFailure({ status: 401, message: `Datadog keys are not set: ${source.apiKey} and ${source.appKey}` });
  const client = yield* HttpClient.HttpClient;
  const url = source.baseUrl + path;
  const req = (body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
    HttpClientRequest.setHeaders({ "DD-API-KEY": Redacted.value(apiKey), "DD-APPLICATION-KEY": Redacted.value(appKey), "content-type": "application/json" }),
    HttpClientRequest.acceptJson);
  const once = Effect.gen(function* () {
    const response = yield* client.execute(req).pipe(
      Effect.timeoutOrElse({ duration: "60 seconds", orElse: () => Effect.fail(new Error("The operation was aborted due to timeout")) }),
      Effect.mapError((error) => new HttpFailure({ status: 0, message: `Datadog unreachable: ${error.message}` })));
    if (response.status === 429) {
      const wait = num(response.headers["retry-after"]) ?? Infinity;
      return yield* new HttpFailure({ status: 429, message: `Datadog rate limit (retry after ${wait}s)`, retryAfterS: wait });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new HttpFailure({ status: response.status, message: `Datadog answered ${response.status} for ${path.split("?")[0]}` });
    }
    // A body that is not JSON is not a reply at all: the read fails, as a malformed answer did before.
    return yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
      Effect.mapError(() => new HttpFailure({ status: 0, message: "Datadog answered something that is not JSON" }))); });
  return yield* once.pipe(Effect.retry(rateLimited)); });

export interface DatadogLog { readonly id: string | null; readonly at: ProviderTime | null; readonly message: string; readonly status: string }

const LogPage = object({
  data: field(Schema.Array(object({ id: text, attributes: field(object({ timestamp: unknown, message: field(Schema.String), status: text })) }))),
  meta: field(object({ status: unknown, warnings: field(Schema.Array(Schema.Unknown)), page: field(object({ after: field(Schema.NonEmptyString) })) })),});
const decodeLogPage = decode(LogPage);

/**
 * Every log in [from, to], page by page; `each` sees them as they arrive. Returns whether every page had the shape a
 * complete answer has: a data list, and no status or warning saying it is partial.
 */
export const searchLogs = <E = never, R = never>(source: Source, from: number, to: number, each: (log: DatadogLog) => Effect.Effect<void, E, R>) => Effect.gen(function* () {
    let cursor: string | null = null;
    for (let page = 0; page < 10_000; page++) {
      const body: object = {
        filter: { query: source.query, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        page: { limit: 1000, ...(cursor ? { cursor } : {}) },
        sort: "timestamp",};
      const reply: typeof LogPage.Type = decodeLogPage(yield* request(source, "/api/v2/logs/events/search", body)) ?? {};
      const meta: NonNullable<typeof reply.meta> = reply.meta ?? {};
      if (!reply.data || (meta.status !== undefined && meta.status !== "done") || (meta.warnings ?? []).length) return false;
      for (const row of reply.data) {
        const a = row.attributes ?? {};
        yield* each({ id: row.id ?? null, at: time(a.timestamp), message: a.message ?? "", status: a.status ?? "error" });
      }
      const after: string | undefined = meta.page?.after;
      if (!after) return true;
      cursor = after;
    }
    return false; });

export interface Monitor {
  readonly id: string;
  readonly name: string;
  readonly state: string | null;
}

/** The states that are a measurement: anything else, including Unknown and No Data, makes the answer incomplete. */
const STATES = ["OK", "Alert", "Warn", "Ignored", "Skipped"];

const Monitors = Schema.Array(object({ id: unknown, name: text, overall_state: text }));
const decodeMonitors = decode(Monitors);

/** The monitors, and whether the answer was complete: a list whose every monitor has an ID and a state. */
export const monitors = Effect.fnUntraced(function* (source: Source) {
  const reply = decodeMonitors(yield* request(source, `/api/v1/monitor?monitor_tags=&name=&tags=${encodeURIComponent(source.query ?? "")}`));
  if (!reply) return { monitors: [] as Monitor[], complete: false };
  const all = reply.map((m) => ({ id: num(m.id) ?? (typeof m.id === "string" && m.id ? m.id : null), name: m.name ?? null, state: m.overall_state ?? null }));
  const known = all.filter((m) => m.id !== null && m.state !== null && STATES.includes(m.state)).map((m): Monitor => ({ id: String(m.id), name: m.name ?? `monitor ${m.id}`, state: m.state }));
  return { monitors: known, complete: known.length === all.length }; });

const Query = object({ series: field(list(object({ metric: text, unit: field(list(object({ name: text, family: text }))), pointlist: field(list(list(Schema.Unknown))) }))) });
const decodeQuery = decode(Query);

/**
 * The latest point of the configured metric inside the queried window, with the provider's unit. A point dated
 * outside the window proves nothing about it, so it is not a measurement.
 */
export const metric = Effect.fnUntraced(function* (source: Source, from: number, to: number) {
  const q = `from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&query=${encodeURIComponent(source.metric ?? "")}`;
  const reply = decodeQuery(yield* request(source, `/api/v1/query?${q}`)) ?? {};
  // The latest point that has both a time and a value; a null point is not measured, never zero.
  for (const series of reply.series ?? []) {
    const u = series.unit?.[0] ?? {};
    for (const point of [...(series.pointlist ?? [])].reverse()) {
      const at = time(point[0]), value = num(point[1]);
      if (at !== null && value !== null && at >= from && at <= to)
        return { name: `${series.metric ?? source.metric} (${source.metric})`, value, at, unit: u.name ?? u.family ?? null };
    }}
  return null; });

export interface DatadogSpan { readonly id: string | null; readonly at: ProviderTime | null; readonly service: string; readonly resource: string; readonly durationMs: number | null; readonly traceId: string | null; readonly status: string }
const SpanPage = object({
  data: field(Schema.Array(object({ id: text, attributes: field(object({ timestamp: unknown, start_timestamp: unknown, end_timestamp: unknown, service: text, resource_name: text, duration: unknown, trace_id: text, status: text, custom: field(object({ duration: unknown })) })) }))),
  meta: field(object({ status: unknown, warnings: field(Schema.Array(Schema.Unknown)), page: field(object({ after: field(Schema.NonEmptyString) })) })), });
const decodeSpanPage = decode(SpanPage);

/** Every span in [from, to], page by page, through Datadog's v2 Spans Search API. */
export const searchSpans = <E = never, R = never>(source: Source, from: number, to: number, each: (span: DatadogSpan) => Effect.Effect<void, E, R>) => Effect.gen(function* () {
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const body = { data: { type: "search_request", attributes: { filter: { query: source.spans?.query ?? source.query, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, page: { limit: 1000, ...(cursor ? { cursor } : {}) }, sort: "timestamp" } } };
    const reply: typeof SpanPage.Type = decodeSpanPage(yield* request(source, "/api/v2/spans/events/search", body)) ?? {};
    const meta: NonNullable<typeof reply.meta> = reply.meta ?? {};
    if (!reply.data || (meta.status !== undefined && meta.status !== "done") || (meta.warnings ?? []).length) return false;
    for (const row of reply.data) {
      const a = row.attributes ?? {}, ns = num(a.duration ?? a.custom?.duration);
      const durationMs = ns !== null && ns >= 0 ? Math.round((ns / 1e6) * 10) / 10 : null;
      yield* each({ id: row.id ?? null, at: time(a.timestamp ?? a.end_timestamp ?? a.start_timestamp), service: a.service ?? "service", resource: a.resource_name ?? "span", durationMs, traceId: a.trace_id ?? null, status: a.status ?? "ok" });
    }
    const after: string | undefined = meta.page?.after;
    if (!after) return true;
    cursor = after;
  }
  return false; });

/** For the doctor: are the keys accepted? */
export const validate = (source: Source): Effect.Effect<void, HttpFailure, Requirements> => Effect.asVoid(request(source, "/api/v1/validate"));
