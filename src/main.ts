/**
 * The command line: `overwatch COMMAND --config FILE [--json]`.
 *
 * Exit codes: 0 success; 2 invalid arguments or configuration; 3 unavailable or busy; 4 a failed diagnostic or score
 * gate; 5 an invalid or incompatible backup or database. With --json, one JSON object on stdout and diagnostics on
 * stderr. While a service runs, status, backup, doctor and trial ask it over loopback; otherwise they take ownership
 * of the database themselves (status, backup) or refuse (trial).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, defaultConfigFile, loadConfig, type Config } from "./config.ts";
import { clock } from "./clock.ts";
import { demoConfig, freshen, seedDemo } from "./demo.ts";
import { doctor } from "./doctor.ts";
import { envSecrets, install, restart, uninstall } from "./launchd.ts";
import { clean, errorText } from "./redact.ts";
import { serve } from "./server.ts";
import { snapshot } from "./snapshot.ts";
import { Busy, Incompatible, readDiscovery, Store } from "./store.ts";
import { emptyFolder } from "./trial.ts";

class Exit extends Error {
  readonly code: number;
  readonly kind: string;
  constructor(code: number, kind: string, message: string) {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");
const log = (line: string) => process.stderr.write(`[overwatch] ${clean(line, 4000)}\n`);
const out = (value: unknown, human: string) => process.stdout.write(asJson ? JSON.stringify(value) + "\n" : human.endsWith("\n") ? human : human + "\n");

function config(): Config {
  try {
    return loadConfig(resolve(flag("--config") ?? defaultConfigFile()));
  } catch (error) {
    if (error instanceof ConfigError) throw new Exit(2, "invalid_config", error.message);
    throw error;
  }
}

/** The running service, if its discovery record points at one that answers. A dead address proves nothing. */
async function live(c: Config): Promise<string | null> {
  const found = readDiscovery(c.dataDir);
  if (!found) return null;
  try {
    const r = await fetch(`${found.url}/v2/status`, { signal: AbortSignal.timeout(3_000) });
    if (!r.ok) return null;
    const s = (await r.json()) as { version?: number };
    return s.version === 2 ? found.url : null;
  } catch {
    return null;
  }
}

async function own(c: Config): Promise<Store> {
  try {
    return Store.own(c.dataDir);
  } catch (error) {
    if (error instanceof Busy) {
      const url = await live(c);
      throw new Exit(3, "busy", `${error.message}${url ? `; the running service answers at ${url}` : ""}`);
    }
    if (error instanceof Incompatible) throw new Exit(5, "incompatible", error.message);
    throw error;
  }
}

async function post(url: string, path: string, body: unknown, timeoutMs: number) {
  const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const value = (await r.json()) as { error?: { code: string; message: string } };
  if (!r.ok) throw new Exit(r.status === 409 ? 2 : 3, value.error?.code ?? "unavailable", value.error?.message ?? `the service answered ${r.status}`);
  return value;
}

function humanStatus(s: ReturnType<typeof snapshot>): string {
  const lines = [`Overwatch ${s.live ? "live" : "offline"} at seq ${s.seq}${s.paused ? ` (paused: ${s.paused})` : ""}`];
  for (const e of s.environments) lines.push(`  ${e.app}/${e.environment}: ${e.health.replace("_", " ")}${e.excluded.length ? ` (not measured here: ${e.excluded.join(", ")})` : ""}`);
  for (const c of s.causes) lines.push(`  cause: ${c.kind} (${c.sources.join(", ")})${"fix" in c && c.fix ? `\n    fix: ${c.fix}` : ""}`);
  for (const i of s.incidents.slice(-20)) lines.push(`  ${i.exact ? i.count : `${i.count}+`} × ${i.title}${i.active ? "" : " (quiet)"}`);
  const trial = s.trial.jobs.filter((j) => j.state === "queued" || j.state === "running").length;
  if (s.jobs.length) lines.push(`  work: ${s.jobs.length} jobs`);
  if (trial) lines.push(`  trial (calibration, not real work): ${trial} jobs in progress`);
  return lines.join("\n");
}

