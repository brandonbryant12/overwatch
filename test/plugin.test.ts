/** The thin plugin: no Effect at run time, deny-by-default permissions, and what it registers with OpenCode. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_VERSION as SERVICE_API_VERSION } from "../src/domain/model.ts";
import { EXPOSED_TOOL_NAMES, SESSION_TOOL_NAMES } from "../src/service/mcp.ts";
import plugin, { API_VERSION, checkService, investigatorPermissions } from "../src/plugin/index.ts";
import { describe, expect, test } from "./harness.ts";

const PLUGIN = fileURLToPath(new URL("../src/plugin/index.ts", import.meta.url));

describe("the plugin", () => {
  test("loads with no Effect, no Alchemy and no domain code at run time", () => {
    // A resolve hook records every module the plugin pulls in.
    const hook = `
      import { register } from "node:module";
      register("data:text/javascript," + encodeURIComponent(\`
        export async function resolve(specifier, context, next) {
          const result = await next(specifier, context);
          process.stderr.write("LOADED " + result.url + "\\\\n");
          return result;
        }\`));`;
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", `data:text/javascript,${encodeURIComponent(hook)}`, "-e", `await import(${JSON.stringify(PLUGIN)})`], {
      encoding: "utf8",
      input: "",
    });
    const loaded = run.stderr.split("\n").filter((l) => l.startsWith("LOADED ")).map((l) => l.slice(7));
    expect(run.status).toBe(0);
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.filter((url) => /effect|alchemy|src\/domain|src\/service|src\/host/.test(url))).toEqual([]);
    // And statically: every import from those packages in the plugin is type-only.
    const source = readFileSync(PLUGIN, "utf8");
    for (const line of source.split("\n").filter((l) => l.startsWith("import "))) {
      if (/@opencode|effect|alchemy/.test(line)) expect(line).toMatch(/^import type /);
    }
  });

  test("speaks the service's Api version", () => {
    expect(API_VERSION).toBe(SERVICE_API_VERSION);
  });

  test("the investigator is denied everything first, then allowed reading code, read-only git and Overwatch's tools", () => {
    const rules = investigatorPermissions();
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const allowed = rules.filter((r) => r.effect === "allow").map((r) => `${r.action} ${r.resource}`);
    for (const tool of [...SESSION_TOOL_NAMES, ...EXPOSED_TOOL_NAMES]) expect(allowed).toContain(`overwatch_${tool} *`);
    for (const forbidden of ["edit", "write", "patch", "webfetch", "shell *"]) expect(allowed.some((a) => a === `${forbidden} *` || a === forbidden)).toBe(false);
    expect(allowed.filter((a) => a.startsWith("shell ")).every((a) => a.startsWith("shell git "))).toBe(true);
  });

  test("registers the MCP server with Code Mode off, the investigator agent and the overwatch skill", async () => {
    const mcp: Record<string, unknown> = {};
    const agents: Record<string, any> = {};
    const skills: any[] = [];
    const editor = <T>(apply: (e: T) => void) => apply;
    const ctx = {
      options: { url: "http://127.0.0.1:1" },
      mcp: { transform: async (f: (e: any) => void) => f({ set: (name: string, config: unknown) => (mcp[name] = config) }) },
      agent: { transform: async (f: (e: any) => void) => f({ update: (id: string, u: (a: any) => void) => u((agents[id] = {})) }) },
      skill: { transform: async (f: (e: any) => void) => f({ add: (s: unknown) => skills.push(s) }) },
    };
    void editor;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await plugin.setup(ctx as never);
    } finally {
      console.warn = warn;
    }
    expect(mcp.overwatch).toEqual({ type: "remote", url: "http://127.0.0.1:1/mcp", oauth: false, codemode: false });
    expect(agents["overwatch-investigator"].mode).toBe("primary");
    expect(agents["overwatch-investigator"].system).toContain("You are Overwatch's investigator");
    expect(agents["overwatch-investigator"].permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(skills[0].name).toBe("overwatch");
  });

  test("the health check names a missing service and a version mismatch", async () => {
    const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect((await checkService("http://x", answer({ name: "overwatch", version: "1", apiVersion: API_VERSION }))).ok).toBe(true);
    expect((await checkService("http://x", answer({ name: "overwatch", apiVersion: API_VERSION + 1 }))).detail).toContain("update one of them");
    expect((await checkService("http://127.0.0.1:1")).detail).toContain("not answering");
  });
});
