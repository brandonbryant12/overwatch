import { formatDuration, iso } from "../duration.ts";
import { limiter, type ExecResult } from "../exec.ts";
import type { SourceConfig } from "../options.ts";
import { redactText } from "../redact.ts";
import { normalizeMessage, shortHash, type Occurrence, type Sample, type Signal } from "../signals.ts";
import { items, num, parseJson, pick, rec, records, text, time } from "../tolerant.ts";
import { emptyResult, str, type CollectResult, type SourceContext, type SourceType } from "./types.ts";

/**
 * Kubernetes through the `kubectl` CLI only, read-only.
 *
 * Only `get`, `describe`, `logs` and `top` run, always with the configured context and namespace. Limits, usage and
 * capacity are read from the cluster (pod spec, `kubectl top`, resource quotas, node allocatable); none are assumed.
 */
export const READ_ONLY_VERBS = new Set(["get", "describe", "logs", "top"]);

/** Resources that may be read. Secrets, config maps and anything not listed are not. */
const READABLE = new Set([
  "pods", "pod", "events", "event", "nodes", "node", "resourcequota", "resourcequotas", "services", "service", "endpoints",
  "deployments", "deployment", "deployments.apps", "statefulsets", "statefulsets.apps", "daemonsets", "daemonsets.apps",
  "replicasets", "replicasets.apps", "horizontalpodautoscalers", "horizontalpodautoscalers.autoscaling", "hpa",
]);
/** A Kubernetes object name, label value or similar: never starts with "-", so it cannot be read as a flag. */
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._\/=!,() -]{0,250}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const COUNT = /^\d{1,9}$/;

/**
 * The flags each verb may take, and the shape of each flag's value. Anything else is refused: this is an allowlist,
 * so a flag kubectl adds later, or one that changes the cluster, identity, output file or namespace, is not allowed.
 */
const FLAGS: Readonly<Record<string, Readonly<Record<string, RegExp | null>>>> = {
  get: { "-l": SELECTOR, "--selector": SELECTOR, "-o": /^json$/, "--output": /^json$/, "--field-selector": SELECTOR },
  describe: { "-l": SELECTOR },
  logs: {
    "--all-containers": null,
    "--prefix": null,
    "--timestamps": null,
    "--previous": null,
    "--since-time": ISO_TIME,
    "--limit-bytes": COUNT,
    "--tail": COUNT,
    "-c": NAME,
    "--container": NAME,
  },
  top: { "-l": SELECTOR, "--containers": null, "--no-headers": null },
};
/** How many plain arguments each verb takes: get and describe a resource and names, logs a pod, top pods or nodes. */
const POSITIONALS: Readonly<Record<string, number>> = { get: 52, describe: 2, logs: 1, top: 1 };

export interface KubernetesConfig {
  readonly context: string;
  readonly namespace: string;
  readonly selector: string;
  readonly workload?: string;
  readonly errorPattern: RegExp;
  readonly logs: boolean;
}

export function kubernetesConfig(config: SourceConfig): KubernetesConfig {
  return {
    context: String(config.context ?? ""),
    namespace: String(config.namespace ?? ""),
    selector: String(config.selector ?? ""),
    ...(typeof config.workload === "string" ? { workload: config.workload } : {}),
    errorPattern: new RegExp(
      str(config.errorPattern) ?? String.raw`\b(error|fatal|panic|exception|traceback)\b|"level"\s*:\s*"(error|fatal)"`,
      "i",
    ),
    logs: config.logs !== false,
  };
}

/**
 * Accepts only what is allowed: a read-only verb, readable resources, names that cannot be flags, and the flags and
 * value shapes listed for that verb. The context and namespace are added by `kubectl()` and cannot be given here.
 */
export function checkKubectlArgs(verb: string, args: ReadonlyArray<string>): void {
  const flags = FLAGS[verb];
  if (!READ_ONLY_VERBS.has(verb) || !flags) {
    throw new Error(`kubectl ${verb} is not allowed; Overwatch only runs get, describe, logs and top`);
  }
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!(flag in flags)) throw new Error(`kubectl ${verb} flag ${flag} is not allowed`);
    const shape = flags[flag]!;
    if (shape === null) {
      if (eq >= 0) throw new Error(`kubectl ${verb} flag ${flag} takes no value; that is not allowed`);
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || !shape.test(value)) throw new Error(`kubectl ${verb} ${flag} value ${JSON.stringify(value ?? "")} is not allowed`);
  }
  if (positionals.length === 0) throw new Error(`kubectl ${verb} with nothing to read is not allowed`);
  if (positionals.length > (POSITIONALS[verb] ?? 0)) throw new Error(`kubectl ${verb} with ${positionals.length} arguments is not allowed`);
  const [first, ...rest] = positionals;
  if (verb === "get" || verb === "describe") {
    const resources = first!.split(",");
    if (resources.some((r) => /secret/i.test(r))) throw new Error("Reading secrets is not allowed");
    const bad = resources.find((r) => !READABLE.has(r.toLowerCase()));
    if (bad !== undefined) throw new Error(`kubectl ${verb} ${bad} is not allowed; readable: ${[...READABLE].join(", ")}`);
    if (verb === "describe" && rest.length !== 1) throw new Error("kubectl describe needs exactly one name; other forms are not allowed");
  } else if (verb === "top") {
    if (first !== "pods" && first !== "nodes") throw new Error(`kubectl top ${first} is not allowed; only pods and nodes`);
  }
  for (const name of verb === "get" || verb === "describe" ? rest : verb === "logs" ? [first!] : []) {
    if (!NAME.test(name)) throw new Error(`kubectl ${verb} name ${JSON.stringify(name)} is not allowed`);
  }
}

