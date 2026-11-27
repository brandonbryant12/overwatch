/**
 * The command line: `overwatch COMMAND --config FILE [--json]`, built with `effect/cli` and run by
 * `NodeRuntime.runMain`.
 *
 * Exit codes: 0 success; 2 invalid arguments or configuration; 3 unavailable or busy; 4 a failed diagnostic or score
 * gate; 5 an invalid or incompatible backup or database. With --json, one JSON object on stdout and diagnostics on
 * stderr. While a service runs, status, backup, doctor and trial ask it over loopback; otherwise they take ownership
 * of the database themselves (status, backup) or refuse (trial).
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { AppConfig, defaultConfigFile, loadConfig, type Config } from "./config.ts";
import { demoConfig, seedDemo } from "./demo.ts";
import { doctor, type DoctorReport } from "./doctor.ts";
import { CliExit, cliExit } from "./errors.ts";
import { sweep } from "./exec.ts";
import { envSecrets, install, restart, uninstall } from "./launchd.ts";
import { clean, errorText } from "./redact.ts";
import { serve } from "./server.ts";
import { snapshot, type Snapshot } from "./snapshot.ts";
import { readDiscovery, Store } from "./store.ts";
import { emptyFolder, type Report } from "./trial.ts";
import { OpenCodeClient } from "./opencode.ts";

const asJson = process.argv.includes("--json");
/** One result: a JSON object with --json, otherwise the human text. */
const out = (value: unknown, human: string) => Console.log(asJson ? JSON.stringify(value) : human.endsWith("\n") ? human.slice(0, -1) : human);

const shared = {
  config: Flag.String("config").pipe(Flag.withDescription("The configuration file"), Flag.optional),
  json: Flag.Boolean("json").pipe(Flag.withDescription("One JSON object on stdout"), Flag.withDefault(false)),};
const root = Command.make("overwatch").pipe(Command.withSharedFlags(shared), Command.withDescription("Watches Kubernetes and Datadog, and investigates with OpenCode"));

/** The configuration named by --config (or the default file); invalid is exit 2. */
const config = Effect.gen(function* () {
  const flags = yield* root;
  const path = yield* Path.Path;
  return yield* loadConfig(path.resolve(Option.getOrElse(flags.config, defaultConfigFile))).pipe(Effect.mapError((e) => cliExit(2, "invalid_config", e.message))); });

const Status = Schema.Struct({ version: Schema.optional(Schema.Number) });
/** The running service, if its discovery record points at one that answers. A dead address proves nothing. */
const live = Effect.fn("live")(function* (c: Config) {
  const found = yield* readDiscovery(c.dataDir);
  if (!found) return null;
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(`${found.url}/v2/status`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Status)),
    Effect.map((s) => (s.version === 2 ? found.url : null)),
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => null)); });

/** The database, owned by this command for as long as its scope lasts. */
const own = Effect.fn("own")(function* (c: Config) {
  return yield* Store.own(c.dataDir).pipe(
    Effect.catchTags({
      Busy: (error) => Effect.flatMap(live(c), (url) => Effect.fail(cliExit(3, "busy", `${error.message}${url ? `; the running service answers at ${url}` : ""}`))),
      Incompatible: (error) => Effect.fail(cliExit(5, "incompatible", error.message)),})); });

const ErrorBody = Schema.Struct({ error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })) });
/** A command the running service performs: its answer, or its refusal as an exit (409 is 2, anything else 3). */
const post = Effect.fn("post")(function* (url: string, path: string, body: unknown, timeout: number) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(url + path).pipe(HttpClientRequest.bodyJsonUnsafe(body), client.execute, Effect.timeout(timeout), Effect.catch(() => Effect.fail(cliExit(3, "unavailable", `the service at ${url} did not answer`))));
  const value = yield* response.json.pipe(Effect.orElseSucceed(() => ({})));
  if (response.status >= 300) {
    const refusal = Schema.decodeUnknownOption(ErrorBody)(value).pipe(Option.flatMap((v) => Option.fromNullishOr(v.error)));
    return yield* cliExit(response.status === 409 ? 2 : 3, Option.match(refusal, { onNone: () => "unavailable", onSome: (e) => e.code }), Option.match(refusal, { onNone: () => `the service answered ${response.status}`, onSome: (e) => e.message }));
  }
  return value as Record<string, unknown>; });

function humanStatus(s: Snapshot): string {
  const lines = [`Overwatch ${s.live ? "live" : "offline"} at seq ${s.seq}${s.paused ? ` (paused: ${s.paused})` : ""}`];
  for (const e of s.environments) lines.push(`  ${e.app}/${e.environment}: ${e.health.replace("_", " ")}${e.excluded.length ? ` (not measured here: ${e.excluded.join(", ")})` : ""}`);
  for (const c of s.causes) lines.push(`  cause: ${c.kind} (${c.sources.join(", ")})${"fix" in c && c.fix ? `\n    fix: ${c.fix}` : ""}`);
  for (const i of s.incidents.slice(-20)) lines.push(`  ${i.exact ? i.count : `${i.count}+`} × ${i.title}${i.active ? "" : " (quiet)"}`);
  const trial = s.trial.jobs.filter((j) => j.state === "queued" || j.state === "running").length;
  if (s.jobs.length) lines.push(`  work: ${s.jobs.length} jobs`);
  if (trial) lines.push(`  trial (calibration, not real work): ${trial} jobs in progress`);
  return lines.join("\n");
}

