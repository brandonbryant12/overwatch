// Explicit native compatibility run. Only the scripted model, local bare Git and test gh receive requests.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { scenario, ledger, git } from "./rig.mjs"
import { filing } from "../m1/peers.mjs"

test("native 2.4.1 through both calibrations and published draft", { timeout: 180000 }, async (t) => {
  assert.ok(process.env.OPENCODE_BIN)
  const choices = []
  const provider = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const { messages, tools = [] } = JSON.parse(raw)
    const text = messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n")
    const results = messages.filter((m) => m.role === "tool")
    const handle = /e_[a-f0-9]{12,}/.exec(JSON.stringify(results))?.[0]
    const cases = {
      regression: "real",
      noise: "not_real",
      predates: "not_real",
      missing: "unsure",
      planted: "not_real",
    }
    const trial = Object.keys(cases).find((k) => text.includes("Overwatch trial " + k))
    let name, args
    if (text.includes("You are Overwatch's fixer") && !results.length) {
      name = "ow_proposal"
      args = text.includes("other.json to 9")
        ? { kind: "abstain" }
        : !choices.length
          ? { kind: "revert" }
          : { kind: "setting", path: "settings.json", key: "timeout" }
      choices.push(args.kind)
    } else if (trial || /Reading \d\/\d|Challenge\n/.test(text)) {
      if (!results.length) {
        name = "ow_telemetry"
        args = { source: "pods" }
      } else if (results.length === 1 && handle) {
        if (!trial && text.includes("Challenge\n")) {
          name = "ow_challenge"
          args = { outcome: "upheld", reason: "Timeout follows rollout", evidence: [handle] }
        } else {
          name = "ow_finding"
          args = filing(cases[trial] ?? "real", [handle], "Checkout timed out")
        }
      }
    }
    const id = randomUUID()
    const call = tools.find((t) => t.function.name.endsWith("_" + name))?.function.name
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            { index: 0, id, type: "function", function: { name: call, arguments: JSON.stringify(args) } },
          ],
        }
      : { role: "assistant", content: "Filed." }
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const [part, finish_reason] of [
      [delta, null],
      [{}, call ? "tool_calls" : "stop"],
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1,
            model: "scripted",
            choices: [{ index: 0, delta: part, finish_reason }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }) +
          "\n\n",
      )
    res.end("data: [DONE]\n\n")
  }).listen(0, "127.0.0.1")
  await once(provider, "listening")
  t.after(() => provider.close())
  const portServer = createServer().listen(0, "127.0.0.1")
  await once(portServer, "listening")
  const port = portServer.address().port
  await new Promise((r) => portServer.close(r))
  const password = randomUUID()
  let child
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      x.cfg.opencode = {
        model: "scripted/glm-5.3",
        url: "http://127.0.0.1:" + port,
        password: "env:OPENCODE_PASSWORD",
      }
      x.env.OPENCODE_PASSWORD = password
    },
    async afterStart(x) {
      const cfg = JSON.parse(fs.readFileSync(x.dir("config/opencode/opencode.json")))
      cfg.model = x.cfg.opencode.model
      cfg.providers = {
        scripted: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: "http://127.0.0.1:" + provider.address().port + "/v1", apiKey: "scripted" },
          models: { "glm-5.3": { name: "Scripted", limit: { context: 64000, output: 4000 } } },
        },
      }
      for (const [role, tools] of Object.entries({
        challenger: ["telemetry", "code_read", "code_search", "history", "challenge"],
        responder: ["telemetry", "code_read", "code_search", "history"],
        fixer: ["telemetry", "proposal"],
      }))
        cfg.agents["ow-" + role] = {
          mode: "primary",
          permissions: [
            { action: "*", resource: "*", effect: "deny" },
            ...tools.map((n) => ({ action: "ow_ow_" + n, resource: "*", effect: "allow" })),
          ],
        }
      fs.writeFileSync(x.dir("config/opencode/opencode.json"), JSON.stringify(cfg))
      child = spawn(process.env.OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: x.dir("tmp"),
        env: { ...x.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
        stdio: "ignore",
      })
      const closed = once(child, "close")
      t.after(async () => {
        child.kill()
        await closed
      })
      const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64")
      for (let i = 0; i < 150; i++) {
        if (
          await fetch(x.cfg.opencode.url + "/api/info", { headers: { authorization: auth } }).then(
            (r) => r.ok,
            () => false,
          )
        )
          return
        await delay(100)
      }
      assert.fail("native peer never answered")
    },
  })
  assert.equal(end.state, "draft", end.reason)
  assert.equal(ledger(x).length, 1)
  assert.deepEqual(choices, ["revert", "setting", "abstain", "setting"])
  const [pr] = ledger(x)
  assert.ok(pr.body.includes("<!-- overwatch-attempt: " + end.id + " -->"))
  assert.equal(pr.baseRefName, "main")
  assert.equal(pr.isDraft, true)
  assert.equal(git(x, "--git-dir", x.dir("remote.git"), "rev-parse", pr.headRefName), end.head)
  const { valid, correct, falseReal, obeyed, peakSessions, fixGate } = x.trial
  t.diagnostic(
    JSON.stringify({
      valid,
      correct,
      falseReal,
      obeyed,
      peakSessions,
      fixGate,
      choices,
      head: end.head,
      verification: end.verification,
      pr: end.pr,
    }),
  )
})
