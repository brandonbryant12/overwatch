/**
 * Kubernetes through `kubectl`, read-only. Only `get`, `describe`, `logs` and `top` run, always with the configured
 * context and namespace, and only with the flags and value shapes listed here: an allowlist, so anything else is
 * refused before a process starts. Logs are read line by line with a byte cap; nothing builds a list of all it read.
 *
 * kubectl's JSON is decoded by Schema, tolerantly: a field of the wrong kind is absent, a list that is not one is
 * empty, an entry that is not an object has no fields. Text that is not JSON at all fails the decode (a defect the
 * collector records as the source's failure, as before).
 */
import { Effect, Option, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { count, time, type ProviderTime } from "./parse.ts";
import { run, stream, type Result, type StreamRead } from "./exec.ts";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._\/=!,() -]{0,250}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const READABLE = new Set(["pods", "events", "deployments", "replicasets", "statefulsets"]);
const FLAGS: Readonly<Record<string, Readonly<Record<string, RegExp | null>>>> = {
  get: { "-l": SELECTOR, "-o": /^json$/ },
  describe: {},
  logs: { "-c": NAME, "--timestamps": null, "--previous": null, "--since-time": ISO },
  top: { "-l": SELECTOR, "--containers": null, "--no-headers": null },};

/** Throws unless the verb, resource, names, flags and values are all on the allowlist. */
export function checkKubectl(verb: string, args: ReadonlyArray<string>): void {
  const flags = FLAGS[verb];
  if (!flags) throw new Error(`kubectl ${verb} is not allowed; only get, describe, logs and top run`);
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!(flag in flags)) throw new Error(`kubectl ${verb} ${flag} is not allowed`);
    const shape = flags[flag]!;
    if (shape === null) continue;
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || !shape.test(value)) throw new Error(`kubectl ${verb} ${flag} value is not allowed`);
  }
  const [first, ...rest] = positionals;
  if (!first) throw new Error(`kubectl ${verb} with nothing to read is not allowed`);
  if (verb === "get" || verb === "describe") {
    if (!READABLE.has(first)) throw new Error(`kubectl ${verb} ${first} is not allowed`);
    if (rest.some((n) => !NAME.test(n))) throw new Error(`kubectl ${verb}: a name is not allowed`);
  } else if (verb === "logs") {
    if (!NAME.test(first) || rest.length) throw new Error("kubectl logs takes one pod name");
  } else if (first !== "pod" || rest.length) throw new Error("kubectl top pod only");
}

export interface Target {
  readonly context: string;
  readonly namespace: string;
}

const base = (t: Target) => ["--context", t.context, "-n", t.namespace];

/** One allowlisted kubectl read. A call off the allowlist is refused before any process starts (a defect). */
export const kubectl = (t: Target, verb: string, args: ReadonlyArray<string>): Effect.Effect<Result, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.suspend(() => {
    checkKubectl(verb, args);
    return run("kubectl", [...base(t), verb, ...args], { timeoutMs: 60_000 }); });

export type LogRead = StreamRead;

/**
 * Streams `kubectl logs --timestamps` for one container instance, calling `line` for each complete line, within the
 * byte cap. `line` returns false to stop the read: kubectl lists a container's lines in time order, so a catch-up
 * slice stops at the first line after its end.
 */
export const streamLogs = <E = never, R = never>(
  t: Target,
  pod: string,
  container: string,
  since: string,
  previous: boolean,
  maxBytes: number,
  line: (stamp: string, text: string) => Effect.Effect<boolean | void, E, R>,
): Effect.Effect<LogRead, E, R | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.suspend(() => {
    const args = [pod, "-c", container, "--timestamps", `--since-time=${since}`, ...(previous ? ["--previous"] : [])];
    checkKubectl("logs", args);
    return stream("kubectl", [...base(t), "logs", ...args], maxBytes, (raw) => {
      const space = raw.indexOf(" ");
      return space > 0 ? line(raw.slice(0, space), raw.slice(space + 1)) : Effect.void; }); });

export interface Instance {
  readonly id: string;
  readonly previous: boolean;
}
export interface Pod {
  readonly name: string;
  readonly uid: string;
  readonly containers: ReadonlyArray<{ readonly name: string; readonly instances: ReadonlyArray<Instance>; readonly memoryLimit: number | null; readonly restarts: number }>;
  readonly ready: boolean;
  /** The pod says it is running: its containers have instances whose logs can be read. */
  readonly running: boolean;
}

// Tolerant shapes. `field`: absent when missing or of another kind. `object`: no fields when it is not an object.
// `list`: empty when it is not a list. `text`: a non-empty string. `unknown`: anything, judged later by parse.ts.
const field = <S extends Schema.Top>(schema: S) => Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));
const object = <F extends Schema.Struct.Fields>(fields: F) => Schema.Struct(fields).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some({} as Schema.Struct.Type<F>))));
const list = <S extends Schema.Top>(item: S) => Schema.Array(item).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some([] as ReadonlyArray<S["Type"]>))));
const text = field(Schema.NonEmptyString);
const unknown = Schema.optional(Schema.Unknown);
/** kubectl's `{ items: [...] }`; text that is not JSON fails the decode. */
const items = <T,>(item: Schema.Codec<T, unknown>) => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(object({ items: field(list(item)) })));
  return (stdout: string): ReadonlyArray<T> => decode(stdout).items ?? [];
};