const check = Command.make("check", {}, () => Effect.gen(function* () {
    const c = yield* config;
    yield* out({ version: 2, watchers: c.watchers.length }, `${c.file} is valid: ${c.watchers.length} watcher(s)`); }));

/** Serves until a signal: the service, then (for the demo) its scratch directory, are released in order. */
const serveWith = (c: Config, demo: boolean) => Effect.gen(function* () {
    yield* sweep; // scratch left by a process that no longer runs: a killed verify, demo or trial
    const store = yield* own(c);
    if (demo) yield* seedDemo.pipe(Effect.provideService(Store, store), Effect.provide(AppConfig.layer(c)), Effect.mapError((e) => cliExit(1, "internal", errorText(e))));
    return yield* serve({ demo, ready: (url) => out({ version: 2, url, pid: process.pid, ...(demo ? { demo: true } : {}) }, `Overwatch ${demo ? "demo " : ""}serving at ${url} (pid ${process.pid})`) }).pipe(
      Effect.provideService(Store, store),
      Effect.provide(AppConfig.layer(c)));
  }).pipe(Effect.scoped);

const serveCommand = Command.make("serve", {}, () => Effect.flatMap(config, (c) => serveWith(c, false)));

const demo = Command.make("demo", {}, () => Effect.gen(function* () {
    const c = yield* config;
    const fs = yield* FileSystem.FileSystem;
    const d = yield* demoConfig(c.port);
    // A demo's data is its own scratch: removed when it stops.
    yield* Effect.addFinalizer(() => fs.remove(d.dataDir, { recursive: true, force: true }).pipe(Effect.ignore));
    return yield* serveWith(d, true);
  }).pipe(Effect.scoped));

const status = Command.make("status", {}, () => Effect.gen(function* () {
    const c = yield* config;
    const url = yield* live(c);
    const s = url
      ? ((yield* (yield* HttpClient.HttpClient).get(`${url}/v2/status`).pipe(
          Effect.flatMap((r) => r.json),
          Effect.timeout("5 seconds"),
          Effect.catch(() => Effect.fail(cliExit(3, "unavailable", `the service at ${url} did not answer`))),
        )) as unknown as Snapshot)
      : yield* Effect.scoped(Effect.flatMap(own(c), (store) => snapshot(null, false).pipe(Effect.provideService(Store, store), Effect.provide(AppConfig.layer(c)))));
    yield* out(s, humanStatus(s)); }));

const backup = Command.make("backup", { to: Flag.String("to").pipe(Flag.optional) }, ({ to }) => Effect.gen(function* () {
    const c = yield* config;
    if (Option.isNone(to)) return yield* cliExit(2, "invalid_arguments", "backup needs --to FILE");
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const file = path.resolve(to.value);
    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) return yield* cliExit(2, "invalid_arguments", `${file} exists; choose a new file`);
    const url = yield* live(c);
    const result = url
      ? yield* post(url, "/v2/backup", { file }, 120_000)
      : yield* Effect.scoped(Effect.flatMap(own(c), (store) => store.backup(file).pipe(Effect.mapError((e) => cliExit(1, "internal", e.message)))));
    yield* out(result, `Backed up to ${file}`); }));

const restore = Command.make("restore", { from: Flag.String("from").pipe(Flag.optional) }, ({ from }) => Effect.gen(function* () {
    const c = yield* config;
    if (Option.isNone(from)) return yield* cliExit(2, "invalid_arguments", "restore needs --from FILE");
    const path = yield* Path.Path;
    const result = yield* Effect.scoped(
      Effect.flatMap(own(c), (store) =>
        store.restore(path.resolve(from.value)).pipe(
          Effect.catchTags({ Incompatible: (e) => Effect.fail(cliExit(5, "invalid_backup", e.message)), Full: (e) => Effect.fail(cliExit(3, "paused", e.message)) }))));
    yield* out(result, `Restored from ${result.file} at seq ${result.seq}`); }));

const doctorCommand = Command.make("doctor", {}, () => Effect.gen(function* () {
  const c = yield* config, url = yield* live(c);
  const report: DoctorReport = url
    ? ((yield* post(url, "/v2/doctor", {}, 300_000)) as unknown as DoctorReport)
    : yield* Effect.scoped(Effect.gen(function* () {
        const store = yield* Effect.option(Store.own(c.dataDir));
        return yield* doctor(Option.getOrNull(store), yield* emptyFolder(c.dataDir)).pipe(Effect.provide(OpenCodeClient.layer), Effect.provide(AppConfig.layer(c))); }));
  yield* out(report, report.checks.map((k) => `${k.ok ? "ok  " : "FAIL"} ${k.id}: ${k.detail}${k.fix ? `\n     fix: ${k.fix}` : ""}`).join("\n"));
  if (!report.ok) yield* Effect.sync(() => void (process.exitCode = 4)); }));

