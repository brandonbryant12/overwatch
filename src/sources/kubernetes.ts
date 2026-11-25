import { iso } from "../duration.ts";
import type { ExecResult } from "../exec.ts";
import type { SourceConfig } from "../options.ts";
import { redactText } from "../redact.ts";
import { normalizeMessage, shortHash, type Occurrence, type Sample, type Signal } from "../signals.ts";
import { emptyResult, str, type CollectResult, type SourceContext, type SourceType } from "./types.ts";

/**
 * Kubernetes through the `kubectl` CLI only, read-only.
 *
 * Only `get`, `describe`, `logs` and `top` run, always with the configured context and namespace. Limits, usage and
 * capacity are read from the cluster (pod spec, `kubectl top`, resource quotas, node allocatable); none are assumed.
 */
export const READ_ONLY_VERBS = new Set(["get", "describe", "logs", "top"]);

const FORBIDDEN_FLAGS = [
  "--context",
  "--namespace",
  "-n",
  "--kubeconfig",
  "--server",
  "-s",
  "--token",
  "--as",
  "--as-group",
  "--as-uid",
  "--user",
  "--cluster",
  "--all-namespaces",
  "-A",
  "--raw",
];

const SECRET_RESOURCE = /^(secrets?|secret\/.*|secrets\/.*)$/i;

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

/** Rejects anything that is not a read-only verb, or that would change cluster, namespace or identity. */
export function checkKubectlArgs(verb: string, args: ReadonlyArray<string>): void {
  if (!READ_ONLY_VERBS.has(verb)) {
    throw new Error(`kubectl ${verb} is not allowed; Overwatch only runs get, describe, logs and top`);
  }
  for (const arg of args) {
    const flag = arg.split("=")[0]!;
    if (FORBIDDEN_FLAGS.includes(flag)) throw new Error(`kubectl flag ${flag} is not allowed`);
    if ((verb === "get" || verb === "describe") && arg.split(",").some((part) => SECRET_RESOURCE.test(part))) {
      throw new Error("Reading secrets is not allowed");
    }
  }
}

