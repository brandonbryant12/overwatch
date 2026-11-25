/** The launchd agent: generated and installed into a temporary directory; launchctl is a fake. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { install, LABEL, plist, uninstall } from "../src/service/launchd.ts";
import { writeFileSync } from "node:fs";
import { loadConfig, loadExtensions, parseConfig } from "../src/service/config.ts";
import { registerSourceType, sourceType } from "../src/collect/sources/index.ts";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

describe("launchd", () => {
  test("the plist runs the service with Node, keeps it alive and carries the PATH it was installed with", () => {
    const text = plist({ node: "/opt/node/bin/node", main: "/srv/overwatch/src/service/main.ts", config: "/cfg/config.json", logDir: "/data/logs", path: "/opt/bin:/usr/bin", home: "/home/me" });
    for (const part of ["<string>/opt/node/bin/node</string>", "<string>--experimental-strip-types</string>", "<string>serve</string>", "<string>/cfg/config.json</string>", "<key>KeepAlive</key>\n  <true/>", "<key>RunAtLoad</key>\n  <true/>", "<string>/opt/bin:/usr/bin</string>", `<string>${LABEL}</string>`]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain("bun");
  });

  test("install writes the agent, finds the tools on the given PATH, and loads it only when asked", () => {
    const dir = tempDir("agents");
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => void calls.push([command, ...args]);
    const result = install({ agentsDir: dir, config: "/cfg.json", logDir: join(dir, "logs"), main: "/main.ts", path: "/usr/bin:/bin", load: false, run });
    expect(existsSync(result.plistPath)).toBe(true);
    expect(calls).toEqual([]);
    expect(result.tools.git).toBeDefined();
    install({ agentsDir: dir, config: "/cfg.json", logDir: join(dir, "logs"), main: "/main.ts", path: "/usr/bin", load: true, run });
    expect(calls.map((c) => c.slice(0, 2))).toEqual([
      ["launchctl", "bootout"],
      ["launchctl", "bootstrap"],
    ]);
    expect(readFileSync(result.plistPath, "utf8")).toContain("<string>/usr/bin</string>");
    uninstall({ agentsDir: dir, unload: false });
    expect(existsSync(result.plistPath)).toBe(false);
  });
});

describe("configuration", () => {
  test("the shipped example parses without errors", () => {
    const config = loadConfig(new URL("../examples/config.json", import.meta.url).pathname);
    expect(config.errors).toEqual([]);
    expect(config.options.watchers.map((w) => [w.id, w.everyMs])).toEqual([["shop-api/production", 600_000]]);
    expect(config.port).toBe(7450);
  });

  test("an extension module listed in the config registers a source type without touching upstream files", async () => {
    const dir = tempDir("ext");
    const module = join(dir, "my-source.ts");
    writeFileSync(
      module,
      `export default ({ registerSourceType }) => registerSourceType({ type: "fork-source", queryHelp: "", validate: () => [], collect: async () => ({ signals: [], samples: [], notes: [] }), query: async () => "" });\n`,
    );
    const config = parseConfig({ extensions: ["my-source.ts"] }, join(dir, "config.json"));
    expect(config.extensions).toEqual([module]);
    await loadExtensions(config.extensions, { registerSourceType });
    expect(sourceType("fork-source")?.type).toBe("fork-source");
  });
});
