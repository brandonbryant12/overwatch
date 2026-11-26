/**
 * `overwatch doctor`: every dependency, checked independently, each with the exact fix when it fails. Every check
 * runs even when another fails. Nothing is installed or changed.
 */
import { Cause, Effect, Exit, FileSystem, Path, Predicate, Schedule } from "effect";
import { HttpClient } from "effect/http";
import { randomBytes } from "node:crypto";
import { AppConfig, type Config } from "./config.ts";
import { effect, outbound, run as exec } from "./exec.ts";
import { LABEL, launchctl } from "./launchd.ts";
import { validate } from "./datadog.ts";
import { kubectl } from "./kube.ts";
import { after, OpenCodeClient, type OpenCode } from "./opencode.ts";
import { clean, errorText } from "./redact.ts";
import type { StoreShape } from "./store.ts";

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

/** The tools as OpenCode names them for the agent: the MCP server's name, then the tool's. */
const READ = ["ow_telemetry", "ow_code_read", "ow_code_search", "ow_history"];
const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** A check's failure: what to say about it. */
const failed = (message: string) => Effect.fail(new Error(message));

/** OpenCode fills its catalogs after start: read again for a few seconds before deciding something is missing. */
const settled = <T, E, R>(read: Effect.Effect<ReadonlyArray<T>, E, R>, ok: (list: ReadonlyArray<T>) => boolean) =>
  read.pipe(Effect.repeat({ schedule: Schedule.spaced("250 millis"), until: ok, times: 20 }));

