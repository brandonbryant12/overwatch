/**
 * `overwatch doctor`: every dependency, checked independently, each with the exact fix when it fails. Every check
 * runs even when another fails. Nothing is installed or changed.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import { run as exec } from "./exec.ts";
import { LABEL, launchctl } from "./launchd.ts";
import { validate } from "./datadog.ts";
import { kubectl } from "./kube.ts";
import { connect, OpenCode } from "./opencode.ts";
import { clean, errorText } from "./redact.ts";
import { sleep } from "./clock.ts";
import type { Store } from "./store.ts";

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

/** The tools as OpenCode names them for the agent: the MCP server's name, then the tool's. */
const READ = ["ow_telemetry", "ow_code_read", "ow_code_search", "ow_history"];
const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);

/** OpenCode fills its catalogs after start: read again for a few seconds before deciding something is missing. */
async function settled<T>(read: () => Promise<T[]>, ok: (list: T[]) => boolean): Promise<T[]> {
  let list = await read();
  for (let i = 0; i < 20 && !ok(list); i++) {
    await sleep(250);
    list = await read();
  }
  return list;
}

export async function doctor(config: Config, store: Store | null, emptyDir: string): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = async (id: string, fix: string, probe: () => Promise<string>) => {
    try {
      checks.push({ id, ok: true, detail: clean(await probe(), 500), fix: null });
    } catch (error) {
      checks.push({ id, ok: false, detail: errorText(error), fix: clean(fix, 500) });
    }
  };
  const ok = async (command: string, args: string[], what: string) => {
    const r = await exec(command, args, { timeoutMs: 20_000 });
    if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
    return r.stdout.trim().split("\n")[0] ?? "";
  };

  await check("node", "Install Node 22.13 or newer", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major! < 22 || (major === 22 && minor! < 13)) throw new Error(`Node ${process.version} is older than 22.13`);
    return `Node ${process.version}`;
  });
  await check("data", `Create ${config.dataDir} with mode 0700: mkdir -p ${config.dataDir} && chmod 700 ${config.dataDir}`, async () => {
    if (!existsSync(config.dataDir)) throw new Error(`${config.dataDir} does not exist`);
    accessSync(config.dataDir, constants.W_OK);
    const mode = statSync(config.dataDir).mode & 0o777;
    if (mode & 0o077) throw new Error(`${config.dataDir} is readable by others (mode ${mode.toString(8)})`);
    return `${config.dataDir} is private and writable`;
  });
  await check("git", "Install git (xcode-select --install)", () => ok("git", ["--version"], "git"));
  await check("gh", "Install the GitHub CLI (gh) and sign in: gh auth login", async () => `${await ok("gh", ["--version"], "gh")}; ${await ok("gh", ["auth", "status"], "gh auth")}`);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  const registry = (process.env.npm_config_registry || "https://registry.npmjs.org/").replace(/\/+$/, "");
  await check("proxy", `Check the proxy (HTTPS_PROXY) and the registry setting (npm config get registry): ${registry}`, async () => {
    const r = await fetch(`${registry}/-/ping`, { signal: AbortSignal.timeout(10_000) });
    // Reaching the registry is not enough: only a success shows it accepted this laptop's credentials and proxy.
    if (!r.ok) throw new Error(`the registry answered ${r.status}${r.status === 401 || r.status === 403 ? ": its credentials were refused" : ""}`);
    await r.body?.cancel();
    return `registry ${registry.replace(/\/\/[^@/]*@/, "//")} answered; proxy ${proxy ? new URL(proxy).host : "none"}`;
  });
  await check("native", "Install OpenCode 2.4.1 so the opencode binary is on PATH", async () => {
    const v = await ok("opencode", ["--version"], "opencode --version");
    if (!/(?:^|[^\d.])2\.\d+\.\d+/.test(v)) throw new Error(`unexpected version: ${v}`);
    return v.startsWith("opencode") ? v : `opencode ${v}`;
  });

  const oc = connect(config.opencode);
  const need = () => {
    if (!oc) throw new Error("OpenCode is not configured (opencode.url) and has not registered itself");
    return oc;
  };
  await check("opencode", `Start OpenCode (opencode serve) at ${config.opencode.url ?? "the configured opencode.url"}`, async () => `OpenCode ${(await need().info()).version ?? "answering"}`);
  await check("model", `Check that the model ${config.opencode.model ?? "(opencode.model)"} answers in OpenCode`, async () => {
    const session = `ses_${randomBytes(12).toString("hex")}`, message = `msg_${randomBytes(12).toString("hex")}`;
    if (!store) throw new Error("the model check needs the database: run doctor with the service running, or with it stopped");
    await need().createSession(store.permit("peer", null, { doctor: session }), { id: session, title: "Overwatch doctor check", agent: "ow-investigator", model: config.opencode.model, directory: emptyDir });
    await need().prompt(store.permit("peer", null, { doctor: message }), session, { id: message, text: "Reply with one word: ready." });
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(50)) {
      const after = OpenCode.after(await need().messages(session), message);
      if (!after.idle) continue;
      if (after.outcome === "failed" || !after.said.trim()) throw new Error(`the model ${config.opencode.model} gave no answer`);
      return `${config.opencode.model} answered`;
    }
    throw new Error(`the model ${config.opencode.model} did not answer within two minutes`);
  });
  // Each role Overwatch runs: its own filing tool allowed, everything else denied. The investigator keeps the id "agent".
  const fixer = Object.values(config.apps).some((a) => a.fixes);
  for (const [id, name, tools] of [["agent", "ow-investigator", [...READ, "ow_finding"]], ["agent:challenger", "ow-challenger", [...READ, "ow_challenge"]], ["agent:responder", "ow-responder", READ], ...(fixer ? [["agent:fixer", "ow-fixer", ["ow_telemetry", "ow_proposal"]] as const] : [])] as const) {
    await check(id, `Add the ${name} agent (deny all, allow ${tools.map((t) => `ow_${t}`).join(", ")}) to your OpenCode configuration; see docs/setup.md`, async () => {
      const agent = (await settled(() => need().agents(emptyDir), (l) => l.some((a) => a.id === name))).find((a) => a.id === name || a.name === name);
      if (!agent) throw new Error(`OpenCode has no ${name} agent`);
      // OpenCode puts its defaults first and the last matching rule wins: evaluate the rules as it does.
      const rules = (Array.isArray(agent.permissions) ? agent.permissions : []) as Array<Record<string, unknown>>;
      const effect = (action: string) => rules.findLast((r) => glob(String(r.action ?? "")).test(action) && String(r.resource ?? "*") === "*")?.effect ?? "allow";
      const others = ["bash", "edit", "read", "webfetch", "ow_other", ...[...READ, "ow_finding", "ow_challenge", "ow_proposal"].filter((t) => !(tools as readonly string[]).includes(t)).map((t) => `ow_${t}`)];
      const missing = tools.filter((t) => effect(`ow_${t}`) !== "allow");
      if (missing.length) throw new Error(`${name} cannot use ${missing.map((t) => `ow_${t}`).join(", ")}`);
      for (const other of others) if (effect(other) !== "deny") throw new Error(`${name} does not deny ${other}`);
      return `${name} can use ${tools.length} Overwatch tools and nothing else`;
    });
  }
  await check("mcp", "Add the remote MCP server ow (url …/mcp, Authorization Bearer, codemode false) to your OpenCode configuration", async () => {
    const entry = (await settled(() => need().mcp(emptyDir), (l) => l.some((m) => m.name === "ow" && JSON.stringify(m.status).includes("connected")))).find((m) => m.name === "ow");
    const status = entry && typeof entry.status === "object" ? (entry.status as { status?: string }).status : entry?.status;
    if (status !== "connected") throw new Error(`OpenCode's MCP server ow is ${status ?? "missing"}`);
    return "OpenCode is connected to ow";
  });
  await check("skill", "Add the overwatch skill to your OpenCode skills folder", async () => {
    if (!(await settled(() => need().skills(emptyDir), (l) => l.some((k) => k.id === "overwatch" || k.name === "overwatch"))).some((s) => s.id === "overwatch" || s.name === "overwatch")) throw new Error("OpenCode has no overwatch skill");
    return "the overwatch skill is installed";
  });

  let job: { program: string | null; path: string | null; proxy: string | null } | null = null;
  await check("launchd", "Install the launchd agent (overwatch install), or check it with: launchctl print gui/$(id -u)/" + LABEL, async () => {
    const r = await exec(launchctl(), ["print", `gui/${process.getuid?.() ?? 0}/${LABEL}`], { timeoutMs: 10_000 });
    if (r.code !== 0) throw new Error(`launchctl print failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const field = (re: RegExp) => re.exec(r.stdout)?.[1]?.trim() ?? null;
    job = { program: field(/^\s*program = (.+)$/m), path: field(/PATH => (.+)$/m), proxy: field(/HTTPS_PROXY => (.+)$/m) };
    return `${LABEL} is ${field(/^\s*state = (.+)$/m) ?? "loaded"}`;
  });
  await check("launchd.paths", "Reinstall the launchd agent from a terminal where kubectl, git and opencode are on PATH", async () => {
    const j = job as typeof job;
    if (!j?.path) throw new Error("the launchd job's PATH is unknown");
    if (j.program && !existsSync(j.program)) throw new Error(`the job runs ${j.program}, which does not exist`);
    const missing = ["kubectl", "git", "opencode"].filter((tool) => !j.path!.split(delimiter).some((dir) => existsSync(join(dir, tool))));
    if (missing.length) throw new Error(`not on the job's PATH: ${missing.join(", ")}`);
    return "kubectl, git and opencode are on the job's PATH";
  });
  await check("launchd.proxy", "Reinstall the launchd agent from a terminal with the proxy settings (HTTPS_PROXY) you use", async () => {
    const j = job as typeof job;
    if (!j) throw new Error("the launchd job's environment is unknown");
    if ((j.proxy ?? null) !== proxy) throw new Error(`the job's HTTPS_PROXY is ${j.proxy ? "different" : "unset"}`);
    return proxy ? "the job uses the same proxy" : "no proxy, in the job or here";
  });

  const contexts = new Map<string, Config["sources"][number]>();
  for (const s of config.sources) if (s.kind === "kubernetes" && !contexts.has(s.context!)) contexts.set(s.context!, s);
  for (const [context, s] of contexts) {
    await check(`cluster:${context}`, `Sign in to ${context} (your cluster's login command), then check with: kubectl --context ${context} -n ${s.namespace} get pods`, async () => {
      const r = await kubectl({ context, namespace: s.namespace! }, "get", ["pods", "-l", s.selector!, "-o", "json"]);
      if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 300) || `kubectl exited ${r.code}`);
      return `${context} answered`;
    });
  }
  for (const s of config.sources.filter((x) => x.kind === "datadog")) {
    await check(`dd:${s.id}`, `Set valid Datadog keys in ${s.apiKey} and ${s.appKey} (datadog API and application keys)`, async () => {
      await validate(s);
      return `Datadog accepted the keys for ${s.id}`;
    });
  }
  for (const [app, { checkout }] of Object.entries(config.apps)) {
    await check(`checkout:${app}`, `Clone ${app} to ${checkout}, or fix apps.${app}.checkout`, async () => `${checkout} at ${(await ok("git", ["-C", checkout, "rev-parse", "--verify", "HEAD^{commit}"], "git rev-parse")).slice(0, 12)}`);
  }
  for (const w of config.watchers) {
    const checkout = config.apps[w.app]!.checkout;
    await check(`deployed:${w.app}/${w.environment}`, `Fetch the deployed commit into ${checkout}: git -C ${checkout} fetch`, async () => {
      const revision = store?.get<{ revision: string }>("SELECT revision FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", w.app, w.environment)?.revision;
      if (!revision) {
        if (!w.sources.some((s) => s.kind === "kubernetes" && s.readings.includes("workloads"))) return "no source reports the running revision";
        throw new Error("no deploy has been observed yet; run the service for one interval");
      }
      await ok("git", ["-C", checkout, "cat-file", "-e", `${revision}^{commit}`], `the deployed commit ${revision.slice(0, 12)} is not in ${checkout}`);
      return `the deployed commit ${revision.slice(0, 12)} is in the checkout`;
    });
  }
  // The challenger and responder only matter once investigations run: they are reported, with their repair, but do
  // not fail the diagnosis on their own (an M1/M2 setup is complete without them).
  return { ok: checks.every((c) => c.ok || c.id.startsWith("agent:")), checks };
}
