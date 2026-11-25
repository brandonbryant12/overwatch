/**
 * Loads Overwatch into a real OpenCode 2 server and drives one watcher run and one /investigate end to end.
 *
 * Nothing real is touched: OpenCode runs with its own temporary HOME, config, data, cache and state; the model is a
 * local fake that speaks the OpenAI chat API; `kubectl` and `gh` on PATH are fakes that log their arguments; there
 * are no credentials. Run with: OPENCODE_BIN=/path/to/opencode bun scripts/smoke.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";

const binary = process.env.OPENCODE_BIN;
if (!binary) throw new Error("Set OPENCODE_BIN to an OpenCode 2 binary");
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /^opencode v2\./, `expected OpenCode 2, got ${version}`);

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "overwatch-smoke-")));
const home = join(root, "home");
const work = join(root, "work");
const app = join(root, "shop-api");
const bin = join(root, "bin");
const kubectlLog = join(root, "kubectl.log");
for (const dir of [home, work, app, bin, join(root, "config", "opencode", "skills", "k8s-notes")]) mkdirSync(dir, { recursive: true });

// The app: a git repo whose deployed commit is what the fake cluster runs.
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: app, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(app, "payments.ts"), "export const TIMEOUT_MS = 300\n");
git("add", ".");
git("commit", "-q", "-m", "deployed");
const deployed = git("rev-parse", "HEAD");

// A fake cluster: kubectl answers from files and records every invocation.
const now = Date.now();
const ts = (msAgo: number) => new Date(now - msAgo).toISOString();
writeFileSync(
  join(root, "pods.json"),
  JSON.stringify({
    items: [
      {
        metadata: { name: "shop-api-1", labels: { app: "shop-api" } },
        spec: { nodeName: "node-a", containers: [{ name: "api", image: `registry.example/shop-api:${deployed.slice(0, 12)}`, resources: { limits: { cpu: "1", memory: "512Mi" } } }] },
        status: { startTime: ts(86_400_000), conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "api", ready: true, state: { running: {} } }] },
      },
    ],
  }),
);
writeFileSync(
  join(root, "logs.txt"),
  [
    `[pod/shop-api-1/api] ${ts(300_000)} ERROR payment 42 timed out after 300ms`,
    `[pod/shop-api-1/api] ${ts(240_000)} ERROR payment 77 timed out after 300ms`,
    `[pod/shop-api-1/api] ${ts(200_000)} INFO healthy`,
  ].join("\n") + "\n",
);
const fake = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
fake(
  "kubectl",
  `echo "$*" >> "${kubectlLog}"
case "$6 $7" in
  "get pods") cat "${join(root, "pods.json")}" ;;
  "get events"|"get resourcequota") echo '{"items":[]}' ;;
  "top pods") echo "shop-api-1 api 100m 100Mi" ;;
  "top nodes") echo "node-a 100m 5% 100Mi 5%" ;;
  logs*) cat "${join(root, "logs.txt")}" ;;
  *) echo "unexpected kubectl $*" >&2; exit 1 ;;
esac`,
);
fake("gh", `echo "gh must not be called in the smoke test: $*" >&2; exit 1`);

// A user skill the watcher names; the investigation must receive it.
writeFileSync(
  join(root, "config", "opencode", "skills", "k8s-notes", "SKILL.md"),
  "---\nname: k8s notes\ndescription: Notes on this team's cluster\n---\nSKILL-MARKER: payments run behind the shop-api service.\n",
);

// A deterministic model. The investigator queries the cluster, then files a finding.
const seen = { shown: 0, investigatorTools: [] as string[], investigatorRequests: 0, skillDelivered: false, queryResult: "" };
const finding = {
  product: { impact: "Some card payments fail at checkout", affected: "customers paying by card", since: "the last hour", status: "ongoing" },
  engineering: {
    verdict: "real",
    confidence: "high",
    cause: "Payment calls time out after 300ms, set in payments.ts at the deployed commit.",
    causeBasis: "observed",
    evidence: [
      { source: "pods", quote: "ERROR payment 42 timed out after 300ms" },
      { source: "payments.ts", quote: "export const TIMEOUT_MS = 300" },
    ],
    codeLocation: "payments.ts:1",
    notChecked: ["the payment provider's status"],
    nextCheck: "Check the provider's p95 latency for the last hour.",
  },
};
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Array<{ role: string; content: unknown }>;
  const all = JSON.stringify(messages);
  const tools = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
  let call: { name: string; arguments: string } | undefined;
  let text = "ok";
  const textOf = (m: { content: unknown }) =>
    typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("") : "";
  const last = messages.at(-1);
  if (last && last.role === "user" && textOf(last).includes("[Overwatch] Show the text below")) {
    // The main agent relays what Overwatch shows, verbatim.
    seen.shown++;
    text = textOf(last).slice(textOf(last).indexOf("\n\n") + 2);
  } else if (all.includes("You are Overwatch's investigator")) {
    seen.investigatorRequests++;
    seen.investigatorTools = tools;
    if (all.includes("SKILL-MARKER")) seen.skillDelivered = true;
    const results = messages.filter((m) => m.role === "tool");
    if (results.length === 0) {
      call = { name: "overwatch_query", arguments: JSON.stringify({ app: "shop-api", environment: "production", source: "pods", since: "1h", args: { verb: "logs", args: ["shop-api-1"] } }) };
    } else if (!all.includes("Recorded. Stop now")) {
      seen.queryResult = JSON.stringify(results[0]);
      call = { name: "overwatch_report", arguments: JSON.stringify(finding) };
    } else text = "Filed.";
  }
  const id = `smoke-${randomUUID()}`;
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: call }] } : { role: "assistant", content: text };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "smoke", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;

writeFileSync(
  join(root, "config", "opencode", "opencode.json"),
  JSON.stringify({
    model: "ow-smoke/smoke",
    providers: {
      "ow-smoke": {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "smoke-only" },
        models: { smoke: { name: "Smoke", limit: { context: 64000, output: 4000 } } },
      },
    },
    plugins: [
      {
        package: plugin,
        options: {
          apps: {
            "shop-api": {
              checkout: app,
              environments: {
                production: { sources: { pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api" } } },
              },
            },
          },
          watchers: [{ app: "shop-api", environment: "production", every: "1h", skills: ["k8s-notes"] }],
          dataDir: join(root, "overwatch-data"),
          notify: false,
          timeouts: { investigation: "2m" },
        },
      },
    ],
  }),
);

const port = await new Promise<number>((r) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});
const password = randomUUID();
let server: ChildProcess | undefined;
let log = "";
const cleanup = () => {
  server?.kill("SIGTERM");
  provider.close();
};

try {
  server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    cwd: work,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      KUBECONFIG: join(root, "no-kubeconfig"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_PASSWORD: password,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    log = (log + chunk).slice(-20_000);
    appendFileSync(join(root, "server.log"), String(chunk));
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);

  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } });
  const location = { directory: work };
  const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 60_000, every = 500): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await fn().catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, every));
    }
  };

  await until("the server", async () => (await client.server.info({ signal: AbortSignal.timeout(1000) }), true));
  const session = await client.session.create({ title: "smoke", location });
  const commands = await until("Overwatch commands", async () => {
    const list = (await client.command.list({ location })).data.map((c: any) => c.name);
    return list.includes("investigate") ? list : undefined;
  });
  for (const name of ["investigate", "overwatch", "overwatch-run"]) assert.ok(commands.includes(name), `command ${name} registered`);
  const agents = (await client.agent.list({ location })).data.map((a: any) => a.id);
  for (const id of ["overwatch-investigator", "overwatch-fixer"]) assert.ok(agents.includes(id), `agent ${id} registered`);
  const plugins = await client.plugin.list({ location });
  assert.ok(JSON.stringify(plugins).includes("overwatch"), "plugin listed");
  console.log(`✓ ${version} loaded the plugin: commands ${["investigate", "overwatch", "overwatch-run"].join(", ")}; agents overwatch-investigator, overwatch-fixer`);

  const messages = async (sessionID: string) => JSON.stringify(await client.session.context({ sessionID }));
  const status = async () => {
    await client.session.command({ sessionID: session.id, name: "overwatch", text: "" });
    const all = await messages(session.id);
    return all.slice(all.lastIndexOf("## Overwatch"));
  };

  // The scheduler runs the never-run watcher on its first tick; wait for the investigation it starts.
  const done = await until("the scheduled watcher's investigation", async () => {
    const text = await status();
    return text.includes("[done]") ? text : undefined;
  }, 120_000, 3_000);
  assert.ok(seen.shown > 0, "the main agent was asked to relay Overwatch output");
  assert.match(done, /shop-api\/production\*\* every 1h, last run/);
  assert.match(done, /pods: checked through/);
  assert.match(done, /real: Some card payments fail at checkout/);
  assert.ok(seen.investigatorTools.includes("overwatch_query") && seen.investigatorTools.includes("overwatch_report"), `investigator tools: ${seen.investigatorTools}`);
  for (const denied of ["edit", "write", "patch", "webfetch"]) assert.ok(!seen.investigatorTools.includes(denied), `investigator must not get ${denied}: ${seen.investigatorTools}`);
  assert.ok(seen.skillDelivered, "the watcher's named skill reached the investigation");
  assert.ok(seen.queryResult.includes("timed out after 300ms"), "overwatch_query returned the fake cluster's logs");
  console.log(`✓ scheduled watcher opened an incident and the investigator filed a finding (tools offered: ${seen.investigatorTools.join(", ")})`);

  // Running again finds nothing new: the overlap is de-duplicated.
  await client.session.command({ sessionID: session.id, name: "overwatch-run", text: "shop-api/production" });
  const rerun = await until("the manual run's result", async () => {
    const all = await messages(session.id);
    return all.includes("shop-api/production: 0 opened") ? all : undefined;
  });
  assert.ok(rerun);
  console.log("✓ /overwatch-run reran the watcher from its checkpoint and opened nothing new");

  // A one-off investigation posts the same kind of report back into the session that asked.
  await client.session.command({ sessionID: session.id, name: "investigate", text: "--app shop-api --env production Customer says checkout failed for order 42" });
  const report = await until("the /investigate report", async () => {
    const all = await messages(session.id);
    const at = all.lastIndexOf("**Product summary**");
    return at > all.indexOf("Overwatch is investigating") && all.indexOf("Overwatch is investigating") >= 0 ? all.slice(at - 400) : undefined;
  }, 120_000);
  assert.ok(report.includes(`deployed ${deployed.slice(0, 12)}`), "report names the deployed commit");
  assert.ok(report.includes("Verdict: Real (high confidence)"), "report leads with the verdict");
  console.log("✓ /investigate produced a report at the deployed commit and posted it back");

  // Each investigation's worktree is removed once it is done, while the server that ran its session is still up.
  await until("worktrees to be removed", async () => {
    const left = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: app, encoding: "utf8" }).split("\n").filter((l) => l.startsWith("worktree "));
    return left.length === 1 ? true : undefined;
  }, 30_000);
  console.log("✓ investigation worktrees were removed when the investigations finished");

  const kubectlCalls = readFileSync(kubectlLog, "utf8").trim().split("\n");
  assert.ok(kubectlCalls.length > 0);
  for (const line of kubectlCalls) {
    assert.match(line, /^--context prod-cluster --namespace shop --request-timeout=20s (get|describe|logs|top) /, `read-only kubectl only: ${line}`);
  }
  console.log(`✓ ${kubectlCalls.length} kubectl calls, all read-only with the configured context and namespace`);
  console.log("smoke passed");
  cleanup();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  cleanup();
  console.error(error);
  console.error(`--- server log (tail) ---\n${log.slice(-6000)}\n--- kept ${root} for inspection ---`);
  process.exit(1);
}
