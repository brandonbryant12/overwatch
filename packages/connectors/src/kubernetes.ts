import type { KubernetesEnvConfigSchema } from "@overwatch/domain";
import type * as Schema from "effect/Schema";
import { redactText } from "./redactor.ts";
import type { ConnectorProbeResult, K8sWarningEvent, PodSnapshot } from "./types.ts";

export type KubernetesEnvConfig = typeof KubernetesEnvConfigSchema.Type;

const MUTATING_KUBECTL_VERBS = new Set([
  "apply",
  "create",
  "delete",
  "patch",
  "replace",
  "scale",
  "rollout",
  "edit",
  "exec",
  "cp",
  "cordon",
  "drain",
  "taint",
  "label",
  "annotate",
]);

/**
 * Always enforces read-only kubectl verbs and explicit `--context`, `--namespace`, and `--request-timeout=10s`.
 */
export async function runReadOnlyKubectl(
  config: KubernetesEnvConfig,
  verb: string,
  extraArgs: ReadonlyArray<string>,
): Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }> {
  if (MUTATING_KUBECTL_VERBS.has(verb.toLowerCase())) {
    throw new Error(`Mutating kubectl verb "${verb}" is hard-denied by Overwatch policy.`);
  }
  const args = [
    "--context",
    config.context,
    "--namespace",
    config.namespace,
    "--request-timeout=10s",
    verb,
    ...extraArgs,
  ];
  const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { ok: exitCode === 0, stdout, stderr };
}

export function classifyKubectlError(stderr: string): {
  readonly coverage: "auth_expired" | "unreachable";
  readonly detail: string;
  readonly remediation: string;
} {
  const lower = stderr.toLowerCase();
  if (
    lower.includes("unauthorized") ||
    lower.includes("expired") ||
    lower.includes("sso") ||
    lower.includes("get-token") ||
    lower.includes("forbidden")
  ) {
    return {
      coverage: "auth_expired",
      detail: redactText(stderr.trim() || "Kubernetes authentication expired", { maxBytes: 240 }),
      remediation: "Run `aws sso login` or refresh your EKS kubeconfig credentials.",
    };
  }
  return {
    coverage: "unreachable",
    detail: redactText(stderr.trim() || "Cluster API unreachable", { maxBytes: 240 }),
    remediation: "Check VPN connection and cluster reachability.",
  };
}

export async function probeKubernetes(config: KubernetesEnvConfig): Promise<ConnectorProbeResult> {
  const now = Date.now();
  try {
    const res = await runReadOnlyKubectl(config, "get", [
      "pods",
      "-l",
      config.selector,
      "-o",
      "name",
    ]);
    if (!res.ok) {
      const classified = classifyKubectlError(res.stderr);
      return {
        connector: "kubernetes",
        coverage: classified.coverage,
        detail: classified.detail,
        remediation: classified.remediation,
        checkedAtMs: now,
      };
    }
    const count = res.stdout.trim().split("\n").filter(Boolean).length;
    return {
      connector: "kubernetes",
      coverage: "healthy",
      detail: `Matched ${count} pod(s) in ${config.context}/${config.namespace}`,
      checkedAtMs: now,
    };
  } catch (err) {
    return {
      connector: "kubernetes",
      coverage: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
      remediation: "Verify kubectl is installed and context exists in ~/.kube/config.",
      checkedAtMs: now,
    };
  }
}

