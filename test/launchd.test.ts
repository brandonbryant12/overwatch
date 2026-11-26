import { scratch } from "./scratch.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Never the real launchd: a temporary home and a fake launchctl that records its arguments.
const BIN = new URL("../bin/overwatch", import.meta.url).pathname;
function rig(secret = "keychain:ow/token", failing = "") {
  const home = scratch("ow-launchd-"), calls = join(home, "calls");
  const fake = join(home, "launchctl");
  const loaded = join(home, "loaded");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1" in ${failing || "none"}) echo "refused $1" >&2; exit 5;; esac\ncase "$1" in bootstrap) touch "${loaded}";; bootout) rm -f "${loaded}";; print) test -f "${loaded}" || exit 113;; esac\nexit 0\n`, { mode: 0o755 });
  const config = join(home, "config.json");
  writeFileSync(config, JSON.stringify({
    version: 2, dataDir: join(home, "data"), mcpToken: secret,
    apps: { shop: { checkout: home, environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } },
    watchers: [{ app: "shop", environment: "prod", every: "2m" }],
  }));
  const env = { ...process.env, HOME: home, OW_LAUNCHCTL: fake, HTTPS_PROXY: "http://proxy.invalid:3128", OW_LAUNCHD_PLIST: "" };
  const run = (...args: string[]) => spawnSync(BIN, [...args, "--config", config, "--json"], { env, encoding: "utf8" });
  const plist = join(home, "Library", "LaunchAgents", "dev.overwatch.service.plist");
  return { home, run, plist, config, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []) };
}

test("install writes one private plist that runs serve with this terminal's PATH and proxy, and loads it", () => {
  const x = rig();
  const r = x.run("install");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plist, x.plist);
  const p = readFileSync(x.plist, "utf8");
  assert.equal(statSync(x.plist).mode & 0o777, 0o600);
  for (const part of ["<string>serve</string>", `<string>${x.config}</string>`, "<key>PATH</key>", "http://proxy.invalid:3128", "<key>RunAtLoad</key><true/>"]) assert.ok(p.includes(part), part);
  const uid = process.getuid!();
  assert.deepEqual(x.calls(), [`bootout gui/${uid}/dev.overwatch.service`, `bootstrap gui/${uid} ${x.plist}`]);
  // Installing again replaces the loaded copy rather than failing.
  assert.equal(x.run("install").status, 0);
  assert.equal(x.calls().length, 4);
});

test("restart kickstarts the loaded agent; uninstall unloads it, removes the plist and keeps the data", () => {
  const x = rig();
  x.run("install");
  assert.equal(x.run("restart").status, 0);
  assert.equal(x.calls().at(-1), `kickstart -k gui/${process.getuid!()}/dev.overwatch.service`);
  const r = x.run("uninstall");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(x.plist), false);
  assert.equal(existsSync(join(x.home, "data")), true);
  assert.equal(x.calls().at(-2), `bootout gui/${process.getuid!()}/dev.overwatch.service`);
  assert.equal(x.calls().at(-1), `print gui/${process.getuid!()}/dev.overwatch.service`);
});

test("an env: secret is refused before anything is written, and a launchctl refusal is exit 3 with its words", () => {
  const env = rig("env:OW_MCP_TOKEN");
  const r = env.run("install");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mcpToken.*security add-generic-password -s overwatch -a NAME -w.*keychain:overwatch\/NAME/s);
  assert.equal(existsSync(env.plist), false);
  assert.deepEqual(env.calls(), []);
  const refused = rig(undefined, "bootstrap|kickstart");
  const i = refused.run("install");
  assert.equal(i.status, 3);
  assert.match(i.stderr, /refused bootstrap/);
  assert.equal(refused.run("restart").status, 3);
});