/** What an agent may ask the Kubernetes source for. Each field is checked; nothing becomes a raw argument. */
export type AgentKubectl =
  | { readonly operation: "logs"; readonly pod: string; readonly container?: string; readonly previous?: boolean }
  | { readonly operation: "get"; readonly resource: string; readonly name?: string; readonly selector?: string }
  | { readonly operation: "describe"; readonly resource: string; readonly name: string }
  | { readonly operation: "top"; readonly resource: "pods" | "nodes" };

/** Builds the kubectl verb and arguments for an agent's structured request, or throws with why it is not allowed. */
export function agentKubectl(input: Record<string, unknown>): { verb: string; args: string[] } {
  const field = (key: string) => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value;
  };
  let built: { verb: string; args: string[] };
  switch (input.operation) {
    case "logs": {
      const container = field("container");
      built = { verb: "logs", args: [field("pod") ?? "", ...(container ? ["-c", container] : ["--all-containers"]), "--prefix", "--timestamps", ...(input.previous === true ? ["--previous"] : [])] };
      break;
    }
    case "get": {
      const name = field("name");
      const selector = field("selector");
      built = { verb: "get", args: [field("resource") ?? "", ...(name ? [name] : []), ...(selector ? ["-l", selector] : []), "-o", "json"] };
      break;
    }
    case "describe":
      built = { verb: "describe", args: [field("resource") ?? "", field("name") ?? ""] };
      break;
    case "top":
      built = { verb: "top", args: [field("resource") ?? "", "--no-headers", ...(input.resource === "pods" ? ["--containers"] : [])] };
      break;
    default:
      throw new Error('operation must be "logs", "get", "describe" or "top"; free-form kubectl arguments are not accepted');
  }
  checkKubectlArgs(built.verb, built.args);
  return built;
}

/**
 * Runs one read-only kubectl command. Its time limit is `timeouts.source`, or what is left of the slice if that is
 * less; kubectl is told the same limit so it reports its own timeout instead of being killed mid-answer.
 */
export async function kubectl(
  config: KubernetesConfig,
  verb: string,
  args: ReadonlyArray<string>,
  context: Pick<SourceContext, "exec" | "signal" | "options"> & { readonly deadline?: number },
  maxBytes?: number,
): Promise<ExecResult> {
  checkKubectlArgs(verb, args);
  const remaining = context.deadline === undefined ? Number.POSITIVE_INFINITY : context.deadline - Date.now();
  const timeoutMs = Math.max(1_000, Math.min(context.options.timeouts.sourceMs, remaining));
  return context.exec(
    "kubectl",
    ["--context", config.context, "--namespace", config.namespace, `--request-timeout=${Math.ceil(timeoutMs / 1000)}s`, verb, ...args],
    {
      timeoutMs: timeoutMs + 2_000,
      signal: context.signal,
      ...(maxBytes ? { maxBytes } : {}),
    },
  );
}

function failure(result: ExecResult, what: string): Error {
  const detail = redactText(result.stderr.trim() || `exit ${result.code}`, { maxBytes: 400 });
  return new Error(`kubectl ${what} failed: ${detail}`);
}

/** CPU in millicores from "250m", "1", "0.5" or "1500000n". */
export function parseCpu(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  switch (match[2]) {
    case "n":
      return amount / 1_000_000;
    case "u":
      return amount / 1_000;
    case "m":
      return amount;
    default:
      return amount * 1000;
  }
}

const MEMORY_UNITS: Record<string, number> = {
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

/** Memory in bytes from "128Mi", "1Gi", "500M" or a plain number. */
export function parseMemory(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^(\d+(?:\.\d+)?)(k|M|G|T|Ki|Mi|Gi|Ti)?$/.exec(String(value).trim());
  if (!match) return undefined;
  return Number(match[1]) * MEMORY_UNITS[match[2] ?? ""]!;
}

export interface PodInfo {
  readonly name: string;
  readonly node?: string;
  readonly phase: string;
  readonly createdAt?: number;
  readonly startedAt?: number;
  readonly ready: boolean;
  /** Why the scheduler could not place the pod, when it could not. */
  readonly unschedulable?: string;
  /** The controller that owns the pod, such as a ReplicaSet's name. */
  readonly owner?: string;
  readonly restarts: number;
  readonly containers: ReadonlyArray<{
    readonly name: string;
    readonly image: string;
    readonly requests: { cpu?: number; memory?: number };
    readonly limits: { cpu?: number; memory?: number };
  }>;
  readonly statuses: ReadonlyArray<Record<string, any>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
}

const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(rec(value)).map(([key, entry]) => [key, text(entry)]));

const finite = (value: number): number | undefined => (Number.isFinite(value) ? value : undefined);

