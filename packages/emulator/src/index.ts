import { createEmulator } from "emulate";
import { datadogEmulator } from "./datadog.ts";
import { jenkinsEmulator } from "./jenkins.ts";
import { kubernetesEmulator } from "./kubernetes.ts";

export { kubernetesEmulator } from "./kubernetes.ts";
export { datadogEmulator } from "./datadog.ts";
export { jenkinsEmulator } from "./jenkins.ts";

export interface OverwatchEmulatorStack {
  readonly kubernetesUrl: string;
  readonly datadogUrl: string;
  readonly jenkinsUrl: string;
  readonly githubUrl: string;
  readonly githubRepo: string;
  readonly githubToken: string;
  /** Deploys a fixed (or regressed) build across Jenkins -> Kubernetes -> Datadog in lockstep. */
  readonly deployRelease: (input: {
    readonly commitSha: string;
    readonly commitMessage: string;
    readonly healthy: boolean;
  }) => Promise<{ readonly buildNumber: number; readonly revision: string }>;
  readonly close: () => Promise<void>;
}

/**
 * Boots the complete 4-service stateful local ops emulator stack powered by `vercel-labs/emulate`:
 * - Custom Kubernetes API + pod logs + events emulator
 * - Custom Datadog Logs + APM + paired trace-diff emulator
 * - Custom Jenkins Pipeline emulator
 * - Official `vercel-labs/emulate` stateful GitHub API emulator (repos, issues, PRs, tokens)
 */
export async function startOverwatchEmulatorStack(options?: {
  readonly basePort?: number;
}): Promise<OverwatchEmulatorStack> {
  const base = options?.basePort ?? 0;

  const [k8s, dd, jk, gh] = await Promise.all([
    createEmulator({ service: kubernetesEmulator, port: base ? base : 0, shutdownTimeout: 100 }),
    createEmulator({ service: datadogEmulator, port: base ? base + 1 : 0, shutdownTimeout: 100 }),
    createEmulator({ service: jenkinsEmulator, port: base ? base + 2 : 0, shutdownTimeout: 100 }),
    createEmulator({
      service: "github",
      port: base ? base + 3 : 0,
    }),
  ]);

  // Seed checkout-api repository on official vercel-labs/emulate GitHub service
  const repoResp = await fetch(`${gh.url}/user/repos`, {
    method: "POST",
    headers: {
      authorization: "Bearer ghp_overwatch_emu_token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "checkout-api",
      description: "Emulated checkout-api repository for Overwatch closed-loop verification",
      private: false,
      auto_init: true,
    }),
  });
  const repoJson = (await repoResp.json().catch(() => ({}))) as { full_name?: string };
  const githubRepo = repoJson.full_name ?? "admin/checkout-api";

  const deployRelease = async (input: {
    readonly commitSha: string;
    readonly commitMessage: string;
    readonly healthy: boolean;
  }) => {
    const jkResp = (await (
      await jk.request("/overwatch-control/trigger-build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commitSha: input.commitSha,
          commitMessage: input.commitMessage,
          result: "SUCCESS",
        }),
      })
    ).json()) as { buildNumber: number };

    const revision = `rev-${jkResp.buildNumber}`;
    const shortSha = input.commitSha.slice(0, 7);

    await k8s.request("/overwatch-control/deploy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision,
        imageTag: shortSha,
        healthy: input.healthy,
      }),
    });

    await dd.request("/overwatch-control/set-health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        degraded: !input.healthy,
        releaseVersion: shortSha,
      }),
    });

    return { buildNumber: jkResp.buildNumber, revision };
  };

  return {
    kubernetesUrl: k8s.url,
    datadogUrl: dd.url,
    jenkinsUrl: jk.url,
    githubUrl: gh.url,
    githubRepo,
    githubToken: "ghp_overwatch_emu_token",
    deployRelease,
    close: async () => {
      await Promise.race([
        Promise.all([k8s.close(), dd.close(), jk.close(), gh.close()]),
        new Promise((r) => setTimeout(r, 300)),
      ]);
    },
  };
}
