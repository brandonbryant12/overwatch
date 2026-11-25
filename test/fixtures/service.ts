/** Starts the service for a test: a temporary data directory, a fake cluster, and no OpenCode unless given one. */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { OverwatchApi } from "../../src/domain/model.ts";
import { parseConfig } from "../../src/service/config.ts";
import type { OpenCodePort } from "../../src/service/opencode.ts";
import { startService, type ServiceDeps } from "../../src/service/service.ts";
import { fakeCluster } from "./cluster.ts";
import { tempDir } from "./support.ts";

export const offline: OpenCodePort = {
  connect: async () => undefined,
  createSession: async () => {
    throw new Error("offline");
  },
  prompt: async () => {
    throw new Error("offline");
  },
  promptState: async () => ({ kind: "session-missing" }),
  interrupt: async () => undefined,
  answer: async () => undefined,
};

export function testConfig(dataDir: string, extra: Record<string, unknown> = {}) {
  return parseConfig({
    apps: {
      "shop-api": {
        checkout: (extra.checkout as string) ?? `${dataDir}/no-checkout`,
        environments: {
          production: { sources: { pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api" } } },
        },
      },
    },
    watchers: [{ app: "shop-api", environment: "production", every: "10m" }],
    dataDir,
    lookback: { initial: "1h", slice: "1h", overlap: "2m", max: "14d" },
    notify: false,
    opencode: { autoInvestigate: false, ...(extra.opencode as object) },
  });
}

export async function testService(options: { dataDir?: string; opencode?: OpenCodePort; deps?: Partial<ServiceDeps>; config?: Record<string, unknown> } = {}) {
  const dataDir = options.dataDir ?? tempDir("service");
  const cluster = fakeCluster();
  const config = testConfig(dataDir, options.config);
  if (config.errors.length) throw new Error(config.errors.join("\n"));
  const service = await startService(config, {
    exec: cluster.exec,
    opencode: options.opencode ?? offline,
    port: 0,
    background: false,
    log: () => undefined,
    ...options.deps,
  });
  const client = <A, E>(f: (api: typeof OverwatchApi.Client.Service) => Effect.Effect<A, E, any>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* OverwatchApi.client;
        return yield* f(api as never);
      }).pipe(
        Effect.scoped,
        Effect.provide(Domain.protocolHttp(`${service.url}/api`).pipe(Layer.provide(FetchHttpClient.layer))),
      ) as Effect.Effect<A, E, never>,
    );
  return { service, cluster, dataDir, config, client };
}
