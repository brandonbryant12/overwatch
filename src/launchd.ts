/**
 * The per-user launchd agent: `overwatch install`, `uninstall` and `restart`. One plist in ~/Library/LaunchAgents
 * runs `serve` with this Node, this checkout and the PATH and proxy of the terminal that installed it. The plist
 * path (OW_LAUNCHD_PLIST) and the launchctl executable (OW_LAUNCHCTL) can be replaced, so tests use a temporary
 * home and a fake; nothing here runs with privileges.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run as exec } from "./exec.ts";

export const LABEL = "dev.overwatch.service";
export const launchctl = () => process.env.OW_LAUNCHCTL || "launchctl";
const plistPath = () => process.env.OW_LAUNCHD_PLIST || join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 0}`;
const PASSED = ["PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strings = (values: string[]) => values.map((v) => `<string>${xml(v)}</string>`).join("");

export function plist(configFile: string, dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const vars = PASSED.filter((k) => env[k]).map((k) => `<key>${k}</key><string>${xml(env[k]!)}</string>`).join("");
  const log = join(dataDir, "service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${strings([process.execPath, "--experimental-strip-types", "--no-warnings", main, "serve", "--config", configFile])}</array>
<key>EnvironmentVariables</key><dict>${vars}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

/**
 * A service cannot see the installing terminal's secrets: a `env:` reference in the configuration would resolve to
 * nothing under launchd, and copying its value into the plist would store a secret. Those settings must move to the
 * keychain first.
 */
export function envSecrets(configFile: string): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string" && v.startsWith("env:")) found.push(`${path} (${v})`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(JSON.parse(readFileSync(configFile, "utf8")), "");
  return found;
}

const run = async (args: string[]) => {
  const r = await exec(launchctl(), args, { timeoutMs: 15_000 });
  return { ok: r.code === 0, text: (r.stderr || r.stdout).trim().slice(0, 300) };
};

export async function install(configFile: string, dataDir: string) {
  const file = plistPath(), config = resolve(configFile);
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, plist(config, dataDir), { mode: 0o600 });
  await run(["bootout", `${domain()}/${LABEL}`]); // an earlier copy, if loaded; its absence is fine
  const r = await run(["bootstrap", domain(), file]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.text}`);
  return { label: LABEL, plist: file, config, log: join(dataDir, "service.log") };
}

export async function uninstall() {
  const file = plistPath();
  const r = await run(["bootout", `${domain()}/${LABEL}`]);
  rmSync(file, { force: true });
  return { label: LABEL, plist: file, wasLoaded: r.ok };
}

export async function restart() {
  const r = await run(["kickstart", "-k", `${domain()}/${LABEL}`]);
  if (!r.ok) throw new Error(`launchctl kickstart failed: ${r.text}; install the agent first (overwatch install)`);
  return { label: LABEL, restarted: true };
}
