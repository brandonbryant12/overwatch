import test from "node:test"
import assert from "node:assert/strict"
import fc from "fast-check"
import { rig } from "./rig.mjs"

test("check validates configuration cardinalities offline at both edges", async (t) => {
  const x = await rig(t, { baseline: false }),
    base = structuredClone(x.cfg.apps.shop),
    watch = x.cfg.watchers[0]
  const check = async (n, sourceN, secs, ok) => {
    x.cfg.apps = {}
    x.cfg.watchers = []
    for (let i = 0; i < n; i++) {
      const app = "app" + i,
        cfg = structuredClone(base),
        src = cfg.environments.prod.sources.pods
      cfg.environments.prod.sources = Object.fromEntries(
        Array.from({ length: sourceN }, (_, j) => ["source" + j, src]),
      )
      x.cfg.apps[app] = cfg
      x.cfg.watchers.push({ ...watch, app, every: secs + "s" })
    }
    x.save()
    const v = await x.json("check", [], ok ? 0 : 2)
    if (ok) {
      assert.equal(v.watchers, n)
      assert.equal(v.version, 2)
    } else assert.ok(v.error.message.length)
  }
  await check(50, 4, 60, true)
  await check(51, 4, 60, false)
  await check(1, 5, 60, false)
  await check(1, 1, 59, false)
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 51 }),
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 45, max: 75 }),
      async (n, s, e) => check(n, s, e, n <= 50 && s <= 4 && e >= 60),
    ),
    { numRuns: 5 },
  )
  assert.equal(x.calls().length, 0)
  assert.equal(x.p.requests.length, 0)
})
test("doctor probes each dependency with the launch environment and returns individual repairs", async (t) => {
  const x = await rig(t, { both: true })
  await x.start()
  await x.poll()
  const v = await x.json("doctor"),
    ids = [
      "node",
      "data",
      "git",
      "gh",
      "proxy",
      "native",
      "opencode",
      "model",
      "agent",
      "mcp",
      "skill",
      "launchd",
      "launchd.paths",
      "launchd.proxy",
      "cluster:lab",
      "dd:shop/prod/dd",
      "checkout:shop",
      "deployed:shop/prod",
    ]
  assert.equal(v.ok, true)
  for (const id of ids) {
    const c = v.checks.find((c) => c.id === id)
    assert.ok(c?.ok, id)
    assert.equal(c.fix, null)
  }
  const failing = async (patch, id, pattern) => {
    x.world(patch)
    const s = await x.json("doctor", [], 4)
    assert.equal(s.ok, false)
    assert.ok(s.checks.length >= ids.length)
    const f = s.checks.find((c) => c.id === id)
    assert.equal(f.ok, false, id)
    assert.match(f.fix, pattern)
    assert.ok(f.detail)
  }
  await failing({ failTool: "launchctl" }, "launchd", /launchctl|install/i)
  await failing({ failTool: "opencode" }, "native", /opencode|binary/i)
  await failing({ failTool: "gh" }, "gh", /\bgh\b|github/i)
  const before = x.calls().filter((c) => c.name === "kubectl").length
  await failing({ failTool: null, kubeFailure: "Unauthorized" }, "cluster:lab", /lab/)
  assert.equal(x.calls().filter((c) => c.name === "kubectl").length - before, 1)
  await failing({ kubeFailure: null, ddFailure: 403 }, "dd:shop/prod/dd", /DD_|datadog/i)
  await failing({ ddFailure: null, ocDown: true }, "opencode", /opencode/i)
  await failing({ ocDown: false, modelDown: true }, "model", /model|fixture\/glm/i)
  const human = await x.cli("doctor", [], { human: true })
  assert.equal(human.code, 4)
  assert.match(human.out, /model/i)
})

test("demo supplies a useful offline dataset without consulting the configured peers", async (t) => {
  const x = await rig(t, { both: true })
  await x.start("demo")
  assert.equal(x.ready.demo, true)
  const s = await x.status()
  assert.ok(s.environments.some((e) => e.health === "signed_out"))
  assert.ok(s.environments.length >= 2)
  assert.ok(s.incidents.some((i) => /timeout/i.test(i.title)))
  assert.ok(s.deploys.length)
  assert.equal(x.p.requests.length, 0)
  assert.equal(x.calls().length, 0)
})