export async function collectKubernetes(config: KubernetesEnvConfig): Promise<{
  readonly probe: ConnectorProbeResult;
  readonly pods: ReadonlyArray<PodSnapshot>;
  readonly warningEvents: ReadonlyArray<K8sWarningEvent>;
}> {
  const now = Date.now();
  const res = await runReadOnlyKubectl(config, "get", [
    "pods",
    "-l",
    config.selector,
    "-o",
    "json",
  ]);
  if (!res.ok) {
    const classified = classifyKubectlError(res.stderr);
    return {
      probe: {
        connector: "kubernetes",
        coverage: classified.coverage,
        detail: classified.detail,
        remediation: classified.remediation,
        checkedAtMs: now,
      },
      pods: [],
      warningEvents: [],
    };
  }

  let items: Array<Record<string, any>> = [];
  try {
    const parsed = JSON.parse(res.stdout) as { items?: Array<Record<string, any>> };
    items = parsed.items ?? [];
  } catch {
    items = [];
  }

  // Optional best-effort pod metrics (gracefully omitted if Metrics Server unavailable)
  const metricsMap = new Map<string, { cpu: number; mem: number }>();
  const topRes = await runReadOnlyKubectl(config, "top", [
    "pods",
    "-l",
    config.selector,
    "--no-headers",
  ]).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  if (topRes.ok) {
    for (const line of topRes.stdout.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        const name = parts[0]!;
        const cpuStr = parts[1]!;
        const memStr = parts[2]!;
        const cpu = cpuStr.endsWith("m") ? Number(cpuStr.slice(0, -1)) : Number(cpuStr) * 1000;
        const mem = memStr.endsWith("Mi") ? Number(memStr.slice(0, -2)) : Number(memStr);
        metricsMap.set(name, {
          cpu: Number.isFinite(cpu) ? cpu : 0,
          mem: Number.isFinite(mem) ? mem : 0,
        });
      }
    }
  }

  const pods: PodSnapshot[] = items.map((item) => {
    const meta = item.metadata ?? {};
    const spec = item.spec ?? {};
    const status = item.status ?? {};
    const statuses: Array<Record<string, any>> = status.containerStatuses ?? [];
    const readyCount = statuses.filter((c) => c.ready).length;
    const totalCount = Math.max(1, statuses.length);
    const restarts = statuses.reduce((acc, c) => acc + (Number(c.restartCount) || 0), 0);
    const lastTerm = statuses.find((c) => c.lastState?.terminated?.reason)?.lastState?.terminated
      ?.reason as string | undefined;
    const waitingReason = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting?.reason as
      | string
      | undefined;
    const image: string = spec.containers?.[0]?.image ?? "unknown:latest";
    const imageTag = image.includes(":") ? image.split(":").pop()! : "latest";
    const revision =
      (meta.labels?.["pod-template-hash"] as string | undefined) ??
      (meta.annotations?.["deployment.kubernetes.io/revision"] as string | undefined) ??
      "rev-1";
    const m = metricsMap.get(meta.name);
    const phase: PodSnapshot["phase"] =
      waitingReason === "CrashLoopBackOff"
        ? "CrashLoopBackOff"
        : status.phase === "Pending"
          ? "Pending"
          : status.phase === "Failed"
            ? "Failed"
            : "Running";

    return {
      name: String(meta.name ?? "unknown-pod"),
      namespace: config.namespace,
      revision,
      track: meta.labels?.track === "canary" ? "canary" : "stable",
      imageTag,
      ready: `${readyCount}/${totalCount}`,
      phase,
      restarts,
      lastTerminationReason: lastTerm,
      cpuMillicores: m?.cpu ?? 0,
      cpuRequestMillicores: 250,
      cpuLimitMillicores: 1000,
      memoryMiB: m?.mem ?? 0,
      memoryRequestMiB: 256,
      memoryLimitMiB: 1024,
      nodeName: String(spec.nodeName ?? "eks-node"),
      sampledAtMs: now,
    };
  });

  const eventsRes = await runReadOnlyKubectl(config, "get", [
    "events",
    "--field-selector",
    "type=Warning",
    "-o",
    "json",
  ]).catch(() => ({ ok: false, stdout: "", stderr: "" }));

  const warningEvents: K8sWarningEvent[] = [];
  if (eventsRes.ok) {
    try {
      const parsed = JSON.parse(eventsRes.stdout) as { items?: Array<Record<string, any>> };
      for (const ev of (parsed.items ?? []).slice(0, 20)) {
        warningEvents.push({
          reason: String(ev.reason ?? "Warning"),
          message: redactText(String(ev.message ?? ""), { maxBytes: 400 }),
          objectName: String(ev.involvedObject?.name ?? "unknown"),
          count: Number(ev.count ?? 1),
          lastTimestampMs: Date.parse(ev.lastTimestamp ?? ev.eventTime ?? "") || now,
        });
      }
    } catch {
      // ignore malformed event stream
    }
  }

  return {
    probe: {
      connector: "kubernetes",
      coverage: "healthy",
      detail: `Collected ${pods.length} pod(s) from ${config.context}/${config.namespace}`,
      checkedAtMs: now,
    },
    pods,
    warningEvents,
  };
}

export async function fetchPodLogs(
  config: KubernetesEnvConfig,
  podName: string,
  tailLines = 80,
): Promise<string> {
  const res = await runReadOnlyKubectl(config, "logs", [
    podName,
    "--tail",
    String(Math.min(tailLines, 200)),
  ]);
  return redactText(res.ok ? res.stdout : res.stderr, { maxBytes: 8192 });
}
