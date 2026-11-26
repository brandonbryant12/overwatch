/**
 * Kubernetes through `kubectl`, read-only. Only `get`, `describe`, `logs` and `top` run, always with the configured
 * context and namespace, and only with the flags and value shapes listed here: an allowlist, so anything else is
 * refused before a process starts. Logs are read line by line with a byte cap; nothing builds a list of all it read.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run, type Result } from "./exec.ts";

const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._\/=!,() -]{0,250}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const READABLE = new Set(["pods", "events", "deployments", "replicasets", "statefulsets"]);
const FLAGS: Readonly<Record<string, Readonly<Record<string, RegExp | null>>>> = {
  get: { "-l": SELECTOR, "-o": /^json$/ },
  describe: {},
  logs: { "-c": NAME, "--timestamps": null, "--previous": null, "--since-time": ISO },
  top: { "-l": SELECTOR, "--containers": null, "--no-headers": null },
};

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

export async function kubectl(t: Target, verb: string, args: ReadonlyArray<string>): Promise<Result> {
  checkKubectl(verb, args);
  return run("kubectl", [...base(t), verb, ...args], { timeoutMs: 60_000 });
}

export interface LogRead {
  readonly code: number;
  readonly stderr: string;
  /** Stopped at the byte cap: what was not read is unknown. */
  readonly capped: boolean;
  /** The last line had no newline (a killed or capped command): it was dropped. */
  readonly cutTail: boolean;
}

/**
 * Streams `kubectl logs --timestamps` for one container instance, calling `line` for each complete line. Raw bytes
 * (timestamps and newlines included) count toward `maxBytes`; past it the process is killed and the rest is capped.
 */
export function streamLogs(
  t: Target,
  pod: string,
  container: string,
  since: string,
  previous: boolean,
  maxBytes: number,
  line: (stamp: string, text: string) => void,
): Promise<LogRead> {
  const args = [pod, "-c", container, "--timestamps", `--since-time=${since}`, ...(previous ? ["--previous"] : [])];
  checkKubectl("logs", args);
  return new Promise((resolve) => {
    const child = spawn("kubectl", [...base(t), "logs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, capped = false, pending = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (capped) return;
      const size = Buffer.byteLength(chunk);
      let text = chunk;
      if (bytes + size > maxBytes) {
        text = Buffer.from(chunk).subarray(0, maxBytes - bytes).toString("utf8");
        capped = true;
        child.kill("SIGKILL");
      }
      bytes += Buffer.byteLength(text);
      pending += text;
      let cut: number;
      while ((cut = pending.indexOf("\n")) >= 0) {
        const raw = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        const space = raw.indexOf(" ");
        if (space > 0) line(raw.slice(0, space), raw.slice(space + 1));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({ code: capped ? 0 : code, stderr, capped, cutTail: !capped && pending.length > 0 });
    };
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });
}

export interface Instance {
  readonly id: string;
  readonly previous: boolean;
}
export interface Pod {
  readonly name: string;
  readonly uid: string;
  readonly containers: ReadonlyArray<{ readonly name: string; readonly instances: ReadonlyArray<Instance>; readonly memoryLimit: number | null }>;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
  for (const item of list(rec(JSON.parse(stdout)).items)) {
    const meta = rec(rec(item).metadata), spec = rec(rec(item).spec), status = rec(rec(item).status);
    const name = str(meta.name), uid = str(meta.uid);
    if (!name || !uid || !NAME.test(name)) continue;
    const statuses = list(status.containerStatuses).map(rec);
    const containers = list(spec.containers).map(rec).flatMap((c) => {
      const cname = str(c.name);
      if (!cname || !NAME.test(cname)) return [];
      const s = statuses.find((x) => x.name === cname) ?? {};
      const current = str(s.containerID);
      const previous = str(rec(rec(s.lastState).terminated).containerID);
      const limit = str(rec(rec(c.resources).limits).memory);
      return [{
        name: cname,
        instances: [...(previous ? [{ id: previous, previous: true }] : []), ...(current ? [{ id: current, previous: false }] : [])],
        memoryLimit: limit ? bytes(limit) : null,
      }];
    });
    pods.push({ name, uid, containers });
  }
  return pods.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
}

/** The running revision: the pod template's `overwatch.dev/revision` annotation, else an image tag that is a SHA. */
export function parseRevision(stdout: string): string | null {
  for (const item of list(rec(JSON.parse(stdout)).items)) {
    const template = rec(rec(rec(item).spec).template);
    const annotated = str(rec(rec(template.metadata).annotations)["overwatch.dev/revision"]);
    if (annotated) return annotated;
    for (const c of list(rec(template.spec).containers)) {
      const tag = /[:@](?:sha256:)?([0-9a-f]{7,64})$/.exec(String(rec(c).image ?? ""))?.[1];
      if (tag) return tag;
    }
  }
  return null;
}

export interface KubeEvent {
  readonly uid: string;
  readonly count: number;
  readonly reason: string;
  readonly message: string;
  readonly type: string;
  readonly at: number;
}

export function parseEvents(stdout: string): KubeEvent[] {
  return list(rec(JSON.parse(stdout)).items).map(rec).flatMap((e) => {
    const uid = str(rec(e.metadata).uid);
    if (!uid) return [];
    const at = Date.parse(String(e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? ""));
    return [{ uid, count: Math.max(1, Number(e.count) || 1), reason: String(e.reason ?? "Event"), message: String(e.message ?? ""), type: String(e.type ?? "Normal"), at: Number.isFinite(at) ? at : 0 }];
  });
}

/** `kubectl top pod --containers --no-headers`: pod, container, cpu, memory. */
export function parseTop(stdout: string): Array<{ pod: string; container: string; memory: number }> {
  return stdout.split("\n").flatMap((l) => {
    const [pod, container, , memory] = l.trim().split(/\s+/);
    const m = memory ? bytes(memory) : null;
    return pod && container && m !== null && !/^POD$/i.test(pod) ? [{ pod, container, memory: m }] : [];
  });
}
