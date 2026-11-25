import { defineEmulator } from "emulate";

export interface EmulatedPod {
  name: string;
  namespace: string;
  app: string;
  revision: string;
  track: "new" | "stable";
  imageTag: string;
  ready: boolean;
  restarts: number;
  lastTerminationReason?: string;
  cpuMillicores: number;
  memoryMiB: number;
  logs: string[];
}

export interface KubernetesEmulatorState {
  authExpiredNamespaces: string[];
  activeRevision: string;
  activeImageTag: string;
  pods: EmulatedPod[];
  warningEvents: Array<{
    namespace: string;
    reason: string;
    message: string;
    objectName: string;
    count: number;
    lastTimestamp: string;
  }>;
}

export function initialKubernetesState(): KubernetesEmulatorState {
  return {
    authExpiredNamespaces: ["checkout-staging"],
    activeRevision: "rev-482",
    activeImageTag: "9f31c2a",
    pods: [
      {
        name: "checkout-api-9f31c2a-7b4d",
        namespace: "checkout",
        app: "checkout-api",
        revision: "rev-482",
        track: "new",
        imageTag: "9f31c2a",
        ready: true,
        restarts: 0,
        cpuMillicores: 840,
        memoryMiB: 712,
        logs: [
          "2026-11-24T11:42:18Z INFO checkout-api started commit=9f31c2a revision=rev-482",
          "2026-11-24T11:43:04Z WARN POST /v1/checkout/confirm slow request duration_ms=2180 db_queries=47 cart_id=crt_991a",
          "2026-11-24T11:43:19Z ERROR POST /v1/checkout/confirm status=504 upstream timeout after 46 sequential pg.query calls",
        ],
      },
      {
        name: "checkout-api-9f31c2a-9c2f",
        namespace: "checkout",
        app: "checkout-api",
        revision: "rev-482",
        track: "new",
        imageTag: "9f31c2a",
        ready: true,
        restarts: 1,
        lastTerminationReason: "OOMKilled",
        cpuMillicores: 875,
        memoryMiB: 790,
        logs: [
          "2026-11-24T11:42:20Z INFO checkout-api started commit=9f31c2a revision=rev-482",
          "2026-11-24T11:43:11Z WARN pg pool saturation waiting=18 active=20 query=SELECT * FROM cart_line_items",
          "2026-11-24T11:43:42Z ERROR OOMKilled container=checkout-api limit=1024MiB",
        ],
      },
      {
        name: "checkout-api-4c88e1b-3a1e",
        namespace: "checkout",
        app: "checkout-api",
        revision: "rev-481",
        track: "stable",
        imageTag: "4c88e1b",
        ready: true,
        restarts: 0,
        cpuMillicores: 410,
        memoryMiB: 482,
        logs: [
          "2026-11-24T11:42:00Z INFO checkout-api steady commit=4c88e1b revision=rev-481",
          "2026-11-24T11:43:15Z INFO POST /v1/checkout/confirm status=200 duration_ms=410 db_queries=2",
        ],
      },
    ],
    warningEvents: [
      {
        namespace: "checkout",
        reason: "OOMKilling",
        message: "Memory cgroup out of memory: Killed process 42 (bun) in checkout-api-9f31c2a-9c2f",
        objectName: "checkout-api-9f31c2a-9c2f",
        count: 1,
        lastTimestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Stateful Kubernetes API emulator built with `vercel-labs/emulate` `defineEmulator`.
 * Serves pod inventories, streaming container logs, warning events, and rollout mutations.
 */
export const kubernetesEmulator = defineEmulator<KubernetesEmulatorState>({
  name: "overwatch-kubernetes",
  stateVersion: 1,
  state: initialKubernetesState,
  setup({ app, state }) {
    app.get("/api/v1/namespaces/:ns/pods", (c) => {
      const ns = c.req.param("ns");
      if (state.authExpiredNamespaces.includes(ns)) {
        return c.json({ kind: "Status", status: "Failure", reason: "Unauthorized", code: 401 }, 401);
      }
      const items = state.pods
        .filter((p) => p.namespace === ns)
        .map((p) => ({
          metadata: {
            name: p.name,
            namespace: p.namespace,
            labels: { app: p.app, "pod-template-hash": p.revision, track: p.track },
          },
          spec: {
            nodeName: "ip-10-42-14-88.ec2.internal",
            containers: [{ name: p.app, image: `registry.local/${p.app}:${p.imageTag}` }],
          },
          status: {
            phase: "Running",
            containerStatuses: [
              {
                name: p.app,
                ready: p.ready,
                restartCount: p.restarts,
                lastState: p.lastTerminationReason
                  ? { terminated: { reason: p.lastTerminationReason } }
                  : {},
              },
            ],
          },
          metrics: { cpuMillicores: p.cpuMillicores, memoryMiB: p.memoryMiB },
        }));
      return c.json({ apiVersion: "v1", kind: "PodList", items });
    });

    app.get("/api/v1/namespaces/:ns/pods/:name/log", (c) => {
      const ns = c.req.param("ns");
      const name = c.req.param("name");
      if (state.authExpiredNamespaces.includes(ns)) {
        return c.text("Unauthorized: EKS SSO token expired", 401);
      }
      const pod = state.pods.find((p) => p.namespace === ns && p.name === name);
      if (!pod) return c.text("Pod not found", 404);
      const tail = Number(c.req.query("tailLines") ?? "100");
      return c.text(pod.logs.slice(-tail).join("\n"));
    });

    app.get("/api/v1/namespaces/:ns/events", (c) => {
      const ns = c.req.param("ns");
      const items = state.warningEvents
        .filter((e) => e.namespace === ns)
        .map((e) => ({
          type: "Warning",
          reason: e.reason,
          message: e.message,
          count: e.count,
          lastTimestamp: e.lastTimestamp,
          involvedObject: { name: e.objectName },
        }));
      return c.json({ apiVersion: "v1", kind: "EventList", items });
    });

    // Control plane: deploy a new healthy (or regressed) revision!
    app.post("/overwatch-control/deploy", async (c) => {
      const body = (await c.req.json()) as {
        revision: string;
        imageTag: string;
        healthy: boolean;
      };
      state.activeRevision = body.revision;
      state.activeImageTag = body.imageTag;
      state.pods = [
        {
          name: `checkout-api-${body.imageTag}-a101`,
          namespace: "checkout",
          app: "checkout-api",
          revision: body.revision,
          track: "new",
          imageTag: body.imageTag,
          ready: true,
          restarts: 0,
          cpuMillicores: body.healthy ? 375 : 855,
          memoryMiB: body.healthy ? 465 : 780,
          logs: body.healthy
            ? [
                `${new Date().toISOString()} INFO checkout-api started commit=${body.imageTag} revision=${body.revision}`,
                `${new Date().toISOString()} INFO POST /v1/checkout/confirm status=200 duration_ms=42 db_queries=1 batched=true`,
              ]
            : [
                `${new Date().toISOString()} WARN POST /v1/checkout/confirm duration_ms=2150 db_queries=46`,
              ],
        },
        {
          name: `checkout-api-${body.imageTag}-b202`,
          namespace: "checkout",
          app: "checkout-api",
          revision: body.revision,
          track: "new",
          imageTag: body.imageTag,
          ready: true,
          restarts: 0,
          cpuMillicores: body.healthy ? 390 : 870,
          memoryMiB: body.healthy ? 472 : 795,
          logs: body.healthy
            ? [
                `${new Date().toISOString()} INFO checkout-api started commit=${body.imageTag} revision=${body.revision}`,
                `${new Date().toISOString()} INFO POST /v1/checkout/confirm status=200 duration_ms=44 db_queries=1 batched=true`,
              ]
            : [
                `${new Date().toISOString()} ERROR POST /v1/checkout/confirm status=504 upstream timeout`,
              ],
        },
      ];
      if (body.healthy) state.warningEvents = [];
      return c.json({ ok: true, revision: state.activeRevision, healthy: body.healthy });
    });
  },
});