type TrialReport = Report & { fixGate?: { passed: boolean; attempted: number; verified: number } };
const trial = Command.make("trial", { fixes: Flag.Boolean("fixes").pipe(Flag.withDefault(false)) }, ({ fixes }) => Effect.gen(function* () {
  const c = yield* config, url = yield* live(c);
  if (!url) return yield* cliExit(3, "unavailable", "the trial needs the running service (overwatch serve): sessions call its tools");
  const r = (yield* post(url, "/v2/trial", { fixes }, 3_600_000)) as unknown as TrialReport;
  const human = [
    ...r.cases.map((k) => `${k.id}: expected ${k.expected}, got ${k.verdict ?? "no filing"} (${k.valid ? "valid" : "invalid"}, ${k.tries} session(s))${k.reason ? ` — ${k.reason}` : ""}`),
    `Valid filings: ${r.valid}/${r.cases.length}`, `Correct: ${r.correct}/${r.cases.length}`, `False real: ${r.falseReal}`,
    `Obeyed a planted instruction: ${r.obeyed}`, `Peak sessions at once: ${r.peakSessions}`, `Automation: ${r.automation ? "on" : "off"}`,
    ...(r.fixGate ? [`Fix calibration: ${r.fixGate.verified}/${r.fixGate.attempted} verified; fix proposals ${r.fixGate.passed ? "on" : "off"}`] : [])];
  yield* out(r, human.join("\n"));
  if (!(r.automation && (!r.fixGate || r.fixGate.passed))) yield* Effect.sync(() => void (process.exitCode = 4)); }));

/** launchctl refused or is missing: unavailable (3), with what it said. */
const launchd = <A, E, R>(step: Effect.Effect<A, E, R>) => step.pipe(Effect.mapError((e) => cliExit(3, "unavailable", errorText(e))));

const installCommand = Command.make("install", {}, () => Effect.gen(function* () {
    const c = yield* config;
    const secrets = yield* envSecrets(c.file);
    if (secrets.length)
      return yield* cliExit(
        2,
        "invalid_config",
        `a launchd service cannot read your shell's environment, so these secrets would be empty: ${secrets.join(", ")}. For each one, store the value in your login keychain with: security add-generic-password -s overwatch -a NAME -w   (it prompts for the value; NAME is your choice, such as mcp-token), then change the setting in ${c.file} from "env:VAR" to "keychain:overwatch/NAME", and run install again.`);
    const r = yield* launchd(install(c.file, c.dataDir));
    yield* out(r, `Installed ${r.label}: ${r.plist}\nIt runs serve --config ${r.config} now and at every login; output goes to ${r.log}.\nCheck: overwatch status, then overwatch doctor.`); }));
const uninstallCommand = Command.make("uninstall", {}, () => Effect.gen(function* () {
    const r = yield* launchd(uninstall);
    yield* out(r, `Removed ${r.label} (${r.plist})${r.wasLoaded ? "; the service is stopped" : "; it was not loaded"}. Your data is kept.`); }));
const restartCommand = Command.make("restart", {}, () => Effect.gen(function* () {
    const r = yield* launchd(restart);
    yield* out(r, `Restarted ${r.label}.`); }));

const COMMANDS = "check, serve, status, backup, restore, doctor, trial, demo, install, uninstall, restart";
const cli = root.pipe(Command.withSubcommands([check, serveCommand, status, backup, restore, doctorCommand, trial, demo, installCommand, uninstallCommand, restartCommand]));

/** A failure as the contract states it: one JSON error object with --json, and the message on stderr. */
const report = (exit: CliExit) => Effect.gen(function* () {
    const message = clean(exit.message, 2000);
    if (asJson) yield* Console.log(JSON.stringify({ error: { code: exit.kind, message } }));
    yield* Console.error(`overwatch: ${message}`);
    yield* Effect.sync(() => void (process.exitCode = exit.code)); });

const argv = process.argv.slice(2);
const known = new Set(COMMANDS.split(", "));
const program = (argv[0] && known.has(argv[0])
  ? Command.runWith(cli, { version: "2.0.0", renderErrors: false })(argv)
  : Effect.fail(cliExit(2, "invalid_arguments", `unknown command ${argv[0] ?? "help"}; commands: ${COMMANDS}`))
).pipe(
  Effect.catch((error) => report(error instanceof CliExit ? error : cliExit(2, "invalid_arguments", errorText(error)))),
  Effect.catchDefect((defect) => report(cliExit(1, "internal", errorText(defect)))),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));

NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  // The code a command chose (process.exitCode), else 0 for success or a stop by signal, 1 for anything else.
  teardown: (exit, onExit) => onExit(process.exitCode !== undefined ? Number(process.exitCode) : Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1),});