async function serveCommand(c: Config, demo: boolean) {
  const store = await own(c);
  if (demo) seedDemo(store, c);
  const service = await serve(store, c, { scheduler: true, collect: !demo, log, ...(demo ? { tick: () => freshen(store) } : {}) });
  out({ version: 2, url: service.url, pid: process.pid, ...(demo ? { demo: true } : {}) }, `Overwatch ${demo ? "demo " : ""}serving at ${service.url} (pid ${process.pid})`);
  const stop = async () => {
    await service.close();
    store.close();
    finish(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function main(): Promise<number> {
  switch (command) {
    case "check": {
      const c = config();
      out({ version: 2, watchers: c.watchers.length }, `${c.file} is valid: ${c.watchers.length} watcher(s)`);
      return 0;
    }
    case "serve":
      await serveCommand(config(), false);
      return -1;
    case "demo": {
      const c = config();
      await serveCommand(demoConfig(c.port), true);
      return -1;
    }
    case "status": {
      const c = config();
      const url = await live(c);
      if (url) {
        const s = (await (await fetch(`${url}/v2/status`, { signal: AbortSignal.timeout(5_000) })).json()) as ReturnType<typeof snapshot>;
        out(s, humanStatus(s));
        return 0;
      }
      const store = await own(c);
      try {
        const s = snapshot(store, c, null, false);
        out(s, humanStatus(s));
      } finally {
        store.close();
      }
      return 0;
    }
    case "backup": {
      const c = config();
      const to = flag("--to");
      if (!to) throw new Exit(2, "invalid_arguments", "backup needs --to FILE");
      const file = resolve(to);
      if (existsSync(file)) throw new Exit(2, "invalid_arguments", `${file} exists; choose a new file`);
      const url = await live(c);
      const result = url ? await post(url, "/v2/backup", { file }, 120_000) : await (async () => {
        const store = await own(c);
        try {
          return store.backup(file);
        } finally {
          store.close();
        }
      })();
      out(result, `Backed up to ${file}`);
      return 0;
    }
    case "restore": {
      const c = config();
      const from = flag("--from");
      if (!from) throw new Exit(2, "invalid_arguments", "restore needs --from FILE");
      const store = await own(c);
      try {
        const result = store.restore(resolve(from));
        out(result, `Restored from ${result.file} at seq ${result.seq}`);
      } catch (error) {
        if (error instanceof Incompatible) throw new Exit(5, "invalid_backup", error.message);
        throw error;
      } finally {
        store.close();
      }
      return 0;
    }
    case "doctor": {
      const c = config();
      const url = await live(c);
      let report: Awaited<ReturnType<typeof doctor>>;
      if (url) report = (await post(url, "/v2/doctor", {}, 300_000)) as typeof report;
      else {
        let store: Store | null = null;
        try {
          store = Store.own(c.dataDir);
        } catch {
          store = null;
        }
        try {
          report = await doctor(c, store, emptyFolder(c.dataDir));
        } finally {
          store?.close();
        }
      }
      out(report, report.checks.map((k) => `${k.ok ? "ok  " : "FAIL"} ${k.id}: ${k.detail}${k.fix ? `\n     fix: ${k.fix}` : ""}`).join("\n"));
      return report.ok ? 0 : 4;
    }
    case "trial": {
      const c = config();
      const url = await live(c);
      if (!url) throw new Exit(3, "unavailable", "the trial needs the running service (overwatch serve): sessions call its tools");
      const r = (await post(url, "/v2/trial", {}, 3_600_000)) as {
        cases: Array<{ id: string; expected: string; verdict: string | null; valid: boolean; tries: number; reason: string | null }>;
        valid: number; correct: number; falseReal: number; obeyed: number; peakSessions: number; automation: boolean;
      };
      const human = [
        ...r.cases.map((k) => `${k.id}: expected ${k.expected}, got ${k.verdict ?? "no filing"} (${k.valid ? "valid" : "invalid"}, ${k.tries} session(s))${k.reason ? ` — ${k.reason}` : ""}`),
        `Valid filings: ${r.valid}/${r.cases.length}`,
        `Correct: ${r.correct}/${r.cases.length}`,
        `False real: ${r.falseReal}`,
        `Obeyed a planted instruction: ${r.obeyed}`,
        `Peak sessions at once: ${r.peakSessions}`,
        `Automation: ${r.automation ? "on" : "off"}`,
      ];
      out(r, human.join("\n"));
      return r.automation ? 0 : 4;
    }
    case "install": {
      const c = config();
      const secrets = envSecrets(c.file);
      if (secrets.length) throw new Exit(2, "invalid_config", `a launchd service cannot read your shell's environment; move these to keychain: references first: ${secrets.join(", ")}`);
      const r = await launchd(() => install(c.file, c.dataDir));
      out(r, `Installed ${r.label}: ${r.plist}\nIt runs serve --config ${r.config} now and at every login; output goes to ${r.log}.\nCheck: overwatch status, then overwatch doctor.`);
      return 0;
    }
    case "uninstall": {
      const r = await launchd(uninstall);
      out(r, `Removed ${r.label} (${r.plist})${r.wasLoaded ? "; the service is stopped" : "; it was not loaded"}. Your data is kept.`);
      return 0;
    }
    case "restart": {
      const r = await launchd(restart);
      out(r, `Restarted ${r.label}.`);
      return 0;
    }
    default:
      throw new Exit(2, "invalid_arguments", `unknown command ${command}; commands: check, serve, status, backup, restore, doctor, trial, demo, install, uninstall, restart`);
  }
}

/** launchctl refused or is missing: unavailable (3), with what it said. */
async function launchd<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new Exit(3, "unavailable", errorText(e));
  }
}

/** Exits once everything written has drained: a pipe on macOS is asynchronous, and exiting early would cut it off. */
const finish = (code: number) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));

main().then(
  (code) => {
    if (code >= 0) finish(code);
  },
  (error) => {
    const exit = error instanceof Exit ? error : new Exit(1, "internal", errorText(error));
    const message = clean(exit.message, 2000);
    if (asJson) process.stdout.write(JSON.stringify({ error: { code: exit.kind, message } }) + "\n");
    process.stderr.write(`overwatch: ${message}\n`);
    finish(exit.code);
  },
);
void clock;
