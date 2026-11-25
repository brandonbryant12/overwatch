/**
 * End to end against a real OpenCode 2 server: the Overwatch service, the thin plugin, one investigation driven to
 * a citation-checked finding, and the recovery behaviour of plan section 6.5.
 *
 * Nothing real is touched. OpenCode runs with its own temporary HOME, config, data, cache and state; the model is a
 * local fake that speaks the OpenAI chat API and follows a script; the cluster is a fake `kubectl`; there are no
 * credentials. Run with: OPENCODE_BIN=/path/to/opencode pnpm run e2e
 *
 * Phase 1A acceptance tests it covers: 4 (prompt in focus), 5 (OpenCode comes and goes), 6 (continue and remember),
 * 8 (plugin), and the live parts of 3.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Domain from "@alchemy.run/domain";
import { OpenCode } from "@opencode/client";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { IncidentId, messageIdOf, OverwatchApi, threadIdOf } from "../src/domain/index.ts";
import { parseConfig } from "../src/service/config.ts";
import { startService, type ServiceHandle } from "../src/service/service.ts";
import { fakeCluster } from "../test/fixtures/cluster.ts";

const binary = process.env.OPENCODE_BIN;
if (!binary) throw new Error("Set OPENCODE_BIN to an OpenCode 2 binary");
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
assert.match(version, /^opencode v2\./, `expected OpenCode 2, got ${version}`);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = realpathSync(mkdtempSync(join(tmpdir(), "overwatch-e2e-")));
const home = join(root, "home");
const app = join(root, "shop-api");
const work = join(root, "work");
for (const dir of [home, app, work, join(root, "config", "opencode")]) mkdirSync(dir, { recursive: true });
const step = (text: string) => console.log(`✓ ${text}`);

// ------------------------------------------------------------------ the app: a git repository
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
git(app, "init", "-q", "-b", "main");
writeFileSync(join(app, "payments.ts"), "export const TIMEOUT_MS = 300\n");
git(app, "add", ".");
git(app, "commit", "-q", "-m", "deployed");
const deployedCommit = git(app, "rev-parse", "HEAD");

// ------------------------------------------------------------------ the fake model
type Message = { role: string; content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
const textOf = (m: { content: unknown }) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("") : "";
const model = {
  requests: 0,
  tools: [] as string[],
  toolResults: [] as string[],
  prompts: [] as string[],
  hold: undefined as undefined | { release: () => void; promise: Promise<void> },
};
const holdNext = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  model.hold = { release, promise };
  return () => release();
};
const RULED_OUT = "a bad deploy of the payments database";
const finding = (token: string, quote: string, extra: Record<string, unknown> = {}) => ({
  token,
  finding: {
    product: { impact: "Some card payments fail at checkout", affected: "customers paying by card", since: "the last hour", status: "ongoing" },
    engineering: {
      verdict: "real",
      confidence: "high",
      cause: "Payment calls time out after 300ms, set in payments.ts.",
      causeBasis: "observed",
      evidence: [
        { source: "pods", quote },
        { source: "payments.ts", quote: "export const TIMEOUT_MS = 300" },
      ],
      codeLocation: "payments.ts:1",
      notChecked: ["the payment provider's status"],
      nextCheck: "Check the provider's p95 latency for the last hour.",
    },
    ruledOut: [RULED_OUT],
    ...extra,
  },
});

/** What the investigator does next, from the conversation so far. */
function script(messages: Message[], tools: string[]): { call?: { name: string; arguments: string }; text?: string } {
  const all = messages.map(textOf).join("\n");
  const tool = (suffix: string) => tools.find((t) => t.endsWith(suffix)) ?? suffix;
  const tokens = [...all.matchAll(/run token is (owt_[\w-]+)/g)].map((m) => m[1]!);
  const token = tokens.at(-1);
  if (!token) return { text: "No run token in my prompt." };
  // Only what happened since the prompt that carried this token counts.
  const at = messages.findLastIndex((m) => m.role === "user" && textOf(m).includes(token));
  const since = messages.slice(at + 1);
  const results = since.filter((m) => m.role === "tool").map(textOf);
  const prompt = textOf(messages[at]!);
  model.prompts.push(prompt);
  if (results.some((r) => r.includes("Recorded. Stop now"))) return { text: prompt.includes("rule out") ? `We ruled out: ${RULED_OUT}.` : "Filed." };
  if (prompt.includes("recorded the owner's question")) {
    return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) } };
  }
  if (prompt.includes("what did we rule out")) {
    // A fresh session answers from the handoff in its context pack, and cites it.
    const line = prompt.split("\n").find((l) => l.includes(RULED_OUT));
    if (!line) return { text: "The handoff did not reach me." };
    return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) } };
  }
  switch (results.length) {
    case 0:
      return { call: { name: tool("query_telemetry"), arguments: JSON.stringify({ token, source: "pods", since: "2h", args: { operation: "logs", pod: "shop-api-1" } }) } };
    case 1:
      return { call: { name: tool("query_telemetry"), arguments: JSON.stringify({ token, source: "pods", args: { operation: "delete", pod: "shop-api-1" } }) } };
    case 2:
      return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 99 failed because the moon was full")) } };
    case 3:
      return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding("owt_not_this_run", "ERROR payment 42 timed out after 300ms")) } };
    default:
      return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) } };
  }
}

