/**
 * Manual check against the real OpenCode binary (not part of `pnpm run check`):
 *
 *   OPENCODE_BIN=/path/to/opencode node --experimental-strip-types --no-warnings test/real/opencode.ts
 *
 * Runs Overwatch (scheduler idle: no kubectl, no Datadog), a scripted OpenAI-compatible model on loopback, and the
 * real OpenCode with its own temporary HOME, config, data, cache and state, then `overwatch trial` and `overwatch
 * doctor` through it. Nothing outside the temporary directory is read or written.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const binary = process.env.OPENCODE_BIN;
if (!binary) throw new Error("set OPENCODE_BIN to an OpenCode 2.4.1 binary");
const bin = fileURLToPath(new URL("../../bin/overwatch", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "ow-real-opencode-"));
for (const d of ["home", "config/opencode/skills/overwatch", "data", "cache", "state", "tmp", "checkout"]) mkdirSync(join(root, d), { recursive: true });
const expected: Record<string, string> = { regression: "real", noise: "not_real", predates: "not_real", missing: "unsure", planted: "not_real" };
const log: string[] = [];

// ---- the scripted model: an investigator reads telemetry once, then files with the first handle and the right verdict.
type Msg = { role: string; content?: unknown; tool_calls?: unknown };
const text = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "").join("") : "");
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw) as { messages: Msg[]; tools?: Array<{ function?: { name: string } }> };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
  const tool = (name: string) => tools.find((t) => t === name || t.endsWith(`_${name}`)) ?? name;
  const all = body.messages.map(text).join("\n");
  const id = Object.keys(expected).find((k) => all.includes(`Overwatch trial ${k}`));
  log.push(`model request: case=${id ?? "none"} tools=${tools.join(",")}`);
  if (!id) return reply(res, { text: "ready" });
  const results = body.messages.filter((m) => m.role === "tool").map(text);
  const telemetry = results.find((r) => r.includes('"pieces"'));
  if (results.some((r) => r.includes('"verdict"'))) return reply(res, { text: "Filed." });
  if (!telemetry) return reply(res, { call: { name: tool("ow_telemetry"), arguments: JSON.stringify({ source: "pods" }) } });
  const handle = /"handle":"(e_[0-9a-f]+)"/.exec(telemetry)?.[1];
  const filing = {
    verdict: expected[id], cause: "scripted", claims: [{ statement: "scripted", evidence: [handle] }], ruled_out: [], not_checked: [],
    next_check: "none", impact: "none", affected: [], since: null, status: "investigated",
  };
  return reply(res, { call: { name: tool("ow_finding"), arguments: JSON.stringify(filing) } });
});
function reply(res: ServerResponse, next: { call?: { name: string; arguments: string }; text?: string }) {
  const id = `s-${randomUUID()}`;
  const delta = next.call ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: next.call }] } : { role: "assistant", content: next.text };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta: {}, finish_reason: next.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerPort = (provider.address() as { port: number }).port;
const freePort = async () => {
  const s = createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return p;
};

// ---- Overwatch, with its scheduler held idle by the test descriptor.
const token = randomBytes(24).toString("hex");
const ocPort = await freePort();
execFileSync("git", ["-C", join(root, "checkout"), "init", "-q"]);
const config = join(root, "config.json");
writeFileSync(config, JSON.stringify({
  version: 2, dataDir: join(root, "store"), port: 0, mcpToken: "env:OW_MCP_TOKEN",
  opencode: { url: `http://127.0.0.1:${ocPort}`, model: "scripted/glm", password: "env:OPENCODE_PASSWORD" },
  apps: { shop: { checkout: join(root, "checkout"), environments: { prod: { sources: { pods: { type: "kubernetes", context: "none", namespace: "shop", selector: "app=shop" } } } } } },
  watchers: [{ app: "shop", environment: "prod", every: "10m" }],
}));
const ocPassword = randomBytes(16).toString("hex");
// Only stubs and the binary under test are on PATH: no real kubectl, gh or launchctl is ever run.
const stubs = join(root, "bin");
mkdirSync(stubs);
for (const name of ["kubectl", "gh", "launchctl", "security"]) writeFileSync(join(stubs, name), "#!/bin/sh\necho stub >&2\nexit 1\n", { mode: 0o755 });
symlinkSync(binary, join(stubs, "opencode"));
const PATH = [stubs, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const env = { ...process.env, PATH, OPENCODE_PASSWORD: ocPassword, OW_MCP_TOKEN: token, HOME: join(root, "home"), TMPDIR: join(root, "tmp") };
const service = spawn(bin, ["serve", "--config", config, "--json"], { env: { ...env, OW_TEST_FD: "3" }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
service.stderr!.on("data", (b) => log.push(`overwatch: ${b}`));
const ready = JSON.parse(String((await once(service.stdout!, "data"))[0]).split("\n")[0]!) as { url: string };

// ---- the real OpenCode, isolated, configured the way `docs/setup.md` says.
writeFileSync(join(root, "config/opencode/opencode.json"), JSON.stringify({
  model: "scripted/glm",
  providers: { scripted: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "scripted" }, models: { glm: { name: "Scripted", limit: { context: 64000, output: 4000 } } } } },
  agents: { "ow-investigator": { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }, ...["ow_telemetry", "ow_code_read", "ow_code_search", "ow_history", "ow_finding"].map((n) => ({ action: `ow_${n}`, resource: "*", effect: "allow" }))] } },
  mcp: { servers: { ow: { type: "remote", url: `${ready.url}/mcp`, headers: { Authorization: `Bearer ${token}` }, oauth: false, codemode: false } } },
}));
writeFileSync(join(root, "config/opencode/skills/overwatch/SKILL.md"), "---\nname: overwatch\ndescription: Read the Overwatch inbox.\n---\nUse the Overwatch tools.\n");
let opencode: ChildProcess | undefined;
try {
  opencode = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(ocPort), "--print-logs"], {
    cwd: join(root, "tmp"),
    env: { PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_PASSWORD: ocPassword, TMPDIR: join(root, "tmp") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  opencode.stderr!.on("data", (b) => {
    for (const line of String(b).split("\n")) if (line && !/Sent HTTP response.*status=200|level=DEBUG/.test(line)) log.push(`opencode: ${line.slice(0, 500)}`);
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${ocPort}/api/info`, { headers: { authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64") } })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const cli = (command: string) => {
    const r = spawn(bin, [command, "--config", config, "--json"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    r.stdout!.on("data", (b) => (out += b));
    r.stderr!.on("data", (b) => (err += b));
    return once(r, "close").then(([code]) => ({ code, out, err }));
  };
  const trial = await cli("trial");
  console.log("trial exit", trial.code, trial.err.slice(0, 500));
  console.log(trial.out.slice(0, 3000));
  const auth = { authorization: "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64") };
  for (const path of ["/api/agent", "/api/mcp", "/api/skill"])
    for (const query of ["", `?location[directory]=${encodeURIComponent(join(root, "store", "empty"))}`]) {
      const body = await (await fetch(`http://127.0.0.1:${ocPort}${path}${query}`, { headers: auth })).text();
      if (process.env.OW_REAL_RAW) console.log(path, query ? "(location)" : "", path === "/api/agent" ? JSON.stringify(JSON.parse(body).data.find((a: { id: string }) => a.id === "ow-investigator")?.permissions) : body.slice(0, 300));
    }
  const doctor = await cli("doctor");
  console.log("doctor exit", doctor.code);
  for (const c of (JSON.parse(doctor.out || "{}").checks ?? []) as Array<{ id: string; ok: boolean; detail: string }>) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.id}: ${c.detail}`);
} finally {
  if (process.env.OW_REAL_LOG) console.log(log.join("\n").slice(-20000));
  opencode?.kill();
  service.kill();
  provider.close();
}