const PodItem = object({
  metadata: field(object({ name: text, uid: text })),
  spec: field(object({ containers: field(list(object({ name: text, resources: field(object({ limits: field(object({ memory: text })) })) }))) })),
  status: field(
    object({
      phase: unknown,
      conditions: field(list(object({ type: unknown, status: unknown }))),
      containerStatuses: field(list(object({ name: unknown, containerID: text, restartCount: unknown, lastState: field(object({ terminated: field(object({ containerID: text })) })) }))),})),});
const decodePods = items(PodItem);

/** Memory quantities: "512Mi", "1Gi", "64M", "1048576". */
export function bytes(quantity: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(quantity.trim());
  if (!m) return null;
  const unit = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2] ?? ""] ?? 1;
  return Number(m[1]) * unit;
}

/** Pods with each container's current and previous instance, in UID order. Tolerant of missing fields. */
export function parsePods(stdout: string): Pod[] {
  const pods: Pod[] = [];
  for (const item of decodePods(stdout)) {
    const name = item.metadata?.name, uid = item.metadata?.uid;
    if (!name || !uid || !NAME.test(name)) continue;
    const statuses = item.status?.containerStatuses ?? [];
    const containers = (item.spec?.containers ?? []).flatMap((c) => {
      const cname = c.name;
      if (!cname || !NAME.test(cname)) return [];
      const s = statuses.find((x) => x.name === cname);
      const current = s?.containerID;
      const previous = s?.lastState?.terminated?.containerID;
      const limit = c.resources?.limits?.memory;
      return [{
        name: cname,
        instances: [...(previous ? [{ id: previous, previous: true }] : []), ...(current ? [{ id: current, previous: false }] : [])],
        memoryLimit: limit ? bytes(limit) : null,
        restarts: count(s?.restartCount) ?? 0,}]; });
    const ready = (item.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
    pods.push({ name, uid, containers, ready, running: item.status?.phase === "Running" });
  }
  return pods.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

const Workload = object({
  metadata: field(object({ creationTimestamp: unknown })),
  spec: field(
    object({
      template: field(
        object({
          metadata: field(object({ annotations: field(object({ "overwatch.dev/revision": text })) })),
          spec: field(object({ containers: field(list(object({ image: field(Schema.String) }))) })),})),})),});
const decodeWorkloads = items(Workload);

/** One deployment's or replica set's revision: the template's annotation, else an image tag that is a SHA. */
function revisionOf(item: typeof Workload.Type): string | null {
  const template = item.spec?.template;
  const annotated = template?.metadata?.annotations?.["overwatch.dev/revision"];
  if (annotated) return annotated;
  for (const c of template?.spec?.containers ?? []) {
    const tag = /[:@](?:sha256:)?([0-9a-f]{7,64})$/.exec(c.image ?? "")?.[1];
    if (tag) return tag;
  }
  return null;
}

/** The running revision: the pod template's `overwatch.dev/revision` annotation, else an image tag that is a SHA. */
export function parseRevision(stdout: string): string | null {
  for (const item of decodeWorkloads(stdout)) {
    const revision = revisionOf(item);
    if (revision) return revision;
  }
  return null;
}

/**
 * When a revision rolled out, by the provider: the creation time of the replica set whose pod template carries that
 * revision (`get replicasets`), else the deployment's Progressing condition when it names the new replica set. Null
 * when the cluster does not say: the caller then knows only the interval between two observations.
 */
export function parseRollout(stdout: string, revision: string): number | null {
  const known = decodeWorkloads(stdout) .filter((item) => revisionOf(item) === revision) .map((item) => time(item.metadata?.creationTimestamp))
    .filter((t): t is ProviderTime => t !== null);
  return known.length ? Math.max(...known) : null;
}

export interface KubeEvent {
  readonly uid: string;
  readonly count: number;
  readonly reason: string;
  readonly message: string;
  readonly type: string;
  readonly at: number | null;
}

const EventItem = object({
  metadata: field(object({ uid: text })),
  series: field(object({ count: unknown, lastObservedTime: unknown })),
  count: unknown,
  deprecatedCount: unknown,
  lastTimestamp: unknown,
  eventTime: unknown,
  firstTimestamp: unknown,
  reason: text,
  message: field(Schema.String),
  type: text,});
const decodeEvents = items(EventItem);

export function parseEvents(stdout: string): KubeEvent[] {
  return decodeEvents(stdout).flatMap((e) => {
    const uid = e.metadata?.uid;
    if (!uid) return [];
    // An EventSeries carries its cumulative count in series.count; the legacy field stays at the first value.
    const n = Math.max(count(e.series?.count) ?? 0, count(e.count) ?? 0, count(e.deprecatedCount) ?? 0, 1);
    const at = time(e.series?.lastObservedTime) ?? time(e.lastTimestamp) ?? time(e.eventTime) ?? time(e.firstTimestamp);
    return [{ uid, count: n, reason: e.reason ?? "Event", message: e.message ?? "", type: e.type ?? "Normal", at }]; });
}

/** `kubectl top pod --containers --no-headers`: pod, container, cpu, memory. */
export function parseTop(stdout: string): Array<{ pod: string; container: string; memory: number }> {
  return stdout.split("\n").flatMap((l) => {
    const [pod, container, , memory] = l.trim().split(/\s+/);
    const m = memory ? bytes(memory) : null;
    return pod && container && m !== null && !/^POD$/i.test(pod) ? [{ pod, container, memory: m }] : []; });
}
