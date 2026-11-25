import type { SeriesPoint } from "./detection.ts";
import type { Incident } from "./incidents.ts";
import type { Finding } from "./report.ts";
import type { Seen } from "./signals.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The subset of OpenCode's plugin storage Overwatch uses: durable JSON values with prefix scans. */
export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: Json): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    readonly entries: ReadonlyArray<{ readonly key: string; readonly value: unknown }>;
    readonly next?: string;
  }>;
}

export function memoryKV(): KV & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    data,
    get: async (key) => clone(data.get(key)),
    set: async (key, value) => void data.set(key, clone(value)),
    remove: async (key) => void data.delete(key),
    scan: async ({ prefix, after, limit = 100 }) => {
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix) && (after === undefined || k > after)).sort();
      const page = keys.slice(0, limit);
      return {
        entries: page.map((key) => ({ key, value: clone(data.get(key)) })),
        ...(keys.length > limit ? { next: page[page.length - 1] } : {}),
      };
    },
  };
}

export async function scanAll<T>(kv: KV, prefix: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const page = await kv.scan({ prefix, ...(after ? { after } : {}), limit: 200 });
    out.push(...page.entries.map((entry) => entry.value as T));
    after = page.next;
  } while (after);
  return out;
}

export interface RunRecord {
  readonly at: number;
  readonly durationMs: number;
  /** Coverage gaps and caveats from this run, shown in status and in reports. */
  readonly coverage: ReadonlyArray<string>;
  readonly failedSources: ReadonlyArray<string>;
  readonly opened: ReadonlyArray<string>;
  readonly resolved: ReadonlyArray<string>;
  readonly investigationId?: string;
}

export interface WatcherState {
  readonly lastRunAt?: number;
  /** Per source: end of the last window checked successfully. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** Per source, per metric: recent samples. */
  readonly series: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<SeriesPoint>>>>>;
  readonly lastRun?: RunRecord;
}

export interface InvestigationRecord {
  readonly id: string;
  readonly title: string;
  readonly trigger:
    | { readonly type: "watcher"; readonly watcherId: string; readonly incidentIds: ReadonlyArray<string> }
    | { readonly type: "manual"; readonly text: string; readonly originSessionID?: string };
  readonly app: string;
  readonly environment?: string;
  readonly window: { readonly from: number; readonly to: number };
  readonly coverage: ReadonlyArray<string>;
  readonly status: "queued" | "running" | "done" | "failed";
  readonly createdAt: number;
  /** When it left the queue. A run that has held its worktree far longer than its timeouts allow is presumed dead. */
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly sessionID?: string;
  readonly commit?: string;
  readonly finding?: Finding;
  readonly report?: string;
  readonly pullRequest?: string;
  readonly fixNote?: string;
  readonly error?: string;
}

export const keys = {
  watcher: (id: string) => `watcher/${id}`,
  seen: (watcherId: string, source: string) => `seen/${watcherId}/${source}`,
  incident: (id: string) => `incident/${id}`,
  investigation: (id: string) => `investigation/${id}`,
  session: (sessionID: string) => `session/${sessionID}`,
  finding: (investigationId: string) => `finding/${investigationId}`,
  lease: "lease",
};

export const emptyWatcherState: WatcherState = { checkpoints: {}, series: {} };

export async function loadWatcher(kv: KV, id: string): Promise<WatcherState> {
  return ((await kv.get(keys.watcher(id))) as WatcherState | undefined) ?? emptyWatcherState;
}

export async function loadSeen(kv: KV, watcherId: string, source: string): Promise<Seen> {
  return ((await kv.get(keys.seen(watcherId, source))) as Seen | undefined) ?? {};
}

export async function openIncidents(kv: KV, watcherId: string): Promise<Incident[]> {
  return (await scanAll<Incident>(kv, "incident/")).filter((i) => i.watcherId === watcherId && i.status === "open");
}

export const asJson = (value: unknown) => value as Json;