export async function kubectl(
  config: KubernetesConfig,
  verb: string,
  args: ReadonlyArray<string>,
  context: Pick<SourceContext, "exec" | "signal" | "options">,
  maxBytes?: number,
): Promise<ExecResult> {
  checkKubectlArgs(verb, args);
  return context.exec(
    "kubectl",
    ["--context", config.context, "--namespace", config.namespace, "--request-timeout=20s", verb, ...args],
    {
      timeoutMs: context.options.timeouts.sourceMs,
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

interface PodInfo {
  readonly name: string;
  readonly node?: string;
  readonly startedAt?: number;
  readonly ready: boolean;
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

export function parsePods(json: string): PodInfo[] {
  const items = (JSON.parse(json) as { items?: Array<Record<string, any>> }).items ?? [];
  return items.map((item) => {
    const status = item.status ?? {};
    const conditions: Array<Record<string, any>> = status.conditions ?? [];
    return {
      name: String(item.metadata?.name ?? ""),
      ...(item.spec?.nodeName ? { node: String(item.spec.nodeName) } : {}),
      ...(status.startTime ? { startedAt: Date.parse(status.startTime) } : {}),
      ready: conditions.some((c) => c.type === "Ready" && c.status === "True"),
      containers: (item.spec?.containers ?? []).map((c: Record<string, any>) => ({
        name: String(c.name),
        image: String(c.image ?? ""),
        requests: { cpu: parseCpu(c.resources?.requests?.cpu), memory: parseMemory(c.resources?.requests?.memory) },
        limits: { cpu: parseCpu(c.resources?.limits?.cpu), memory: parseMemory(c.resources?.limits?.memory) },
      })),
      statuses: status.containerStatuses ?? [],
      labels: item.metadata?.labels ?? {},
      annotations: item.metadata?.annotations ?? {},
    };
  });
}

/** What is running, by `image-tag`, `label:<key>` or `annotation:<key>`. Most common first. */
export function revisionsOf(pods: ReadonlyArray<PodInfo>, from = "image-tag"): string[] {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    let value: string | undefined;
    if (from === "image-tag") {
      const image = pod.containers[0]?.image ?? "";
      const at = image.lastIndexOf("@");
      const tag = at >= 0 ? undefined : image.slice(image.lastIndexOf(":") + 1);
      value = tag && !tag.includes("/") ? tag : undefined;
    } else if (from.startsWith("label:")) value = pod.labels[from.slice(6)];
    else if (from.startsWith("annotation:")) value = pod.annotations[from.slice(11)];
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
  const raw = event.series?.lastObservedTime ?? event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp;
  return raw ? Date.parse(raw) : Number.NaN;
}

function ownedBy(name: string, pods: ReadonlyArray<PodInfo>, workload?: string): boolean {
  if (workload) return name === workload || name.startsWith(`${workload}-`);
  return pods.some((pod) => pod.name === name);
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
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    const text = parsed.msg ?? parsed.message ?? parsed.error;
    if (typeof text === "string") message = `${String(parsed.level ?? parsed.severity ?? "")} ${text}`.trim();
  } catch {
    // Plain text line.
  }
  return { at, message, ...(prefixed ? { container: prefixed[1]! } : {}) };
}

function group(
  into: Map<string, { signal: Omit<Signal, "occurrences" | "total">; occurrences: Occurrence[]; total: number }>,
  key: string,
  base: Omit<Signal, "occurrences" | "total">,
  occurrence: Occurrence,
) {
  const entry = into.get(key) ?? { signal: base, occurrences: [], total: 0 };
  entry.total++;
  if (entry.occurrences.length < 200) entry.occurrences.push(occurrence);
  into.set(key, entry);
}

async function collect(
  raw: SourceConfig,
  input: { window: { from: number; to: number }; final: boolean },
  context: SourceContext,
): Promise<CollectResult> {
  const config = kubernetesConfig(raw);
  const { window, final } = input;
  const scope = `${config.context}/${config.namespace}`;
  const podsResult = await kubectl(config, "get", ["pods", "-l", config.selector, "-o", "json"], context);
  if (podsResult.code !== 0) throw failure(podsResult, "get pods");
  const pods = parsePods(podsResult.stdout);
  const groups = new Map<string, { signal: Omit<Signal, "occurrences" | "total">; occurrences: Occurrence[]; total: number }>();
  const notes: string[] = [];

  const events = await kubectl(config, "get", ["events", "--field-selector", "type=Warning", "-o", "json"], context);
  if (events.code !== 0) throw failure(events, "get events");
  for (const event of (JSON.parse(events.stdout) as { items?: Array<Record<string, any>> }).items ?? []) {
    const at = eventTime(event);
    const object = event.involvedObject ?? {};
    if (!(at >= window.from && at < window.to) || !ownedBy(String(object.name ?? ""), pods, config.workload)) continue;
    const reason = String(event.reason ?? "Warning");
    const message = redactText(String(event.message ?? ""), { maxBytes: 400 });
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
        sample: `${iso(at)} ${object.kind ?? "Object"}/${object.name ?? "?"} ${reason}: ${message}`,
        query: `kubectl --context ${config.context} -n ${config.namespace} get events --field-selector type=Warning,reason=${reason}`,
      },
      { at, id: `${event.metadata?.uid ?? shortHash(message)}:${event.count ?? event.series?.count ?? 1}` },
    );
  }

  if (config.logs) {
    for (const pod of pods) {
      if (pod.startedAt !== undefined && pod.startedAt >= window.to) continue;
      const maxBytes = 4 * 1024 * 1024;
      const logs = await kubectl(
        config,
        "logs",
        [pod.name, "--all-containers", "--prefix", "--timestamps", `--since-time=${iso(window.from)}`, `--limit-bytes=${maxBytes}`],
        context,
        maxBytes,
      );
      if (logs.code !== 0 && !logs.killed) throw failure(logs, `logs ${pod.name}`);
      if (logs.stdout.length >= maxBytes) notes.push(`${context.name}: logs of ${pod.name} were capped at 4 MB for ${iso(window.from)}`);
      for (const line of logs.stdout.split("\n")) {
        const parsed = parseLogLine(line);
        if (!parsed || parsed.at < window.from || parsed.at >= window.to || !config.errorPattern.test(parsed.message)) continue;
        const message = redactText(parsed.message, { maxBytes: 400 });
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
            sample: `${iso(parsed.at)} ${pod.name}${parsed.container ? `/${parsed.container}` : ""} ${message}`,
            query: `kubectl --context ${config.context} -n ${config.namespace} logs -l ${config.selector} --all-containers --since-time=${iso(window.from)}`,
          },
          { at: parsed.at, id: `${pod.name}:${parsed.at}:${shortHash(parsed.message, 8)}` },
        );
      }
    }
  }

  // Container terminations (OOMKilled, Error) are one-off occurrences with their own timestamps.
  for (const pod of pods) {
    for (const status of pod.statuses) {
      const terminated = status.lastState?.terminated;
      const at = terminated?.finishedAt ? Date.parse(terminated.finishedAt) : Number.NaN;
      if (!terminated || !(at >= window.from && at < window.to)) continue;
      const reason = String(terminated.reason ?? "Terminated");
      const key = `terminated:${status.name}:${reason}`;
      group(
        groups,
        key,
        {
          source: context.name,
          kind: "pod",
          key,
          title: `${status.name} container ${reason} (exit ${terminated.exitCode ?? "?"})`,
          severity: "error",
          sample: `${iso(at)} ${pod.name}/${status.name} terminated: ${reason}, exit ${terminated.exitCode ?? "?"}`,
          query: `kubectl --context ${config.context} -n ${config.namespace} describe pod ${pod.name}`,
        },
        { at, id: `${pod.name}:${status.name}:${at}` },
      );
    }
  }

  const signals: Signal[] = [...groups.values()].map((g) => ({ ...g.signal, occurrences: g.occurrences, total: g.total }));
  if (!final) return { ...emptyResult, signals, notes };

  // Current state, read once per run.
  const now = window.to;
  for (const pod of pods) {
    for (const status of pod.statuses) {
      const waiting = status.state?.waiting?.reason;
      if (!waiting || waiting === "ContainerCreating" || waiting === "PodInitializing") continue;
      const key = `waiting:${status.name}:${waiting}`;
      if (signals.some((s) => s.key === key)) continue;
      signals.push({
        source: context.name,
        kind: "pod",
        key,
        title: `${status.name} is ${waiting}`,
        severity: "error",
        occurrences: [],
        total: 1,
        state: true,
        sample: `${pod.name}/${status.name} waiting: ${waiting} ${redactText(String(status.state.waiting.message ?? ""), { maxBytes: 200 })}`.trim(),
        query: `kubectl --context ${config.context} -n ${config.namespace} describe pod ${pod.name}`,
      });
    }
  }

  const samples: Sample[] = [{ metric: "not_ready_pods", at: now, value: pods.filter((p) => !p.ready).length }];
  const capacity: string[] = [];
  for (const pod of pods.slice(0, 3)) {
    for (const c of pod.containers) {
      capacity.push(
        `${pod.name}/${c.name} requests cpu ${c.requests.cpu ?? "none"}m mem ${fmtBytes(c.requests.memory)}, limits cpu ${c.limits.cpu ?? "none"}m mem ${fmtBytes(c.limits.memory)}`,
      );
    }
  }

  const top = await kubectl(config, "top", ["pods", "-l", config.selector, "--containers", "--no-headers"], context);
  if (top.code === 0) {
    const usage = usageSamples(pods, parseTopContainers(top.stdout), now);
    samples.push(...usage.samples);
    notes.push(...usage.notes.map((n) => `${context.name}: ${n}`));
  } else notes.push(`${context.name}: kubectl top pods unavailable (${redactText(top.stderr.trim(), { maxBytes: 160 })})`);

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
    } else notes.push(`${context.name}: kubectl top nodes unavailable`);
  }

  const quotas = await kubectl(config, "get", ["resourcequota", "-o", "json"], context);
  if (quotas.code === 0) {
    for (const quota of (JSON.parse(quotas.stdout) as { items?: Array<Record<string, any>> }).items ?? []) {
      const hard: Record<string, string> = quota.status?.hard ?? {};
      const used: Record<string, string> = quota.status?.used ?? {};
      for (const [resource, limit] of Object.entries(hard)) {
        const parse = resource.includes("cpu") ? parseCpu : resource.includes("memory") || resource.includes("storage") ? parseMemory : (v: unknown) => Number(v);
        const h = parse(limit);
        const u = parse(used[resource] ?? "0");
        if (!h || u === undefined || !Number.isFinite(u)) continue;
        const pct = Number(((u / h) * 100).toFixed(2));
        samples.push({ metric: `quota_${resource.replace(/[^a-z0-9]+/gi, "_")}_pct`, at: now, value: pct });
        capacity.push(`quota ${quota.metadata?.name}/${resource}: ${used[resource] ?? "0"} of ${limit} (${pct}%)`);
      }
    }
  } else notes.push(`${context.name}: resource quotas unreadable`);

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
    'args: { verb: "get" | "describe" | "logs" | "top", args: string[] }. Runs kubectl in this environment\'s context and namespace. For logs, since/until bound the output. Secrets and other namespaces are not readable.',
  validate: (config) =>
    ["context", "namespace", "selector"].flatMap((key) =>
      typeof config[key] === "string" && config[key] ? [] : [`kubernetes source needs "${key}"`],
    ),
  collect,
  query: async (raw, input, context) => {
    const config = kubernetesConfig(raw);
    const verb = String(input.args.verb ?? "get");
    const args = Array.isArray(input.args.args) ? input.args.args.map(String) : [];
    const extra = verb === "logs" && !args.some((a) => a.startsWith("--since")) ? [`--since-time=${iso(input.since)}`, "--timestamps"] : [];
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