export function parsePods(json: string): PodInfo[] {
  return items(parseJson(json, "kubectl get pods")).map((item) => {
    const metadata = rec(item.metadata);
    const spec = rec(item.spec);
    const status = rec(item.status);
    const conditions = records(status.conditions);
    const scheduled = conditions.find((c) => c.type === "PodScheduled");
    const statuses = records(pick(status, "containerStatuses"));
    const createdAt = finite(time(metadata.creationTimestamp));
    const startedAt = finite(time(status.startTime));
    return {
      name: text(metadata.name),
      ...(spec.nodeName ? { node: text(spec.nodeName) } : {}),
      phase: text(status.phase, "Unknown"),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ready: conditions.some((c) => c.type === "Ready" && text(c.status) === "True"),
      ...(scheduled && text(scheduled.status) === "False" ? { unschedulable: text(scheduled.message, text(scheduled.reason, "Unschedulable")) } : {}),
      ...(records(metadata.ownerReferences)[0]?.name ? { owner: text(records(metadata.ownerReferences)[0]!.name) } : {}),
      restarts: statuses.reduce((sum, c) => sum + (num(c.restartCount) ?? 0), 0),
      containers: records(spec.containers).map((c) => {
        const resources = rec(c.resources);
        return {
          name: text(c.name),
          image: text(c.image),
          requests: { cpu: parseCpu(rec(resources.requests).cpu), memory: parseMemory(rec(resources.requests).memory) },
          limits: { cpu: parseCpu(rec(resources.limits).cpu), memory: parseMemory(rec(resources.limits).memory) },
        };
      }),
      statuses,
      labels: stringMap(metadata.labels),
      annotations: stringMap(metadata.annotations),
    };
  });
}

/** True when `labels` satisfy a kubectl label selector (`a=b,c!=d,e,!f,g in (x,y),h notin (z)`). */
export function selects(selector: string, labels: Readonly<Record<string, string>>): boolean {
  const terms = selector.split(/,(?![^(]*\))/).map((term) => term.trim()).filter(Boolean);
  return terms.every((term) => {
    const set = /^(\S+)\s+(in|notin)\s*\(([^)]*)\)$/i.exec(term);
    if (set) {
      const values = set[3]!.split(",").map((v) => v.trim());
      const has = labels[set[1]!] !== undefined && values.includes(labels[set[1]!]!);
      return set[2]!.toLowerCase() === "in" ? has : !has;
    }
    const compare = /^([^=!\s]+)\s*(==|=|!=)\s*(.*)$/.exec(term);
    if (compare) return compare[2] === "!=" ? labels[compare[1]!] !== compare[3] : labels[compare[1]!] === compare[3];
    return term.startsWith("!") ? labels[term.slice(1).trim()] === undefined : labels[term] !== undefined;
  });
}

export interface Workload {
  readonly kind: string;
  readonly name: string;
  readonly desired: number;
  readonly available: number;
  /** Set when a rollout stopped making progress. */
  readonly stuck?: string;
}

export interface Autoscaler {
  readonly name: string;
  readonly target: string;
  readonly current: number;
  readonly min: number;
  readonly max: number;
  /** Set when the autoscaler cannot read the metrics it scales on. */
  readonly blind?: string;
}

export interface ReplicaSetInfo {
  readonly name: string;
  readonly owner?: string;
  readonly revision?: number;
  readonly createdAt?: number;
  readonly replicas: number;
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
}

export interface Workloads {
  readonly workloads: ReadonlyArray<Workload>;
  readonly autoscalers: ReadonlyArray<Autoscaler>;
  readonly replicaSets: ReadonlyArray<ReplicaSetInfo>;
}

export const WORKLOAD_RESOURCES = "deployments.apps,statefulsets.apps,daemonsets.apps,replicasets.apps,horizontalpodautoscalers.autoscaling";

/**
 * The workloads that run the selected pods, their autoscalers and their ReplicaSets, from one mixed
 * `kubectl get <kinds> -o json`. A workload belongs when it is the configured `workload` or its pod template
 * carries the selector's labels.
 */
