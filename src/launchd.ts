/**
 * The per-user launchd agent: `overwatch install`, `uninstall` and `restart`. One plist in ~/Library/LaunchAgents
 * runs `serve` with this Node, this checkout and the PATH and proxy of the terminal that installed it. The plist
 * path (OW_LAUNCHD_PLIST) and the launchctl executable (OW_LAUNCHCTL) can be replaced, so tests use a temporary
 * home and a fake; nothing here runs with privileges.
 */
import { Effect, FileSystem, PlatformError, Predicate, Schema } from "effect";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, LaunchdError } from "./errors.ts";
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
export const envSecrets = Effect.fn("launchd.envSecrets")(function* (configFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(configFile);
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text);
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Predicate.isString(v) && v.startsWith("env:")) found.push(`${path} (${v})`);
    else if (Predicate.isObjectOrArray(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, "");
  return found;
}, (effect, configFile) => Effect.mapError(effect, (error) => new ConfigError({ message: `${configFile} cannot be read: ${error.message}` })));

const unwritable = (error: PlatformError.PlatformError) => new LaunchdError({ message: error.message });
const launch = (args: string[]) =>
  Effect.map(exec(launchctl(), args, { timeoutMs: 15_000 }), (r) => ({ ok: r.code === 0, code: r.code, text: (r.stderr || r.stdout).trim().slice(0, 300) }));

export const install = Effect.fn("launchd.install")(function* (configFile: string, dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = plistPath(), config = resolve(configFile);
  yield* fs.makeDirectory(dirname(file), { recursive: true }).pipe(Effect.mapError(unwritable));
  yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.mapError(unwritable));
  yield* fs.writeFileString(file, plist(config, dataDir), { mode: 0o600 }).pipe(Effect.mapError(unwritable));
  yield* launch(["bootout", `${domain()}/${LABEL}`]); // an earlier copy, if loaded; its absence is fine
  const r = yield* launch(["bootstrap", domain(), file]);
  if (!r.ok) return yield* new LaunchdError({ message: `launchctl bootstrap failed: ${r.text}` });
  return { label: LABEL, plist: file, config, log: join(dataDir, "service.log") }; });

/**
 * Unloads and removes the agent, then asks launchd what is still loaded. Three outcomes: unloaded (the plist is
 * removed), still loaded, or could not tell because launchctl did not run; the last two keep the plist and fail.
 */
export const uninstall = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = plistPath();
  const r = yield* launch(["bootout", `${domain()}/${LABEL}`]);
  const p = yield* launch(["print", `${domain()}/${LABEL}`]);
  if (p.code === 127) return yield* new LaunchdError({ message: `could not tell whether ${LABEL} is still loaded: ${p.text}; ${file} was kept. Check with: launchctl print ${domain()}/${LABEL}` });
  if (p.ok) return yield* new LaunchdError({ message: `launchctl bootout failed (${r.text || "no reason given"}); ${LABEL} is still loaded and ${file} was kept. Stop it with: launchctl bootout ${domain()}/${LABEL}` });
  yield* fs.remove(file, { force: true }).pipe(Effect.mapError(unwritable));
  return { label: LABEL, plist: file, wasLoaded: r.ok };
}).pipe(Effect.withSpan("launchd.uninstall"));

export const restart = Effect.gen(function* () {
  const r = yield* launch(["kickstart", "-k", `${domain()}/${LABEL}`]);
  if (!r.ok) return yield* new LaunchdError({ message: `launchctl kickstart failed: ${r.text}; install the agent first (overwatch install)` });
  return { label: LABEL, restarted: true };
}).pipe(Effect.withSpan("launchd.restart"));
