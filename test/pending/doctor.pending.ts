import { test, expect } from "../harness.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { laptop, root } from "./cli.ts";
import { LABEL } from "../../src/service/launchd.ts";

const checks = [
  "launchd",
  "cluster:staging",
  "cluster:production",
  "registry",
  "native",
  "opencode-found",
  "opencode-connected",
  "model",
] as const;
type Id = (typeof checks)[number];
type Report = { checks: Array<{ id: string; ok: boolean; detail: string; fix?: string }> };
type Ports = {
  agent: (label: string) => Promise<{ running: boolean }>;
  pods: (context: string, namespace: string) => Promise<string>;
  registry: () => Promise<number>;
  loadNative: () => Promise<void>;
  findOpenCode: () => Promise<string | undefined>;
  serverInfo: () => Promise<{ version: string }>;
  modelReply: (prompt: string) => Promise<string>;
};
type Doctor = (args: readonly string[], ports: Ports, write: (text: string) => void) => Promise<number>;

test("doctor interprets laptop observations, checks each configured context and gives an actionable remedy", async () => {
  const environments = Object.fromEntries(
    ["staging", "production"].map((context) => [
      context,
      { sources: { pods: { type: "kubernetes", context, namespace: "shop", selector: "app=shop" } } },
    ]),
  );
  const f = laptop({
    apps: { shop: { checkout: ".", environments } },
    watchers: Object.keys(environments).map((environment) => ({ app: "shop", environment })),
  });
  const { doctorCommand } = (await import(pathToFileURL(join(root, "src/service/doctor.ts")).href)) as { doctorCommand: Doctor };
  const remedies: Record<Id, RegExp> = {
    launchd: /overwatch launchd install/i,
    "cluster:staging": /sign in|log.?in|authenticate/i,
    "cluster:production": /sign in|log.?in|authenticate/i,
    registry: /npmrc|npm config|registry.*(url|proxy)/i,
    native: /install|rebuild/i,
    "opencode-found": /install|PATH/i,
    "opencode-connected": /opencode serve|start OpenCode/i,
    model: /configure|sign in|credentials|select a model/i,
  };
  for (const failed of [[], ...checks.map((id) => [id]), ["registry", "cluster:staging"]] as Id[][]) {
    const visited: Id[] = [];
    const fails = (id: Id) => {
      visited.push(id);
      return failed.includes(id);
    };
    const ports: Ports = {
      agent: async (label) => {
        expect(label).toBe(LABEL);
        return { running: !fails("launchd") };
      },
      pods: async (context, ns) => {
        expect(ns).toBe("shop");
        expect(["staging", "production"]).toContain(context);
        if (fails(("cluster:" + context) as Id)) throw Error("Unauthorized");
        return '{"items":[]}';
      },
      registry: async () => (fails("registry") ? 407 : 200),
      loadNative: async () => {
        if (fails("native")) throw Error("Native binding unavailable");
      },
      findOpenCode: async () => (fails("opencode-found") ? undefined : join(f.home, "bin/opencode")),
      serverInfo: async () => {
        if (fails("opencode-connected")) throw Error("ECONNREFUSED");
        return { version: "2.4.1" };
      },
      modelReply: async (prompt) => {
        expect(prompt.trim().length).toBeGreaterThan(0);
        return fails("model") ? "" : "OK";
      },
    };
    let out = "";
    const code = await doctorCommand(["--config", f.config, "--json"], ports, (line) => {
      out += line;
    });
    const report = JSON.parse(out) as Report;
    expect(report.checks.map((r) => r.id).sort()).toEqual([...checks].sort());
    expect(visited.sort()).toEqual([...checks].sort());
    expect(code === 0).toBe(failed.length === 0);
    for (const row of report.checks) {
      const id = row.id as Id;
      expect(row.ok).toBe(!failed.includes(id));
      if (!row.ok) {
        expect(row.detail.trim().length).toBeGreaterThan(0);
        expect(row.fix).toMatch(remedies[id]);
        if (id.startsWith("cluster:")) expect(row.fix).toContain(id.slice(8));
      }
    }
  }
});

test("the installed CLI dispatches doctor and reports failed laptop checks to automation", async () => {
  const f = laptop({ opencode: { url: "http://127.0.0.1:1" } });
  const bin = join(f.home, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  f.env.PATH = bin;
  f.env.npm_config_registry = "http://127.0.0.1:1";
  for (const name of ["launchctl", "kubectl", "opencode", "npm", "pnpm"])
    writeFileSync(join(bin, name), "#!/bin/sh\necho 'fixture unavailable' >&2\nexit 1\n", { mode: 0o755 });
  const result = await f.run(["doctor", "--json"]);
  expect(result.code).not.toBe(0);
  const rows = (JSON.parse(result.stdout) as Report).checks;
  expect(rows.some((r) => r.id === "cluster:prod" && !r.ok && !!r.fix)).toBe(true);
});