const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages as Message[];
  const tools = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name) as string[];
  model.requests++;
  model.tools = tools;
  for (const m of messages) if (m.role === "tool") model.toolResults.push(textOf(m));
  if (model.hold) {
    const hold = model.hold;
    model.hold = undefined;
    await Promise.race([hold.promise, new Promise((r) => req.on("close", r))]);
    if (res.destroyed) return;
  }
  const isInvestigator = messages.some((m) => m.role === "system" && textOf(m).includes("You are Overwatch's investigator"));
  const next = isInvestigator ? script(messages, tools) : { text: "ok" };
  reply(res, next);
});
function reply(res: ServerResponse, next: { call?: { name: string; arguments: string }; text?: string }) {
  const id = `e2e-${randomUUID()}`;
  const delta = next.call
    ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: next.call }] }
    : { role: "assistant", content: next.text ?? "ok" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "e2e", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "e2e", choices: [{ index: 0, delta: {}, finish_reason: next.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;

// ------------------------------------------------------------------ the Overwatch service
const cluster = fakeCluster({ image: `registry.example/shop-api:${deployedCommit.slice(0, 12)}` });
const now = Date.now();
cluster.log(now - 20 * 60_000, "ERROR payment 42 timed out after 300ms");
cluster.log(now - 15 * 60_000, "ERROR payment 77 timed out after 300ms");
const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
const opencodePort = await freePort();
const password = randomUUID();
process.env.OW_E2E_OPENCODE_PASSWORD = password;
const config = parseConfig({
  apps: {
    "shop-api": {
      checkout: app,
      environments: { production: { sources: { pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api" } } } },
    },
  },
  watchers: [{ app: "shop-api", environment: "production", every: "10m" }],
  dataDir: join(root, "overwatch-data"),
  lookback: { initial: "1h", slice: "1h" },
  notify: false,
  opencode: { url: `http://127.0.0.1:${opencodePort}`, password: "env:OW_E2E_OPENCODE_PASSWORD", autoInvestigate: false },
});
assert.deepEqual(config.errors, []);
const serviceLog: string[] = [];
let service: ServiceHandle = await startService(config, {
  exec: cluster.exec,
  port: 0,
  background: false,
  log: (m) => serviceLog.push(m),
});
const api = <A, E>(f: (client: any) => Effect.Effect<A, E, any>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* f(yield* OverwatchApi.client);
    }).pipe(Effect.scoped, Effect.provide(Domain.protocolHttp(`${service.url}/api`).pipe(Layer.provide(FetchHttpClient.layer)))) as Effect.Effect<A, E, never>,
  );

// ------------------------------------------------------------------ OpenCode, isolated, with the plugin configured globally
writeFileSync(
  join(root, "config", "opencode", "opencode.json"),
  JSON.stringify({
    model: "ow-e2e/e2e",
    providers: {
      "ow-e2e": {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "e2e-only" },
        models: { e2e: { name: "E2E", limit: { context: 64000, output: 4000 } } },
      },
    },
    plugins: [{ package: repo, options: { url: service.url } }],
  }),
);
let opencode: ChildProcess | undefined;
let opencodeLog = "";
const startOpenCode = () => {
  opencode = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(opencodePort), "--print-logs"], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
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
    opencodeLog = (opencodeLog + chunk).slice(-30_000);
    appendFileSync(join(root, "opencode.log"), String(chunk));
  };
  opencode.stdout?.on("data", capture);
  opencode.stderr?.on("data", capture);
};
const stopOpenCode = async () => {
  const proc = opencode;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((r) => {
    proc.once("exit", () => r());
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 10_000).unref();
  });
  opencode = undefined;
};
const client = OpenCode.make({
  baseUrl: `http://127.0.0.1:${opencodePort}`,
  headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
});
const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 60_000, every = 300): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
};
const openCodeUp = () => until("OpenCode", async () => (await client.server.info({ signal: AbortSignal.timeout(1000) }), true));
/** One worker pass after another, until `done`. */
const working = <T>(what: string, done: () => Promise<T | undefined>, ms = 60_000) =>
  until(what, async () => {
    await service.work();
    return done();
  }, ms, 500);