export const doctor = Effect.fn("doctor")(function* (store: StoreShape | null, emptyDir: string) {
  const config = yield* AppConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const checks: Check[] = [];
  const check = <R>(id: string, fix: string, probe: Effect.Effect<string, unknown, R>) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(probe);
      checks.push(
        Exit.isSuccess(exit) ? { id, ok: true, detail: clean(exit.value, 500), fix: null } : { id, ok: false, detail: errorText(Cause.squash(exit.cause)), fix: clean(fix, 500) },
      );
    });
  const ok = (command: string, args: string[], what: string) =>
    Effect.gen(function* () {
      // A call that may reach a host (gh) is an outbound effect: it needs a recorded intent, so the database.
      if (outbound(command, args) && !store) return yield* failed(`${what} needs the database: run doctor with the service running, or with it stopped`);
      const r = outbound(command, args) ? yield* effect(yield* store!.permit("host", null, { doctor: what }), command, args, { timeoutMs: 20_000 }) : yield* exec(command, args, { timeoutMs: 20_000 });
      if (r.code !== 0) return yield* failed(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
      return r.stdout.trim().split("\n")[0] ?? "";
    });

  yield* check(
    "node",
    "Install Node 24, or 22.16 or newer",
    Effect.suspend(() => {
      const [major, minor] = process.versions.node.split(".").map(Number);
      return major! >= 24 || (major === 22 && minor! >= 16) ? Effect.succeed(`Node ${process.version}`) : failed(`Node ${process.version} cannot roll back a failed change (it needs 22.16 or newer, or 24)`);
    }),
  );
  yield* check(
    "data",
    `Create ${config.dataDir} with mode 0700: mkdir -p ${config.dataDir} && chmod 700 ${config.dataDir}`,
    Effect.gen(function* () {
      const info = yield* fs.stat(config.dataDir).pipe(Effect.catch(() => failed(`${config.dataDir} does not exist`)));
      yield* fs.access(config.dataDir, { writable: true }).pipe(Effect.catch(() => failed(`${config.dataDir} is not writable`)));
      const mode = info.mode & 0o777;
      if (mode & 0o077) return yield* failed(`${config.dataDir} is readable by others (mode ${mode.toString(8)})`);
      return `${config.dataDir} is private and writable`;
    }),
  );
  yield* check("git", "Install git (xcode-select --install)", ok("git", ["--version"], "git"));
  yield* check("gh", "Install the GitHub CLI (gh) and sign in: gh auth login", Effect.map(Effect.all([ok("gh", ["--version"], "gh"), ok("gh", ["auth", "status"], "gh auth")]), ([v, a]) => `${v}; ${a}`));
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/+$/, "");
  yield* check(
    "proxy",
    `Check the proxy (HTTPS_PROXY) and the registry setting (npm config get registry): ${registry}`,
    Effect.gen(function* () {
      const r = yield* http.get(`${registry}/-/ping`).pipe(Effect.timeout("10 seconds"));
      yield* r.text.pipe(Effect.ignore);
      // Reaching the registry is not enough: only a success shows it accepted this laptop's credentials and proxy.
      if (r.status < 200 || r.status >= 300) return yield* failed(`the registry answered ${r.status}${r.status === 401 || r.status === 403 ? ": its credentials were refused" : ""}`);
      return `registry ${registry.replace(/\/\/[^@/]*@/, "//")} answered; proxy ${proxy ? new URL(proxy).host : "none"}`;
    }),
  );
  yield* check(
    "native",
    "Install OpenCode 2.4.1 so the opencode binary is on PATH",
    Effect.gen(function* () {
      const v = yield* ok("opencode", ["--version"], "opencode --version");
      if (!/(?:^|[^\d.])2\.\d+\.\d+/.test(v)) return yield* failed(`unexpected version: ${v}`);
      return v.startsWith("opencode") ? v : `opencode ${v}`;
    }),
  );

  const oc = yield* (yield* OpenCodeClient).connect;
  const need: Effect.Effect<OpenCode, Error> = oc ? Effect.succeed(oc) : failed("OpenCode is not configured (opencode.url) and has not registered itself");
  yield* check(
    "opencode",
    `Start OpenCode (opencode serve) at ${config.opencode.url ?? "the configured opencode.url"}`,
    Effect.gen(function* () {
      return `OpenCode ${(yield* (yield* need).info).version ?? "answering"}`;
    }),
  );
  yield* check(
    "model",
    `Check that the model ${config.opencode.model ?? "(opencode.model)"} answers in OpenCode`,
    Effect.gen(function* () {
      const peer = yield* need;
      const session = `ses_${randomBytes(12).toString("hex")}`, message = `msg_${randomBytes(12).toString("hex")}`;
      if (!store) return yield* failed("the model check needs the database: run doctor with the service running, or with it stopped");
      yield* peer.createSession(yield* store.permit("peer", null, { doctor: session }), { id: session, title: "Overwatch doctor check", agent: "ow-investigator", model: config.opencode.model, directory: emptyDir });
      yield* peer.prompt(yield* store.permit("peer", null, { doctor: message }), session, { id: message, text: "Reply with one word: ready." });
      const done = yield* peer.messages(session).pipe(
        Effect.map((history) => after(history, message)),
        Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (a) => a.idle }),
        Effect.timeoutOption("2 minutes"),
      );
      if (done._tag === "None") return yield* failed(`the model ${config.opencode.model} did not answer within two minutes`);
      if (done.value.outcome === "failed" || !done.value.said.trim()) return yield* failed(`the model ${config.opencode.model} gave no answer`);
      return `${config.opencode.model} answered`;
    }),
  );
  // Each role Overwatch runs: its own filing tool allowed, everything else denied. The investigator keeps the id "agent".
  const fixer = Object.values(config.apps).some((a) => a.fixes);
  const roles: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    ["agent", "ow-investigator", [...READ, "ow_finding"]],
    ["agent:challenger", "ow-challenger", [...READ, "ow_challenge"]],
    ["agent:responder", "ow-responder", READ],
    ...(fixer ? [["agent:fixer", "ow-fixer", ["ow_telemetry", "ow_proposal"]] as const] : []),
  ];
  for (const [id, name, tools] of roles) {
    yield* check(
      id,
      `Add the ${name} agent (deny all, allow ${tools.map((t) => `ow_${t}`).join(", ")}) to your OpenCode configuration; see docs/setup.md`,
      Effect.gen(function* () {
        const peer = yield* need;
        const agent = (yield* settled(peer.agents(emptyDir), (l) => l.some((a) => a.id === name))).find((a) => a.id === name || a.name === name);
        if (!agent) return yield* failed(`OpenCode has no ${name} agent`);
        // OpenCode puts its defaults first and the last matching rule wins: evaluate the rules as it does.
        const rules = (Array.isArray(agent.permissions) ? agent.permissions : []) as Array<Record<string, unknown>>;
        const effectOf = (action: string) => rules.findLast((r) => glob(String(r.action ?? "")).test(action) && String(r.resource ?? "*") === "*")?.effect ?? "allow";
        const others = ["bash", "edit", "read", "webfetch", "ow_other", ...[...READ, "ow_finding", "ow_challenge", "ow_proposal"].filter((t) => !tools.includes(t)).map((t) => `ow_${t}`)];
        const missing = tools.filter((t) => effectOf(`ow_${t}`) !== "allow");
        if (missing.length) return yield* failed(`${name} cannot use ${missing.map((t) => `ow_${t}`).join(", ")}`);
        for (const other of others) if (effectOf(other) !== "deny") return yield* failed(`${name} does not deny ${other}`);
        return `${name} can use ${tools.length} Overwatch tools and nothing else`;
      }),
    );
  }
  yield* check(
    "mcp",
    "Add the remote MCP server ow (url …/mcp, Authorization Bearer, codemode false) to your OpenCode configuration",
    Effect.gen(function* () {
      const peer = yield* need;
      const entry = (yield* settled(peer.mcp(emptyDir), (l) => l.some((m) => m.name === "ow" && JSON.stringify(m.status).includes("connected")))).find((m) => m.name === "ow");
      const status = entry && Predicate.isObject(entry.status) ? (entry.status as { status?: string }).status : entry?.status;
      if (status !== "connected") return yield* failed(`OpenCode's MCP server ow is ${String(status ?? "missing")}`);
      return "OpenCode is connected to ow";
    }),
  );
  yield* check(
    "skill",
    "Add the overwatch skill to your OpenCode skills folder",
    Effect.gen(function* () {
      const peer = yield* need;
      const named = (k: Readonly<Record<string, unknown>>) => k.id === "overwatch" || k.name === "overwatch";
      if (!(yield* settled(peer.skills(emptyDir), (l) => l.some(named))).some(named)) return yield* failed("OpenCode has no overwatch skill");
      return "the overwatch skill is installed";
    }),
  );

  let job: { program: string | null; path: string | null; proxy: string | null } | null = null;
  yield* check(
    "launchd",
    "Install the launchd agent (overwatch install), or check it with: launchctl print gui/$(id -u)/" + LABEL,
    Effect.gen(function* () {
      const r = yield* exec(launchctl(), ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { timeoutMs: 10_000 });
      if (r.code !== 0) return yield* failed(`launchctl print failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      const field = (re: RegExp) => re.exec(r.stdout)?.[1]?.trim() ?? null;
      job = { program: field(/^\s*program = (.+)$/m), path: field(/PATH => (.+)$/m), proxy: field(/HTTPS_PROXY => (.+)$/m) };
      return `${LABEL} is ${field(/^\s*state = (.+)$/m) ?? "loaded"}`;
    }),
  );
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  yield* check(
    "launchd.paths",
    "Reinstall the launchd agent from a terminal where kubectl, git and opencode are on PATH",
    Effect.gen(function* () {
      const j = job as typeof job;
      if (!j?.path) return yield* failed("the launchd job's PATH is unknown");
      if (j.program && !(yield* exists(j.program))) return yield* failed(`the job runs ${j.program}, which does not exist`);
      const missing: string[] = [];
      for (const tool of ["kubectl", "git", "opencode"]) {
        let found = false;
        for (const dir of j.path.split(":")) if (yield* exists(path.join(dir, tool))) found = true;
        if (!found) missing.push(tool);
      }
      if (missing.length) return yield* failed(`not on the job's PATH: ${missing.join(", ")}`);
      return "kubectl, git and opencode are on the job's PATH";
    }),
  );
  yield* check(
    "launchd.proxy",
    "Reinstall the launchd agent from a terminal with the proxy settings (HTTPS_PROXY) you use",
    Effect.suspend(() => {
      const j = job as typeof job;
      if (!j) return failed("the launchd job's environment is unknown");
      if ((j.proxy ?? null) !== proxy) return failed(`the job's HTTPS_PROXY is ${j.proxy ? "different" : "unset"}`);
      return Effect.succeed(proxy ? "the job uses the same proxy" : "no proxy, in the job or here");
    }),
  );

  const contexts = new Map<string, Config["sources"][number]>();
  for (const s of config.sources) if (s.kind === "kubernetes" && !contexts.has(s.context!)) contexts.set(s.context!, s);
  for (const [context, s] of contexts) {
    yield* check(
      `cluster:${context}`,
      `Sign in to ${context} (your cluster's login command), then check with: kubectl --context ${context} -n ${s.namespace} get pods`,
      Effect.gen(function* () {
        const r = yield* kubectl({ context, namespace: s.namespace! }, "get", ["pods", "-l", s.selector!, "-o", "json"]);
        if (r.code !== 0) return yield* failed(r.stderr.trim().slice(0, 300) || `kubectl exited ${r.code}`);
        return `${context} answered`;
      }),
    );
  }
  for (const s of config.sources.filter((x) => x.kind === "datadog")) {
    yield* check(`dd:${s.id}`, `Set valid Datadog keys in ${s.apiKey} and ${s.appKey} (datadog API and application keys)`, Effect.as(validate(s), `Datadog accepted the keys for ${s.id}`));
  }
  for (const [app, { checkout }] of Object.entries(config.apps)) {
    yield* check(`checkout:${app}`, `Clone ${app} to ${checkout}, or fix apps.${app}.checkout`, Effect.map(ok("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], "git rev-parse"), (head) => `${checkout} at ${head.slice(0, 12)}`));
  }
  for (const w of config.watchers) {
    const checkout = config.apps[w.app]!.checkout;
    yield* check(
      `deployed:${w.app}/${w.environment}`,
      `Fetch the deployed commit into ${checkout}: git -C ${checkout} fetch`,
      Effect.gen(function* () {
        const revision = store ? (yield* store.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", w.app, w.environment))?.revision : undefined;
        if (!revision) {
          if (!w.sources.some((s) => s.kind === "kubernetes" && s.readings.includes("workloads"))) return "no source reports the running revision";
          return yield* failed("no deploy has been observed yet; run the service for one interval");
        }
        yield* ok("git", ["-C", checkout, "cat-file", "-e", `${revision}^{commit}`], `the deployed commit ${revision.slice(0, 12)} is not in ${checkout}`);
        return `the deployed commit ${revision.slice(0, 12)} is in the checkout`;
      }),
    );
  }
  // The challenger and responder only matter once investigations run: they are reported, with their repair, but do
  // not fail the diagnosis on their own (an M1/M2 setup is complete without them).
  return { ok: checks.every((c) => c.ok || c.id.startsWith("agent:")), checks };
});