export function parseWorkloads(json: string, selector: string, workload?: string): Workloads {
  const all = items(parseJson(json, "kubectl get workloads"));
  const template = (item: Record<string, any>) => rec(rec(rec(item.spec).template).metadata);
  const belongs = (item: Record<string, any>) => {
    const name = text(rec(item.metadata).name);
    if (workload && (name === workload || (text(item.kind) === "ReplicaSet" && name.startsWith(`${workload}-`)))) return true;
    return !workload && selector !== "" && selects(selector, stringMap(template(item).labels));
  };
  const condition = (item: Record<string, any>, type: string) => records(rec(item.status).conditions).find((c) => c.type === type);
  const workloads: Workload[] = [];
  const replicaSets: ReplicaSetInfo[] = [];
  for (const item of all.filter(belongs)) {
    const kind = text(item.kind);
    const name = text(rec(item.metadata).name);
    const spec = rec(item.spec);
    const status = rec(item.status);
    if (kind === "ReplicaSet") {
      const annotations = stringMap(rec(item.metadata).annotations);
      const revision = num(annotations["deployment.kubernetes.io/revision"]);
      const createdAt = finite(time(rec(item.metadata).creationTimestamp));
      replicaSets.push({
        name,
        ...(records(rec(item.metadata).ownerReferences)[0]?.name ? { owner: text(records(rec(item.metadata).ownerReferences)[0]!.name) } : {}),
        ...(revision !== undefined ? { revision } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        replicas: num(status.replicas) ?? 0,
        image: text(records(rec(rec(spec.template).spec).containers)[0]?.image),
        labels: stringMap(template(item).labels),
        annotations: { ...annotations, ...stringMap(template(item).annotations) },
      });
    } else if (kind === "Deployment" || kind === "StatefulSet") {
      const progressing = condition(item, "Progressing");
      workloads.push({
        kind,
        name,
        desired: num(spec.replicas) ?? 1,
        available: num(status.availableReplicas) ?? (kind === "StatefulSet" ? (num(status.readyReplicas) ?? 0) : 0),
        ...(progressing && text(progressing.status) === "False" ? { stuck: text(progressing.message, text(progressing.reason, "not progressing")) } : {}),
      });
    } else if (kind === "DaemonSet") {
      workloads.push({ kind, name, desired: num(status.desiredNumberScheduled) ?? 0, available: num(status.numberAvailable) ?? num(status.numberReady) ?? 0 });
    }
  }
  const autoscalers: Autoscaler[] = [];
  for (const item of all.filter((i) => text(i.kind) === "HorizontalPodAutoscaler")) {
    const spec = rec(item.spec);
    const target = rec(spec.scaleTargetRef);
    if (!workloads.some((w) => w.kind === text(target.kind) && w.name === text(target.name))) continue;
    const max = num(spec.maxReplicas);
    if (!max) continue;
    const active = condition(item, "ScalingActive");
    autoscalers.push({
      name: text(rec(item.metadata).name),
      target: `${text(target.kind)}/${text(target.name)}`,
      current: num(rec(item.status).currentReplicas) ?? 0,
      min: num(spec.minReplicas) ?? 1,
      max,
      ...(active && text(active.status) === "False" && text(active.reason) !== "ScalingDisabled" ? { blind: text(active.message, text(active.reason)) } : {}),
    });
  }
  return { workloads, autoscalers, replicaSets };
}

/** The revision a pod template carries, read from its `image-tag`, `label:<key>` or `annotation:<key>`. */
export function revisionOf(
  subject: { readonly image: string; readonly labels: Readonly<Record<string, string>>; readonly annotations: Readonly<Record<string, string>> },
  from = "image-tag",
): string | undefined {
  if (from.startsWith("label:")) return subject.labels[from.slice(6)] || undefined;
  if (from.startsWith("annotation:")) return subject.annotations[from.slice(11)] || undefined;
  // An image pinned by digest has no tag to read a revision from.
  if (subject.image.includes("@")) return undefined;
  const tag = subject.image.slice(subject.image.lastIndexOf(":") + 1);
  return tag && tag !== subject.image && !tag.includes("/") ? tag : undefined;
}

/** What is running, by `image-tag`, `label:<key>` or `annotation:<key>`. Most common first. */
export function revisionsOf(pods: ReadonlyArray<PodInfo>, from = "image-tag"): string[] {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const value = revisionOf({ image: pod.containers[0]?.image ?? "", labels: pod.labels, annotations: pod.annotations }, from);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

/** Parses `kubectl top pods --containers --no-headers`: POD CONTAINER CPU MEMORY. */
export function parseTopContainers(text: string): Array<{ pod: string; container: string; cpu: number; memory: number }> {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .flatMap(([pod, container, cpu, memory]) => {
      const c = parseCpu(cpu);
      const m = parseMemory(memory);
      return c === undefined || m === undefined ? [] : [{ pod: pod!, container: container!, cpu: c, memory: m }];
    });
}

/** Parses `kubectl top nodes --no-headers`: NAME CPU CPU% MEMORY MEMORY%. Percentages are of node allocatable. */
export function parseTopNodes(text: string): Array<{ node: string; cpuPct: number; memoryPct: number }> {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 5)
    .flatMap((parts) => {
      const cpuPct = Number(parts[2]!.replace("%", ""));
      const memoryPct = Number(parts[4]!.replace("%", ""));
      return Number.isFinite(cpuPct) && Number.isFinite(memoryPct) ? [{ node: parts[0]!, cpuPct, memoryPct }] : [];
    });
}

/** Usage as a percentage of each container's own requests and limits, worst container first. */
export function usageSamples(
  pods: ReadonlyArray<PodInfo>,
  top: ReturnType<typeof parseTopContainers>,
  at: number,
): { samples: Sample[]; notes: string[] } {
  const worst: Record<string, number> = {};
  const unlimited = new Set<string>();
  for (const usage of top) {
    const spec = pods.find((p) => p.name === usage.pod)?.containers.find((c) => c.name === usage.container);
    if (!spec) continue;
    const ratios: Array<[string, number, number | undefined]> = [
      ["cpu_pct_of_limit", usage.cpu, spec.limits.cpu],
      ["memory_pct_of_limit", usage.memory, spec.limits.memory],
      ["cpu_pct_of_request", usage.cpu, spec.requests.cpu],
      ["memory_pct_of_request", usage.memory, spec.requests.memory],
    ];
    for (const [metric, used, bound] of ratios) {
      if (!bound) {
        if (metric.endsWith("_of_limit")) unlimited.add(`${usage.container} has no ${metric.split("_")[0]} limit`);
        continue;
      }
      worst[metric] = Math.max(worst[metric] ?? 0, (used / bound) * 100);
    }
  }
  return {
    samples: Object.entries(worst).map(([metric, value]) => ({ metric, at, value: Number(value.toFixed(2)) })),
    notes: [...unlimited],
  };
}

function eventTime(event: Record<string, any>): number {
  return time(pick(rec(event.series), "lastObservedTime") ?? pick(event, "lastTimestamp", "eventTime", "firstTimestamp"));
}

/** Parses `kubectl logs --timestamps --prefix` lines: `[pod/name/container] 2026-01-01T00:00:00.123Z message`. */
export function parseLogLine(line: string): { at: number; message: string; container?: string } | undefined {
  const prefixed = /^\[pod\/[^/\]]+\/([^\]]+)\]\s+(.*)$/.exec(line);
  const rest = prefixed ? prefixed[2]! : line;
  const space = rest.indexOf(" ");
  if (space < 0) return undefined;
  const at = Date.parse(rest.slice(0, space));
  if (!Number.isFinite(at)) return undefined;
  let message = rest.slice(space + 1);
  if (message.startsWith("{")) {
    try {
      const parsed = JSON.parse(message) as unknown;
      const body = pick(parsed, "msg", "message", "error", "err");
      const line = typeof body === "string" ? body : typeof pick(body, "message") === "string" ? text(pick(body, "message")) : undefined;
      if (line !== undefined) message = `${text(pick(parsed, "level", "severity", "lvl"))} ${line}`.trim();
    } catch {
      // Not JSON after all; keep the line as it is.
    }
  }
  return { at, message, ...(prefixed ? { container: prefixed[1]! } : {}) };
}