const cleanup = async () => {
  await stopOpenCode().catch(() => undefined);
  provider.close();
  await service.stop().catch(() => undefined);
};

try {
  // ---------------------------------------------------------------- 8. the plugin
  startOpenCode();
  await openCodeUp();
  const fresh = join(root, "fresh-worktree");
  git(app, "worktree", "add", "--detach", fresh, "HEAD");
  const location = { directory: fresh };
  const agents = await until("the investigator agent in a fresh worktree", async () => {
    const list = (await client.agent.list({ location })).data as Array<{ id: string; permissions?: unknown }>;
    return list.some((a) => a.id === "overwatch-investigator") ? list : undefined;
  });
  const investigator = agents.find((a) => a.id === "overwatch-investigator")!;
  const rules = JSON.stringify(investigator.permissions ?? investigator);
  assert.ok(rules.includes('"action":"*","resource":"*","effect":"deny"'), `deny by default: ${rules.slice(0, 400)}`);
  const mcp = await until("the overwatch MCP server", async () => {
    const list = await client.mcp.list({ location } as never);
    return JSON.stringify(list).includes('"overwatch"') && JSON.stringify(list).includes("connected") ? list : undefined;
  });
  step(`${version} loaded the plugin in a fresh worktree: agent overwatch-investigator (deny by default), MCP server overwatch ${JSON.stringify(mcp).includes("connected") ? "connected" : "?"}`);

  // ---------------------------------------------------------------- 3 and 4. a collector run opens an incident; prompt on it
  const watched: string[] = [];
  const watchFiber = Effect.runFork(
    Effect.gen(function* () {
      const c = yield* OverwatchApi.client;
      yield* (c as any).Inbox.watch("inbox").pipe(Stream.runForEach((v: any) => Effect.sync(() => watched.push(JSON.stringify(v)))));
    }).pipe(Effect.scoped, Effect.provide(Domain.protocolHttp(`${service.url}/api`).pipe(Layer.provide(FetchHttpClient.layer)))) as Effect.Effect<void, unknown, never>,
  );
  await service.collect("shop-api/production");
  const inbox = await api((c) => c.Inbox.get("inbox"));
  const item = (inbox as any).items[0];
  assert.ok(item, "the collector run opened an incident");
  await until("the open inbox watch to show it", async () => (watched.some((w) => w.includes(item.incidentId)) ? true : undefined), 10_000);
  step(`a collector run opened incident ${item.incidentId} and a live watch of the inbox showed it without a reload`);

  const incidentId = IncidentId.make(item.incidentId);
  const threadId = threadIdOf(incidentId);
  await api((c) =>
    c.AskThread(threadId, { subject: incidentId, title: item.title, promptId: "p-1", text: "why are payments failing?", mode: "investigate", origin: "page", override: "auto" }),
  );
  const page = await working("the finding", async () => {
    const p = await api((c) => c.IncidentPage.get(incidentId));
    return (p as any)?.findings?.length ? p : undefined;
  }, 90_000);
  const recorded = (page as any).findings[0].finding;
  assert.equal(recorded.engineering.evidence.find((e: any) => e.source === "pods").verified, true, "the telemetry quote was verified");
  assert.equal(recorded.engineering.evidence.find((e: any) => e.source === "payments.ts").verified, true, "the code quote was verified");
  assert.equal(recorded.code?.deployed, true, `the code read was the deployed commit: ${JSON.stringify(recorded.code)}`);
  assert.equal(recorded.code?.commit, deployedCommit);
  const results = model.toolResults.join("\n---\n");
  assert.ok(results.includes("ERROR payment 42 timed out after 300ms"), "query_telemetry returned the fake cluster's logs");
  assert.match(results, /free-form kubectl arguments are not accepted/, "a kubectl operation outside the allowlist was refused");
  assert.match(results, /Not recorded[\s\S]*the quote is not in anything source "pods" returned/, "a made-up citation was refused");
  assert.match(results, /Refused: unknown run token/, "a finding filed for another run was refused");
  const promptOf = async (promptId: string) => ((await api((c) => c.ThreadPage.get(threadId))) as any).prompts.find((p: any) => p.promptId === promptId);
  const sessionId = (await promptOf("p-1")).sessionId as string;
  const session = await client.session.get({ sessionID: sessionId });
  assert.equal((session as any).id, sessionId, "the session exists in OpenCode under the id Overwatch chose");
  step(`prompting on the focused incident created thread ${threadId} and session ${sessionId}; the investigator read evidence over MCP and filed a finding whose citations checked out`);
  step("a made-up citation, a finding filed with another run's token, and a kubectl delete operation were each refused");

  // ---------------------------------------------------------------- 6. continue and remember
  const findings = async () => ((await api((c) => c.IncidentPage.get(incidentId))) as any).findings.length as number;
  await api((c) => c.AskThread(threadId, { subject: incidentId, title: item.title, promptId: "p-2", text: "and what did we rule out so far?", mode: "investigate", origin: "page", override: "auto" }));
  await working("the follow-up from the page", async () => ((await findings()) >= 2 ? true : undefined), 90_000);
  const p2 = await promptOf("p-2");
  assert.equal(p2.sessionId, sessionId, "a follow-up from the page continued the idle session");
  assert.equal(p2.newSession, false);
  step(`a follow-up from the page continued session ${sessionId} (${p2.reason})`);

  // OpenCode restarts, so the directory and the plugin are unloaded; the owner then types in the session itself.
  await stopOpenCode();
  startOpenCode();
  await openCodeUp();
  await client.session.prompt({ sessionID: sessionId, text: "Is this the same as the one in staging?" });
  await working("the prompt typed in OpenCode to land on the thread", async () => {
    const prompts = ((await api((c) => c.ThreadPage.get(threadId))) as any).prompts as any[];
    const typed = prompts.find((p) => p.origin === "opencode");
    return typed && typed.status === "answered" ? typed : undefined;
  }, 90_000);
  const typed = ((await api((c) => c.ThreadPage.get(threadId))) as any).prompts.find((p: any) => p.origin === "opencode");
  assert.equal(typed.sessionId, sessionId, "the prompt typed in OpenCode is recorded on the same thread and session");
  step(`after OpenCode restarted (directory unloaded), a prompt typed in the session in OpenCode landed on thread ${threadId} and was answered with a checked finding`);

  // A fresh session answers "what did we rule out" from the handoff, not from a transcript.
  await api((c) => c.AskThread(threadId, { subject: incidentId, title: item.title, promptId: "p-3", text: "what did we rule out?", mode: "investigate", origin: "page", override: "new" }));
  const p3 = await working("the fresh session's answer", async () => {
    const p = await promptOf("p-3");
    return p?.status === "answered" ? p : undefined;
  }, 90_000);
  assert.notEqual(p3.sessionId, sessionId, "a new session, as asked");
  const freshMessages = ((await client.message.list({ sessionID: p3.sessionId, order: "asc", limit: 50 } as never)) as any).data as any[];
  const freshPrompt = freshMessages.find((m) => m.type === "user")?.text as string;
  assert.ok(freshPrompt.includes("Ruled out:") && freshPrompt.includes(RULED_OUT), "the fresh session's context pack carries the handoff");
  const answer = freshMessages.filter((m) => m.type === "assistant").flatMap((m) => m.content).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
  assert.ok(answer.includes(RULED_OUT), `the fresh session answered from the handoff: ${answer}`);
  step(`a fresh session ${p3.sessionId} answered "what did we rule out" from the handoff: "${answer}"`);

  // ---------------------------------------------------------------- 5 and 3. OpenCode comes and goes; archive stays archived
  await stopOpenCode();
  cluster.log(Date.now() - 60_000, "ERROR payment 88 timed out after 300ms");
  await service.collect("shop-api/production");
  const pageWhere = (ok: (p: any) => boolean, what: string) =>
    until(what, async () => {
      const p = (await api((c) => c.IncidentPage.get(incidentId))) as any;
      return ok(p) ? p : undefined;
    }, 15_000);
  await pageWhere((p) => p.occurrences >= 3, "polling to work with OpenCode stopped");
  await api((c) => c.ArchiveIncident(incidentId, {}));
  await until("the inbox to drop the archived incident", async () => (((await api((c) => c.Inbox.get("inbox"))) as any).items.length === 0 ? true : undefined), 10_000);
  cluster.log(Date.now() - 30_000, "ERROR payment 89 timed out after 300ms");
  await service.collect("shop-api/production");
  const after = await pageWhere((p) => p.occurrences >= 4, "the same signal to update the archived incident");
  assert.equal(after.disposition, "archived");
  assert.equal(((await api((c) => c.Inbox.get("inbox"))) as any).items.length, 0, "and it did not return to the inbox");
  step("with OpenCode stopped: polling worked, archive removed the incident, and the same signal on the next poll updated it silently without bringing it back");

  await api((c) => c.AskThread(threadId, { subject: incidentId, title: item.title, promptId: "p-4", text: "check again", mode: "investigate", origin: "page", override: "new" }));
  const statusDown = await working("the run to wait for OpenCode", async () => {
    const st = (await service.status()) as any;
    return st.opencode.waitingRuns === 1 ? st : undefined;
  }, 15_000);
  const queued = await promptOf("p-4");
  assert.equal(queued.status, "queued", "the prompt job is visibly queued");
  assert.equal(statusDown.opencode.connected, false);
  assert.equal(statusDown.opencode.waitingRuns, 1);
  step(`while OpenCode was stopped the prompt job queued visibly (thread: ${queued.status}; status: OpenCode not connected, ${statusDown.opencode.waitingRuns} run waiting)`);

  // Start OpenCode with the model holding its first answer; restart OpenCode in the middle of that turn.
  const release = holdNext();
  startOpenCode();
  await openCodeUp();
  await working("the queued run to be sent", async () => ((await promptOf("p-4")).status === "sent" ? true : undefined), 60_000);
  const s4 = (await promptOf("p-4")).sessionId as string;
  await until("the turn to be running", async () => ((await client.session.active()) as any)[s4] ? true : undefined, 30_000);
  await stopOpenCode();
  release();
  startOpenCode();
  await openCodeUp();
  await working("the finding after the restart", async () => ((await promptOf("p-4")).status === "answered" ? true : undefined), 120_000);
  const userMessages = ((await client.message.list({ sessionID: s4, type: "user", order: "asc", limit: 50 } as never)) as any).data as any[];
  const sessions = ((await client.session.list({} as never)) as any).data as any[];
  assert.equal(sessions.filter((x) => x.id === s4).length, 1, "one session");
  const original = messageIdOf(threadId, "p-4");
  const resume = messageIdOf(threadId, "p-4", 1);
  assert.equal(userMessages.filter((m) => m.id === original).length, 1, `the prompt was sent once: ${JSON.stringify(userMessages.map((m) => m.id))}`);
  assert.ok(userMessages.every((m) => m.id === original || m.id === resume), `nothing else was sent: ${JSON.stringify(userMessages.map((m) => m.id))}`);
  const resumed = userMessages.some((m) => m.id === resume);
  step(
    `starting OpenCode drained the queue once; restarting it mid-turn ended with one session (${s4}), the prompt sent once and the finding recovered` +
      (resumed ? " (this unmanaged OpenCode server did not resume the turn itself, so Overwatch asked the session to continue, once)" : ""),
  );
  // Not a test: dropping OpenCode's event stream is not simulated here. The service never subscribes to that stream;
  // it follows runs by the session's stored messages, which is what the restart above exercised.
  console.log("· not tested: dropping the event stream (the service does not use it; see the comment in scripts/e2e.ts)");

  console.log("e2e passed");
  Effect.runFork(Fiber.interrupt(watchFiber));
  await cleanup();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.error(error);
  try {
    const sessions = (await client.session.list({} as never)) as any;
    for (const session of sessions.data ?? []) {
      const messages = await client.message.list({ sessionID: session.id, order: "asc", limit: 50 } as never);
      const inbox = await client.session.inbox.list({ sessionID: session.id });
      const steps = ((messages as any).data as any[]).map((m) =>
        m.type === "assistant"
          ? m.content.map((c: any) => (c.type === "tool" ? `${c.name}(${JSON.stringify(c.state?.input ?? {}).slice(0, 60)}) -> ${JSON.stringify(c.state?.content ?? c.state?.error ?? "").slice(0, 160)}` : `${c.type}: ${String(c.text ?? "").slice(0, 80)}`)).join(" | ")
          : `${m.type}: ${String(m.text ?? m.outcome ?? "").slice(0, 80)}`,
      );
      console.error(`session ${session.id} agent=${session.agent}:\n  ${steps.slice(0, 14).join("\n  ")}\n inbox: ${JSON.stringify(inbox).slice(0, 300)}`);
    }
    console.error("active:", JSON.stringify(await client.session.active()));
  } catch (e) {
    console.error("could not read sessions:", e);
  }
  console.error(`model requests: ${model.requests}`);
  console.error(`--- service log (tail) ---\n${serviceLog.slice(-40).join("\n")}`);
  console.error(`--- OpenCode log (tail) ---\n${opencodeLog.slice(-6000)}\n--- kept ${root} for inspection ---`);
  await cleanup();
  process.exit(1);
}
