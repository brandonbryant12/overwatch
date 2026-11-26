/**
 * Datadog through its HTTP API: v2 logs search (paginated to the end), v1 monitors and a v1 metric query. Keys go
 * in request headers only. A rate limit's Retry-After is honoured up to 30 seconds, at most twice per read; beyond
 * that the read fails as rate-limited and its checkpoint does not move.
 */
import { LIMITS, type Source } from "./config.ts";
import { secret } from "./exec.ts";
import { sleep } from "./clock.ts";

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
      const wait = Number(response.headers.get("retry-after") ?? "60");
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

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface DatadogLog {
  readonly id: string;
  readonly at: number;
  readonly message: string;
  readonly status: string;
}

/** Every log in [from, to], page by page; `each` sees them as they arrive. */
export async function searchLogs(source: Source, from: number, to: number, each: (log: DatadogLog) => void): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page++) {
    const body = {
      filter: { query: source.query, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      page: { limit: 1000, ...(cursor ? { cursor } : {}) },
      sort: "timestamp",
    };
    const reply = rec(await request(source, "/api/v2/logs/events/search", { method: "POST", body }));
    for (const row of Array.isArray(reply.data) ? reply.data : []) {
      const a = rec(rec(row).attributes);
      const id = rec(row).id, at = Date.parse(String(a.timestamp ?? ""));
      if (typeof id === "string" && Number.isFinite(at)) each({ id, at, message: String(a.message ?? ""), status: String(a.status ?? "error") });
    }
    const after = rec(rec(reply.meta).page).after;
    if (typeof after !== "string" || !after) return;
    cursor = after;
  }
}

export interface Monitor {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

export async function monitors(source: Source): Promise<Monitor[]> {
  const reply = await request(source, `/api/v1/monitor?monitor_tags=&name=&tags=${encodeURIComponent(source.query ?? "")}`);
  return (Array.isArray(reply) ? reply : []).map(rec).flatMap((m) =>
    m.id === undefined ? [] : [{ id: String(m.id), name: String(m.name ?? `monitor ${m.id}`), state: String(m.overall_state ?? "OK") }],
  );
}

/** The latest point of the configured metric over the window. */
export async function metric(source: Source, from: number, to: number): Promise<{ name: string; value: number; at: number } | null> {
  const q = `from=${Math.floor(from / 1000)}&to=${Math.floor(to / 1000)}&query=${encodeURIComponent(source.metric ?? "")}`;
  const reply = rec(await request(source, `/api/v1/query?${q}`));
  for (const series of Array.isArray(reply.series) ? reply.series : []) {
    const points = rec(series).pointlist;
    const last = Array.isArray(points) ? points.at(-1) : undefined;
    if (Array.isArray(last) && Number.isFinite(Number(last[1])))
      return { name: `${String(rec(series).metric ?? source.metric)} (${source.metric})`, value: Number(last[1]), at: Number(last[0]) || to };
  }
  return null;
}

/** For the doctor: are the keys accepted? */
export async function validate(source: Source): Promise<void> {
  await request(source, "/api/v1/validate");
}
