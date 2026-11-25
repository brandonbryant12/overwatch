/**
 * A fake Kubernetes cluster behind a fake `kubectl`: one deployment's pods and a log the test appends to. `logs`
 * honours `--since-time`, as kubectl does, so overlapping polls see overlapping lines. Every call is recorded.
 */
import type { Exec, ExecResult } from "../../src/collect/exec.ts";

export interface FakeCluster {
  readonly exec: Exec & { calls: Array<{ command: string; args: ReadonlyArray<string> }> };
  /** Appends a log line at `at` (epoch ms) to pod `pod`. */
  readonly log: (at: number, message: string, pod?: string) => void;
  readonly lines: Array<{ at: number; pod: string; message: string }>;
}

export function fakeCluster(options: { readonly pods?: number; readonly image?: string } = {}): FakeCluster {
  const pods = Array.from({ length: options.pods ?? 1 }, (_, i) => `shop-api-${i + 1}`);
  const lines: FakeCluster["lines"] = [];
  const pod = (name: string) => ({
    metadata: { name, labels: { app: "shop-api" }, creationTimestamp: "2026-11-20T08:00:00Z" },
    spec: { nodeName: "node-a", containers: [{ name: "api", image: options.image ?? "registry.example/shop-api:9f8e7d6", resources: { limits: { cpu: "1", memory: "512Mi" } } }] },
    status: { phase: "Running", startTime: "2026-11-20T08:00:00Z", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "api", ready: true, restartCount: 0, state: { running: {} } }] },
  });
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", killed: false });
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const exec = Object.assign(
    async (command: string, args: ReadonlyArray<string>): Promise<ExecResult> => {
      calls.push({ command, args });
      if (command !== "kubectl") return { code: 127, stdout: "", stderr: `unexpected ${command}`, killed: false };
      const verb = args.slice(5);
      const has = (prefix: string) => verb.join(" ").startsWith(prefix);
      if (has("get pods")) return ok(JSON.stringify({ items: pods.map(pod) }));
      if (has("get events") || has("get resourcequota") || has("get nodes") || has("get deployments")) return ok(JSON.stringify({ items: [] }));
      if (has("top pods")) return ok(pods.map((p) => `${p} api 100m 100Mi`).join("\n"));
      if (has("top nodes")) return ok("node-a 100m 5% 100Mi 5%");
      if (verb[0] === "logs") {
        const name = verb[1]!;
        const since = verb.find((a) => a.startsWith("--since-time="))?.slice("--since-time=".length);
        const from = since ? Date.parse(since) : 0;
        const text = lines
          .filter((l) => l.pod === name && l.at >= from)
          .map((l) => `[pod/${name}/api] ${new Date(l.at).toISOString()} ${l.message}`)
          .join("\n");
        return ok(text ? `${text}\n` : "");
      }
      if (verb[0] === "describe") return ok("Name: node-a\nConditions:\n  Ready True\n");
      return { code: 1, stdout: "", stderr: `fake kubectl does not answer: ${verb.join(" ")}`, killed: false };
    },
    { calls },
  ) as FakeCluster["exec"];
  return { exec, lines, log: (at, message, podName = pods[0]!) => lines.push({ at, pod: podName, message }) };
}
