/**
 * Datadog through its HTTP API: v2 logs search (paginated to the end), v1 monitors and a v1 metric query. Keys go
 * in request headers only. A rate limit's Retry-After is honoured up to 30 seconds, at most twice per read; beyond
 * that the read fails as rate-limited and its checkpoint does not move.
 */
import { LIMITS, type Source } from "./config.ts";
import { secret } from "./exec.ts";
import { sleep } from "./clock.ts";
import { list, num, rec, str, time, type ProviderTime } from "./parse.ts";

export class HttpFailure extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(source: Source, path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const apiKey = await secret(source.apiKey!), appKey = await secret(source.appKey!);
  if (!apiKey || !appKey) throw new HttpFailure(401, `Datadog keys are not set: ${source.apiKey} and ${source.appKey}`);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(source.baseUrl + path, {
        method: init.method ?? "GET",
        headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey, "content-type": "application/json", accept: "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new HttpFailure(0, `Datadog unreachable: ${(error as Error).message}`);
    }
    if (response.status === 429) {
      const wait = num(response.headers.get("retry-after")) ?? Infinity;
      await response.body?.cancel();
      if (attempt < LIMITS.retryAfterTimes && Number.isFinite(wait) && wait <= LIMITS.retryAfterMaxS) {
        await sleep(Math.max(0, wait) * 1000);
        continue;
      }
      throw new HttpFailure(429, `Datadog rate limit (retry after ${wait}s)`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpFailure(response.status, `Datadog answered ${response.status} for ${path.split("?")[0]}`);
    }
    return response.json();
  }
}


export interface DatadogLog {
  /** null when the log has no stable ID: it cannot be counted once, so the reading is incomplete. */
  readonly id: string | null;
  /** null when the log has no readable time: it cannot be placed in a window. */
  readonly at: ProviderTime | null;
  readonly message: string;
  readonly status: string;
}

/** Every log in [from, to], page by page; `each` sees them as they arrive. */
/** Every log in [from, to], page by page. Returns whether every page had the shape a complete answer has. */
export async function searchLogs(source: Source, from: number, to: number, each: (log: DatadogLog) => void): Promise<boolean> {
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const body = {
      filter: { query: source.query, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
      sort: "timestamp",
    };
    const reply = rec(await request(source, "/api/v2/logs/events/search", { method: "POST", body }));
    // A complete page is built from recognised parts: a data list, and no status or warning saying it is partial.
    const meta = rec(reply.meta);
    if (!Array.isArray(reply.data) || (meta.status !== undefined && meta.status !== "done") || list(meta.warnings).length) return false;
    for (const row of list(reply.data)) {
      const a = rec(rec(row).attributes);
      each({ id: str(rec(row).id), at: time(a.timestamp), message: typeof a.message === "string" ? a.message : "", status: str(a.status) ?? "error" });
    }
    const after = rec(rec(reply.meta).page).after;
    if (typeof after !== "string" || !after) return true;
    cursor = after;
  }
  return false;
}

export interface Monitor {
  readonly id: string;
  readonly name: string;
  readonly state: string | null;
}

/** The states that are a measurement: anything else, including Unknown and No Data, makes the answer incomplete. */
const STATES = ["OK", "Alert", "Warn", "Ignored", "Skipped"];

/** The monitors, and whether the answer was complete: a list whose every monitor has an ID and a state. */
export async function monitors(source: Source): Promise<{ monitors: Monitor[]; complete: boolean }> {
  const reply = await request(source, `/api/v1/monitor?monitor_tags=&name=&tags=${encodeURIComponent(source.query ?? "")}`);
  if (!Array.isArray(reply)) return { monitors: [], complete: false };
  const all = list(reply).map(rec).map((m) => ({ id: num(m.id) ?? str(m.id), name: str(m.name), state: str(m.overall_state) }));
  const known = all.filter((m) => m.id !== null && m.state !== null && STATES.includes(m.state)).map((m) => ({ id: String(m.id), name: m.name ?? `monitor ${m.id}`, state: m.state }));
  return { monitors: known, complete: known.length === all.length };
}

/**
 * The latest point of the configured metric inside the queried window, with the provider's unit. A point dated
 * outside the window proves nothing about it, so it is not a measurement.
 */
export async function metric(source: Source, from: number, to: number): Promise<{ name: string; value: number; at: ProviderTime; unit: string | null } | null> {
  const q = `from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&query=${encodeURIComponent(source.metric ?? "")}`;
  const reply = rec(await request(source, `/api/v1/query?${q}`));
  // The latest point that has both a time and a value; a null point is not measured, never zero.
  for (const series of list(reply.series)) {
    const u = rec(list(rec(series).unit)[0]);
    for (const point of list(rec(series).pointlist).reverse()) {
      const at = time(list(point)[0]), value = num(list(point)[1]);
      if (at !== null && value !== null && at >= from && at <= to)
        return { name: `${str(rec(series).metric) ?? source.metric} (${source.metric})`, value, at, unit: str(u.name) ?? str(u.family) };
    }
  }
  return null;
}

/** For the doctor: are the keys accepted? */
export async function validate(source: Source): Promise<void> {
  await request(source, "/api/v1/validate");
}
