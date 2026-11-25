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

/**
 * Every record is stored as `{ v, data }`, where `v` is the schema version that wrote it.
 *
 * - A record without the envelope was written before versioning and is version 0.
 * - An older record is brought forward through `MIGRATIONS`, one version at a time, when it is read. The stored
 *   copy is rewritten the next time that record is saved.
 * - A record from a newer version is never read or overwritten: reading one fails with `NewerSchemaError`, and
 *   scans skip it. Downgrading the plugin therefore cannot corrupt what the newer version stored.
 *
 * To change a record's shape: bump `SCHEMA_VERSION` and add `MIGRATIONS[<previous version>]`.
 */
export const SCHEMA_VERSION = 1;

/** The kind of a record, taken from its key: `watcher`, `seen`, `incident`, `investigation`, `session`, ... */
export type RecordKind = string;

/** `MIGRATIONS[n]` turns a version `n` record into version `n + 1`. */
const MIGRATIONS: Readonly<Record<number, (kind: RecordKind, data: unknown) => unknown>> = {
  // Version 1 added the envelope only; the records inside kept their shape.
  0: (_kind, data) => data,
};

export class NewerSchemaError extends Error {
  constructor(key: string, version: number) {
    super(`${key} was written by a newer Overwatch (schema ${version}; this one reads up to ${SCHEMA_VERSION}). Update the plugin.`);
    this.name = "NewerSchemaError";
  }
}

const isEnvelope = (value: unknown): value is { v: number; data: unknown } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { v?: unknown }).v === "number" &&
  "data" in value &&
  Object.keys(value).length === 2;

function unwrap<T>(key: string, raw: unknown): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  let version = isEnvelope(raw) ? raw.v : 0;
  let data = isEnvelope(raw) ? raw.data : raw;
  if (!Number.isInteger(version) || version < 0) return undefined;
  if (version > SCHEMA_VERSION) throw new NewerSchemaError(key, version);
  const kind = key.split("/")[0]!;
  for (; version < SCHEMA_VERSION; version++) {
    const migrate = MIGRATIONS[version];
    if (!migrate) return undefined;
    data = migrate(kind, data);
  }
  return data as T;
}

/** Reads one record, migrating it to the current schema. Throws `NewerSchemaError` for a newer one. */
export async function readRecord<T>(kv: KV, key: string): Promise<T | undefined> {
  return unwrap<T>(key, await kv.get(key));
}

/** Writes one record at the current schema version. Refuses to replace a record from a newer version. */
export async function writeRecord(kv: KV, key: string, value: unknown): Promise<void> {
  const existing = await kv.get(key);
  if (isEnvelope(existing) && existing.v > SCHEMA_VERSION) throw new NewerSchemaError(key, existing.v);
  await kv.set(key, { v: SCHEMA_VERSION, data: value as Json });
}

/** Reads every record under a prefix. Records from a newer schema are left out and counted in `skipped`. */
export async function scanRecords<T>(kv: KV, prefix: string): Promise<{ records: T[]; skipped: number }> {
  const records: T[] = [];
  let skipped = 0;
  let after: string | undefined;
  do {
    const page = await kv.scan({ prefix, ...(after ? { after } : {}), limit: 200 });
    for (const entry of page.entries) {
      try {
        const record = unwrap<T>(entry.key, entry.value);
        if (record !== undefined) records.push(record);
      } catch {
        skipped++;
      }
    }
    after = page.next;
  } while (after);
  return { records, skipped };
}

export async function scanAll<T>(kv: KV, prefix: string): Promise<T[]> {
  return (await scanRecords<T>(kv, prefix)).records;
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
  /** Text an investigation was shown (its brief, each query result), kept to check citations against. */
  evidence: (investigationId: string, name: string) => `evidence/${investigationId}/${name}`,
  evidencePrefix: (investigationId: string) => `evidence/${investigationId}/`,
  lease: "lease",
};

export const emptyWatcherState: WatcherState = { checkpoints: {}, series: {} };

export async function loadWatcher(kv: KV, id: string): Promise<WatcherState> {
  return (await readRecord<WatcherState>(kv, keys.watcher(id))) ?? emptyWatcherState;
}

export async function loadSeen(kv: KV, watcherId: string, source: string): Promise<Seen> {
  return (await readRecord<Seen>(kv, keys.seen(watcherId, source))) ?? {};
}

export async function openIncidents(kv: KV, watcherId: string): Promise<Incident[]> {
  return (await scanAll<Incident>(kv, "incident/")).filter((i) => i.watcherId === watcherId && i.status === "open");
}
