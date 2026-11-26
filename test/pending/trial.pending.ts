import { openCodePort } from "../../src/service/opencode.ts";
import { OpenCode } from "@opencode/client";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../harness.ts";
import { laptop, root } from "./cli.ts";
import { scriptedProvider } from "./scripted-provider.ts";
import { startService } from "../../src/service/service.ts";
import { parseConfig } from "../../src/service/config.ts";
import { fakeCluster } from "../fixtures/cluster.ts";
import { until } from "../fixtures/scenario.ts";

test("trial scores actual attempts from the configured OpenCode model against blinded seed answers", { timeout: 150_000 }, async () => {
  const f = laptop();
  const net = createServer();
  net.listen(0, "127.0.0.1");
  await once(net, "listening");
  const port = (net.address() as { port: number }).port;
  await new Promise<void>((r) => net.close(() => r()));
  const url = "http://127.0.0.1:" + port;
  const password = "pending-trial-only";
  f.env.OPENCODE_PASSWORD = password;
  f.env.OW_TEST_PASSWORD = password;
  f.env.TMPDIR = process.env.TMPDIR ?? "/tmp";
  const headers = { Authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
  const repo = join(f.home, "shop");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=Trial", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { env: f.env, encoding: "utf8" },
    ).trim();
  git("init", "-q");
  writeFileSync(join(repo, "payments.ts"), "export const TIMEOUT_MS = 300\n");
  git("add", ".");
  git("commit", "-qm", "deployed");
  const config = JSON.parse(readFileSync(f.config, "utf8"));
  config.apps["shop-api"].checkout = repo;
  config.opencode = { url, password: "env:OW_TEST_PASSWORD", autoInvestigate: false };
  const cluster = fakeCluster({ image: "example/shop:" + git("rev-parse", "HEAD").slice(0, 12) });
  const line = "ERROR payment 42 timed out after 300ms";
  cluster.log(Date.now() - 60_000, line);
  const provider = await scriptedProvider();
  const svc = await startService(parseConfig({ ...config, opencode: { url, autoInvestigate: false } }), {
    opencode: openCodePort({ url, password }),
    exec: cluster.exec,
    port: 0,
    background: false,
    notify: async () => {},
  });
  let oc: ReturnType<typeof spawn> | undefined;
  try {
    config.service = { port: Number(new URL(svc.url).port) };
    writeFileSync(f.config, JSON.stringify(config));
    const cases = join(f.home, "seeds.json");
    const seeds = ["real", "not_real"].map((verdict, i) => ({
      id: "payment-" + i,
      app: "shop-api",
      environment: "production",
      source: "pods",
      title: "Checkout timeout",
      sample: line,
      expected: {
        verdict,
        cause:
          i === 0 ? "Client deadline shorter than the payment provider latency" : "Planned synthetic timeout from the checkout monitor",
      },
    }));
    writeFileSync(cases, JSON.stringify(seeds));
    const pluginConfig = join(f.env.XDG_CONFIG_HOME!, "opencode");
    mkdirSync(pluginConfig, { recursive: true });
    writeFileSync(
      join(pluginConfig, "opencode.json"),
      JSON.stringify({
        model: "ow-e2e/e2e",
        providers: {
          "ow-e2e": {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: provider.url, apiKey: "fixture" },
            models: { e2e: { name: "E2E", limit: { context: 64000, output: 4000 } } },
          },
        },
        plugins: [{ package: root, options: { url: svc.url } }],
      }),
    );
    oc = spawn(process.env.OPENCODE_BIN ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: repo,
      env: f.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    oc.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    let spawnError: Error | undefined;
    oc.on("error", (e) => {
      spawnError = e;
    });
    await until(
      async () => {
        if (spawnError) throw spawnError;
        if (oc?.exitCode != null) throw Error("OpenCode exited: " + stderr);
        return OpenCode.make({ baseUrl: url, headers })
          .server.info({ signal: AbortSignal.timeout(1000) })
          .then(
            () => true,
            () => false,
          );
      },
      Boolean,
      15_000,
    );
    const clock = setInterval(() => {
      void svc.work().catch(() => undefined);
    }, 100);
    try {
      const result = await f.run(["trial", "--cases", cases, "--json"]);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as {
        cases: Array<{ id: string; filed: boolean; quotesMatched: number; quotesTotal: number; verdictRight: boolean; tries: number }>;
      };
      expect(report.cases.map((c) => c.id)).toEqual(seeds.map((s) => s.id));
      expect(report.cases.map((c) => c.verdictRight)).toEqual([true, false]);
      for (const row of report.cases) {
        expect(row.filed).toBe(true);
        expect(row.quotesMatched).toBe(2);
        expect(row.quotesTotal).toBe(2);
        expect(row.tries).toBe(3);
        expect(result.stderr).toContain(row.id);
      }
      expect(result.stderr).toMatch(/verdict|correct/i);
      expect(provider.requests.filter((x) => x.findingCalls).length).toBe(6);
      expect(provider.requests.every((x) => x.model === "e2e")).toBe(true);
      expect(provider.prompts.some((p) => seeds.some((s) => p.includes(s.expected.cause)))).toBe(false);
    } finally {
      clearInterval(clock);
    }
  } finally {
    if (oc?.pid && oc.exitCode === null && oc.signalCode === null) {
      const exit = once(oc, "exit");
      oc.kill();
      await exit;
    }
    await svc.stop();
    await provider.close();
  }
});