type Group = { signal: Omit<Signal, "occurrences">; occurrences: Occurrence[] };

/** Every occurrence is kept: what is counted never depends on how many are kept to show. */
function group(into: Map<string, Group>, key: string, base: Omit<Signal, "occurrences">, occurrence: Occurrence) {
  const entry = into.get(key) ?? { signal: base, occurrences: [] };
  entry.occurrences.push(occurrence);
  into.set(key, entry);
}

interface ErrorLine {
  readonly at: number;
  readonly message: string;
  readonly container?: string;
}

/**
 * What one run of this source has already read. A long gap is walked in many slices, and without this every
 * slice would list the pods, list the events and download every pod's log again.
 */
interface RunState {
  pods?: { readonly at: number; readonly list: PodInfo[] };
  events?: Array<Record<string, any>>;
  workloads?: { readonly found?: Workloads; readonly note?: string };
  /** Per pod: the error lines from `from` onwards. `complete` means nothing was cut, so later slices reuse it. */
  readonly logs: Map<string, { readonly from: number; readonly complete: boolean; readonly lines: ReadonlyArray<ErrorLine> }>;
}

function runState(context: SourceContext): RunState {
  const existing = context.scratch.get("kubernetes") as RunState | undefined;
  if (existing) return existing;
  const created: RunState = { logs: new Map() };
  context.scratch.set("kubernetes", created);
  return created;
}

const LOG_BYTES = 4 * 1024 * 1024;
/** Stop starting calls this close to the slice's deadline, so what was read can still be reported. */
const DEADLINE_MARGIN_MS = 3_000;

const names = (list: ReadonlyArray<string>) => (list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`);

/**
 * Error lines of every pod for one window, a few pods at a time.
 *
 * One pod whose log cannot be read does not fail the slice: the gap is reported and the rest is used. Only when no
 * pod's log could be read at all is the source treated as down, so its checkpoint stays where it is.
 */
async function readLogs(
  config: KubernetesConfig,
  pods: ReadonlyArray<PodInfo>,
  window: { from: number; to: number },
  context: SourceContext,
  state: RunState,
): Promise<{ lines: Array<ErrorLine & { pod: string }>; notes: string[] }> {
  const run = limiter(context.options.concurrency.sourceCalls);
  const capped: string[] = [];
  const cut: string[] = [];
  const gone: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ pod: string; error: Error }> = [];
  let read = 0;

  const started = pods.filter((pod) => pod.startedAt !== undefined && pod.startedAt < window.to);
  await Promise.all(
    started.map((pod) =>
      run(async () => {
        const cached = state.logs.get(pod.name);
        if (cached?.complete && cached.from <= window.from) {
          read++;
          return;
        }
        if (context.signal.aborted || Date.now() >= context.deadline - DEADLINE_MARGIN_MS) {
          skipped.push(pod.name);
          return;
        }
        const logs = await kubectl(
          config,
          "logs",
          [pod.name, "--all-containers", "--prefix", "--timestamps", `--since-time=${iso(window.from)}`, `--limit-bytes=${LOG_BYTES}`],
          context,
          LOG_BYTES,
        );
        const incomplete = logs.code !== 0 || logs.killed;
        if (incomplete && !logs.stdout.trim()) {
          if (/not ?found/i.test(logs.stderr)) gone.push(pod.name);
          else failed.push({ pod: pod.name, error: failure(logs, `logs ${pod.name}`) });
          return;
        }
        const full = logs.stdout.length >= LOG_BYTES;
        if (full) capped.push(pod.name);
        else if (incomplete) cut.push(pod.name);
        const lines: ErrorLine[] = [];
        for (const line of logs.stdout.split("\n")) {
          const parsed = parseLogLine(line);
          if (parsed && parsed.at >= window.from && config.errorPattern.test(parsed.message)) lines.push(parsed);
        }
        state.logs.set(pod.name, { from: window.from, complete: !full && !incomplete, lines });
        read++;
      }),
    ),
  );

  if (failed.length && read === 0) {
    throw new Error(`${failed[0]!.error.message}${failed.length > 1 ? ` (and ${failed.length - 1} more pods)` : ""}`);
  }
  const since = iso(window.from);
  const notes: string[] = [];
  if (capped.length) notes.push(`${context.name}: logs of ${names(capped)} were capped at 4 MB from ${since}`);
  if (cut.length) notes.push(`${context.name}: logs of ${names(cut)} from ${since} were cut short (kubectl timed out or failed part way); later lines are not counted`);
  if (failed.length) notes.push(`${context.name}: logs of ${names(failed.map((f) => f.pod))} from ${since} were not read (${failed[0]!.error.message})`);
  if (gone.length) notes.push(`${context.name}: ${names(gone)} went away before their logs from ${since} were read`);
  if (skipped.length) {
    notes.push(
      `${context.name}: logs of ${skipped.length} of ${started.length} pods from ${since} were not read (ran out of time; raise timeouts.slice, now ${formatDuration(context.options.timeouts.sliceMs)}, or concurrency.sourceCalls, now ${context.options.concurrency.sourceCalls})`,
    );
  }

  const lines: Array<ErrorLine & { pod: string }> = [];
  for (const pod of started) {
    for (const line of state.logs.get(pod.name)?.lines ?? []) {
      if (line.at >= window.from && line.at < window.to) lines.push({ ...line, pod: pod.name });
    }
  }
  return { lines, notes };
}

async function collect(
  raw: SourceConfig,
  input: { window: { from: number; to: number }; final: boolean },
  context: SourceContext,
): Promise<CollectResult> {
  const config = kubernetesConfig(raw);
  const { window, final } = input;
  const state = runState(context);
  const scope = `${config.context}/${config.namespace}`;
  const where = `kubectl --context ${config.context} -n ${config.namespace}`;
  const notes: string[] = [];

  // Pods, workloads and events are listed once per run; the last slice re-lists pods if the run has been long.
  if (!state.pods || (final && Date.now() - state.pods.at > 60_000)) {
    const result = await kubectl(config, "get", ["pods", "-l", config.selector, "-o", "json"], context);
    if (result.code !== 0) throw failure(result, "get pods");
    state.pods = { at: Date.now(), list: parsePods(result.stdout) };
  }
  const pods = state.pods.list;

  if (!state.workloads) {
    const result = await kubectl(config, "get", [WORKLOAD_RESOURCES, "-o", "json"], context);
    try {
      // kubectl prints what it may read and fails for the rest, so a non-zero exit can still carry a list.
      const found = parseWorkloads(result.stdout, config.selector, config.workload);
      state.workloads = { found, ...(result.code !== 0 ? { note: `some workload kinds unreadable (${redactText(result.stderr.trim(), { maxBytes: 160 })})` } : {}) };
    } catch {
      state.workloads = { note: `workloads and autoscalers unreadable (${redactText(result.stderr.trim() || "no output", { maxBytes: 160 })}); replica and autoscaler capacity was not checked` };
    }
  }
  const { workloads = [], autoscalers = [], replicaSets = [] } = state.workloads.found ?? {};
  const owners = [...new Set([...workloads.map((w) => w.name), ...autoscalers.map((a) => a.name), ...replicaSets.map((r) => r.name), ...(config.workload ? [config.workload] : [])])];
  // By name or by prefix, so events about pods that are already gone (evicted, crashed, replaced) still count.
  const owned = (name: string) => pods.some((pod) => pod.name === name) || owners.some((owner) => name === owner || name.startsWith(`${owner}-`));

  if (!state.events) {
    const result = await kubectl(config, "get", ["events", "--field-selector", "type=Warning", "-o", "json"], context);
    if (result.code !== 0) throw failure(result, "get events");
    state.events = items(parseJson(result.stdout, "kubectl get events"));
  }

  const groups = new Map<string, Group>();
  for (const event of state.events) {
    const at = eventTime(event);
    const object = rec(pick(event, "involvedObject", "regarding"));
    if (!(at >= window.from && at < window.to) || !owned(text(object.name))) continue;
    const reason = text(event.reason, "Warning");
    const message = redactText(text(pick(event, "message", "note")), { maxBytes: 400 });
    const key = `event:${reason}:${normalizeMessage(message)}`;
    group(
      groups,
      key,
      {
        source: context.name,
        kind: "event",
        key,
        title: `${reason}: ${message}`.slice(0, 120),
        severity: "warn",
        sample: `${iso(at)} ${text(object.kind, "Object")}/${text(object.name, "?")} ${reason}: ${message}`,
        query: `${where} get events --field-selector type=Warning,reason=${reason}`,
      },
      { at, id: `${text(rec(event.metadata).uid, shortHash(message))}:${text(event.count ?? rec(event.series).count, "1")}` },
    );
  }

  if (config.logs) {
    const logs = await readLogs(config, pods, window, context, state);
    notes.push(...logs.notes);
    for (const line of logs.lines) {
      const message = redactText(line.message, { maxBytes: 400 });
      const key = `log:${normalizeMessage(message)}`;
      group(
        groups,
        key,
        {
          source: context.name,
          kind: "log",
          key,
          title: message.slice(0, 120),
          severity: "error",
          sample: `${iso(line.at)} ${line.pod}${line.container ? `/${line.container}` : ""} ${message}`,
          query: `${where} logs -l ${config.selector} --all-containers --since-time=${iso(window.from)}`,
        },
        { at: line.at, id: `${line.pod}:${line.at}:${shortHash(line.message, 8)}` },
      );
    }
  }

  // Container terminations (OOMKilled, Error) are one-off occurrences with their own timestamps.
  for (const pod of pods) {
    for (const status of pod.statuses) {
      const terminated = rec(rec(status.lastState).terminated);
      const at = time(terminated.finishedAt);
      if (!(at >= window.from && at < window.to)) continue;
      const reason = text(terminated.reason, "Terminated");
      const exit = text(terminated.exitCode, "?");
      const key = `terminated:${text(status.name)}:${reason}`;
      group(
        groups,
        key,
        {
          source: context.name,
          kind: "pod",
          key,
          title: `${text(status.name)} container ${reason} (exit ${exit})`,
          severity: "error",
          sample: `${iso(at)} ${pod.name}/${text(status.name)} terminated: ${reason}, exit ${exit}`,
          query: `${where} describe pod ${pod.name}`,
        },
        { at, id: `${pod.name}:${text(status.name)}:${at}` },
      );
    }
  }

  const signals: Signal[] = [...groups.values()].map((g) => ({ ...g.signal, occurrences: g.occurrences }));
  if (!final) return { ...emptyResult, signals, notes };

  // Current state, read once per run.
  const now = window.to;
  const state_ = (key: string, kind: string, title: string, sample: string, query: string) => {
    if (signals.some((s) => s.key === key)) return;
    signals.push({ source: context.name, kind, key, title: title.slice(0, 120), severity: "error", occurrences: [], state: true, sample, query });
  };
  if (state.workloads.note) notes.push(`${context.name}: ${state.workloads.note}`);
  if (pods.length === 0 && workloads.length === 0) {
    notes.push(`${context.name}: no pods match "${config.selector}" in ${scope} and no workload was found for it; check the selector`);
  }

  for (const pod of pods) {
    for (const status of pod.statuses) {
      const waiting = rec(rec(status.state).waiting);
      const reason = text(waiting.reason);
      if (!reason || reason === "ContainerCreating" || reason === "PodInitializing") continue;
      state_(
        `waiting:${text(status.name)}:${reason}`,
        "pod",
        `${text(status.name)} is ${reason}`,
        `${pod.name}/${text(status.name)} waiting: ${reason} ${redactText(text(waiting.message), { maxBytes: 200 })}`.trim(),
        `${where} describe pod ${pod.name}`,
      );
    }
  }

  // Pods the scheduler cannot place: the cluster has no room for them, whatever the usage numbers say.
  const unschedulable = pods.filter((pod) => pod.unschedulable);
  if (unschedulable.length) {
    state_(
      "unschedulable",
      "pod",
      `${unschedulable.length} pod(s) cannot be scheduled`,
      `${unschedulable[0]!.name}: ${redactText(unschedulable[0]!.unschedulable!, { maxBytes: 300 })}`,
      `${where} describe pod ${unschedulable[0]!.name}`,
    );
  }
  const pending = pods.filter((pod) => pod.phase === "Pending" && (pod.unschedulable || now - (pod.createdAt ?? now) > 5 * 60_000));

  const samples: Sample[] = [
    { metric: "not_ready_pods", at: now, value: pods.filter((p) => !p.ready).length },
    { metric: "pending_pods", at: now, value: pending.length },
  ];
  const capacity: string[] = [];

  // Replicas: what each workload wants against what is serving, and rollouts that stopped.
  if (workloads.length) {
    samples.push({ metric: "unavailable_replicas", at: now, value: workloads.reduce((sum, w) => sum + Math.max(0, w.desired - w.available), 0) });
  }
  for (const workload of workloads) {
    capacity.push(`${workload.kind.toLowerCase()} ${workload.name}: ${workload.available} of ${workload.desired} replicas available`);
    if (workload.stuck) {
      state_(
        `rollout:${workload.name}`,
        "rollout",
        `Rollout of ${workload.name} is stuck`,
        `${workload.kind}/${workload.name}: ${redactText(workload.stuck, { maxBytes: 300 })}`,
        `${where} describe ${workload.kind.toLowerCase()} ${workload.name}`,
      );
    }
  }
  // Autoscalers: at the ceiling there is no headroom left, and one that cannot read metrics will not scale at all.
  if (autoscalers.length) {
    samples.push({ metric: "hpa_pct_of_max_replicas", at: now, value: Number(Math.max(...autoscalers.map((a) => (a.current / a.max) * 100)).toFixed(2)) });
  }
  for (const hpa of autoscalers) {
    capacity.push(`autoscaler ${hpa.name} (${hpa.target}): ${hpa.current} replicas, min ${hpa.min}, max ${hpa.max}`);
    if (hpa.blind) {
      state_(
        `hpa:${hpa.name}:blind`,
        "autoscaler",
        `Autoscaler ${hpa.name} cannot read its metrics`,
        `hpa/${hpa.name}: ${redactText(hpa.blind, { maxBytes: 300 })}`,
        `${where} describe hpa ${hpa.name}`,
      );
    }
  }

  for (const pod of pods.slice(0, 3)) {
    for (const c of pod.containers) {
      capacity.push(
        `${pod.name}/${c.name} requests cpu ${c.requests.cpu ?? "none"}m mem ${fmtBytes(c.requests.memory)}, limits cpu ${c.limits.cpu ?? "none"}m mem ${fmtBytes(c.limits.memory)}`,
      );
    }
  }
  const restarted = pods.filter((pod) => pod.restarts > 0);
  if (restarted.length) capacity.push(`restarts: ${restarted.slice(0, 5).map((pod) => `${pod.name} ${pod.restarts}`).join(", ")}`);

  const top = await kubectl(config, "top", ["pods", "-l", config.selector, "--containers", "--no-headers"], context);
  if (top.code === 0) {
    const usage = usageSamples(pods, parseTopContainers(top.stdout), now);
    samples.push(...usage.samples);
    notes.push(...usage.notes.map((n) => `${context.name}: ${n}`));
  } else if (pods.length) notes.push(`${context.name}: kubectl top pods unavailable (${redactText(top.stderr.trim(), { maxBytes: 160 })}); usage against limits was not checked`);

  const nodes = [...new Set(pods.flatMap((p) => (p.node ? [p.node] : [])))];
  if (nodes.length) {
    const topNodes = await kubectl(config, "top", ["nodes", "--no-headers"], context);
    if (topNodes.code === 0) {
      const parsed = parseTopNodes(topNodes.stdout).filter((n) => nodes.includes(n.node));
      if (parsed.length) {
        samples.push({ metric: "node_cpu_pct_of_allocatable", at: now, value: Math.max(...parsed.map((n) => n.cpuPct)) });
        samples.push({ metric: "node_memory_pct_of_allocatable", at: now, value: Math.max(...parsed.map((n) => n.memoryPct)) });
        capacity.push(...parsed.map((n) => `node ${n.node}: cpu ${n.cpuPct}% / memory ${n.memoryPct}% of allocatable`));
      }
    } else notes.push(`${context.name}: kubectl top nodes unavailable; node usage was not checked`);

    // Node conditions: a node under memory, disk or PID pressure evicts pods before any usage threshold trips.
    const described = await kubectl(config, "get", ["nodes", ...nodes.slice(0, 50), "-o", "json"], context);
    let nodeItems: Array<Record<string, any>> | undefined;
    try {
      nodeItems = described.stdout.trim() ? items(parseJson(described.stdout, "kubectl get nodes")) : undefined;
    } catch {
      nodeItems = undefined;
    }
    if (!nodeItems) notes.push(`${context.name}: node conditions unreadable (${redactText(described.stderr.trim() || "no output", { maxBytes: 120 })})`);
    for (const node of nodeItems ?? []) {
      const name = text(rec(node.metadata).name);
      for (const condition of records(rec(node.status).conditions)) {
        const type = text(condition.type);
        const bad = type === "Ready" ? text(condition.status) !== "True" : /Pressure$|Unavailable$/.test(type) && text(condition.status) === "True";
        if (!bad) continue;
        state_(
          `node:${name}:${type}`,
          "node",
          type === "Ready" ? `Node ${name} is not ready` : `Node ${name} has ${type}`,
          `node/${name} ${type}=${text(condition.status)}: ${redactText(text(condition.message, text(condition.reason)), { maxBytes: 200 })}`,
          `${where} describe node ${name}`,
        );
      }
    }
  }

  const quotas = await kubectl(config, "get", ["resourcequota", "-o", "json"], context);
  let quotaItems: Array<Record<string, any>> | undefined;
  try {
    quotaItems = quotas.code === 0 ? items(parseJson(quotas.stdout, "kubectl get resourcequota")) : undefined;
  } catch {
    quotaItems = undefined;
  }
  if (!quotaItems) notes.push(`${context.name}: resource quotas unreadable`);
  for (const quota of quotaItems ?? []) {
    const hard = rec(rec(quota.status).hard);
    const used = rec(rec(quota.status).used);
    for (const [resource, limit] of Object.entries(hard)) {
      const parse = resource.includes("cpu") ? parseCpu : resource.includes("memory") || resource.includes("storage") ? parseMemory : num;
      const h = parse(limit);
      const u = parse(used[resource] ?? "0");
      if (!h || u === undefined || !Number.isFinite(u)) continue;
      const pct = Number(((u / h) * 100).toFixed(2));
      samples.push({ metric: `quota_${resource.replace(/[^a-z0-9]+/gi, "_")}_pct`, at: now, value: pct });
      capacity.push(`quota ${text(rec(quota.metadata).name)}/${resource}: ${text(used[resource], "0")} of ${text(limit)} (${pct}%)`);
    }
  }

  const from = context.env.deployedCommit?.source === context.name ? context.env.deployedCommit.from : undefined;
  return {
    signals,
    samples,
    notes,
    revisions: revisionsOf(pods, from ?? "image-tag"),
    capacity: [`${scope}, ${pods.length} pod(s) for ${config.selector}`, ...capacity].join("\n"),
  };
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "none";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}Gi` : `${Math.round(bytes / 1024 ** 2)}Mi`;
}

export const kubernetesSource: SourceType = {
  type: "kubernetes",
  queryHelp:
    'args, one of: { operation: "logs", pod, container?, previous? } | { operation: "get", resource, name?, selector? } | { operation: "describe", resource, name } | { operation: "top", resource: "pods" | "nodes" }. Runs kubectl read-only in this environment\'s context and namespace; resources are pods, events, nodes, workloads, autoscalers, services and quotas, never secrets. For logs, since/until bound the output.',
  validate: (config) =>
    ["context", "namespace", "selector"].flatMap((key) =>
      typeof config[key] === "string" && config[key] ? [] : [`kubernetes source needs "${key}"`],
    ),
  collect,
  query: async (raw, input, context) => {
    const config = kubernetesConfig(raw);
    const { verb, args } = agentKubectl(input.args);
    const extra = verb === "logs" ? [`--since-time=${iso(input.since)}`] : [];
    const result = await kubectl(config, verb, [...args, ...extra], context, 2 * 1024 * 1024);
    let text = result.code === 0 ? result.stdout : `kubectl failed: ${result.stderr}`;
    if (verb === "logs" && result.code === 0) {
      text = text
        .split("\n")
        .filter((line) => {
          const parsed = parseLogLine(line);
          return !parsed || parsed.at < input.until;
        })
        .slice(-400)
        .join("\n");
    }
    return redactText(text, { maxBytes: 24_000 });
  },
};
