import test from "node:test"
import assert from "node:assert/strict"
import { rig, T, stamp, iso, total, byTitle } from "./rig.mjs"

const minute = 60_000, hour = 60 * minute
async function setup(t, readings) {
  const x = await rig(t)
  x.cfg.apps.shop.environments.prod.sources.pods.readings = readings
  x.save()
  await x.start()
  return x
}
async function sample(x, patch) {
  x.world(patch)
  await x.advance(minute)
  await x.poll()
  return x.status()
}
const logs = (s) => s.coverage.filter(c => c.reading === "logs").at(-1)
const health = (s) => s.environments[0].health

test("restart during read discards the ambiguous window; previous instance can recover it once", async t => {
  const x = await setup(t, ["logs"])
  const lines = [[stamp, "ERROR lost"]]
  x.world({ lines, restartDuringLogs: true })
  await x.poll()
  const first = await x.status()
  assert.equal(logs(first).state, "gap")
  assert.equal(total(first, "lost"), 0)
  const second = await sample(x, { restartDuringLogs: false, restart: 1, previous: lines, lines: [] })
  assert.equal(total(second, "lost"), 1)
  assert.equal(total(await sample(x, {}), "lost"), 1)
})

test("a running pod without a container instance cannot report fully measured logs", async t => {
  const x = await setup(t, ["logs"])
  x.world({ missingIdentity: true })
  await x.poll()
  assert.equal(logs(await x.status()).state, "gap")
})

test("an observed loss downgrades the affected count permanently across restart", async t => {
  const x = await setup(t, ["logs"])
  const row = [stamp, "ERROR rotated"]
  x.world({ lines: [row, row] })
  await x.poll()
  const second = await sample(x, { lines: [row] })
  assert.equal(logs(second).state, "gap")
  assert.equal(total(second, "rotated"), 2)
  await x.stop()
  await x.start()
  assert.equal(byTitle(await x.status(), "rotated")[0].exact, false)
})

test("a Kubernetes catch-up commits complete six-hour slices and resumes after a failed read", async t => {
  const x = await setup(t, ["logs"])
  await x.poll()
  await x.advance(14 * 24 * hour + hour)
  const start = T + hour
  const lines = Array.from({ length: 56 }, (_, i) => [iso(start + (6 * i + 1) * hour), "ERROR hourly"])
  x.world({ lines, failSince: start + 12 * hour - 2 * minute })
  await x.poll()
  const s = await x.status()
  assert.equal(s.sources[0].checkpointMs, start + 12 * hour)
  assert.equal(total(s, "hourly"), 2)
  assert.ok(s.coverage.some(c => c.state === "gap" && c.fromMs === T && c.toMs === start && c.missed === null))
  await x.stop("SIGKILL")
  await x.start()
  const end = await sample(x, { failSince: null })
  assert.equal(total(end, "hourly"), 56)
  assert.equal(end.sources[0].checkpointMs, x.now())
  const starts = x.calls().filter(c => c.args.includes("logs")).map(c => c.args.find(a => a.startsWith("--since-time=")))
  assert.equal(starts.filter(a => a === "--since-time=" + iso(start + 12 * hour - 2 * minute)).length, 2)
})

test("first catch-up slice excludes observations inside the declared older-than-14-days gap", async t => {
  const x = await setup(t, ["logs"])
  await x.poll()
  await x.advance(14 * 24 * hour + hour)
  x.world({ lines: [[iso(T + hour - 1), "ERROR outside"], [iso(T + hour), "ERROR inside"]],
    failSince: T + 7 * hour - 2 * minute })
  await x.poll()
  const s = await x.status()
  assert.equal(total(s, "inside"), 1)
  assert.equal(total(s, "outside"), 0)
})

test("a fresh arrival after a saturated window has its own admission budget", { skip: !process.env.M1_LONG }, async t => {
  const x = await setup(t, ["logs"])
  x.world({ burst: { count: 50001, stamp } })
  await x.poll()
  let s = await x.status()
  assert.equal(total(s, "storm"), 50000)
  assert.equal(byTitle(s, "storm")[0].exact, false)
  await x.advance(minute)
  // The first pod replays the saturated interval; the second pod has the only new arrival.
  x.world({ pods: 2, burst: null, lines: [...Array.from({ length: 50001 }, (_, i) =>
    [stamp, "ERROR storm " + i, 0]), [iso(x.now() - 1), "ERROR fresh", 1]] })
  await x.poll()
  s = await x.status()
  assert.equal(total(s, "storm"), 50000)
  assert.equal(total(s, "fresh"), 1)
})

for (const [reading, field, high, low, match] of [
  ["usage", "memory", "490Mi", "256Mi", /memory/],
  ["workloads", "ready", false, true, /not ready/],
]) test("two measured samples open and clear " + reading + " in owner health", async t => {
  const x = await setup(t, [reading])
  const step = value => sample(x, { [field]: value })
  assert.equal(health(await step(high)), "quiet")
  const open = await step(high)
  assert.equal(health(open), "attention")
  assert.equal(open.metrics.find(m => match.test(m.name)).breach, true)
  assert.equal(health(await step(low)), "attention")
  const closed = await step(low)
  assert.equal(closed.metrics.find(m => match.test(m.name)).breach, false)
  assert.equal(health(closed), "quiet")
})

test("a missing memory sample breaks the recovery streak and preserves the last measurement", async t => {
  const x = await setup(t, ["usage"])
  await sample(x, { memory: "490Mi" })
  await sample(x, {})
  const low = await sample(x, { memory: "64Mi" })
  const missing = await sample(x, { emptyUsage: true })
  assert.equal(missing.metrics[0].atMs, low.metrics[0].atMs)
  assert.equal(health(missing), "partial")
  assert.equal((await sample(x, { emptyUsage: false })).metrics[0].breach, true)
  assert.equal((await sample(x, {})).metrics[0].breach, false)
})

test("one measured pod cannot clear a breach while the other pod is unmeasured", async t => {
  const x = await setup(t, ["usage"])
  await sample(x, { pods: 2, memory: "490Mi" })
  await sample(x, {})
  await sample(x, { memory: "64Mi", usagePods: 1 })
  const s = await sample(x, {})
  assert.deepEqual([health(s), s.metrics[0].breach], ["partial", true])
})

test("a Datadog null point cannot become a fresh zero", async t => {
  const x = await rig(t, { both: true })
  const sources = x.cfg.apps.shop.environments.prod.sources
  delete sources.pods
  sources.dd.readings = ["metrics"]
  x.save()
  x.world({ ddValue: null })
  await x.start()
  await x.poll()
  const s = await x.status()
  assert.deepEqual([s.metrics.length, health(s) === "quiet"], [0, false])
})

test("sign-in on a shared cluster costs one failed canary per interval", async t => {
  const x = await rig(t)
  const sources = x.cfg.apps.shop.environments.prod.sources
  sources.other = { ...sources.pods, namespace: "other" }
  x.save()
  x.world({ kubeFailure: "Unauthorized: sign in" })
  await x.start()
  await x.poll()
  const s = await x.status()
  assert.equal(health(s), "signed_out")
  assert.equal(x.calls().filter(c => c.name === "kubectl").length, 1)
})

test("a signed-out owner gets the documented repair in status", async t => {
  const x = await setup(t, ["logs"])
  x.world({ kubeFailure: "Unauthorized: sign in" })
  await x.poll()
  assert.match(JSON.stringify(await x.status()), /kubectl --context lab/)
})

test("reserve falling during a pending Datadog read rolls back the whole slice", async t => {
  const x = await rig(t, { both: true })
  delete x.cfg.apps.shop.environments.prod.sources.pods
  x.save()
  await x.start()
  await x.poll()
  await x.advance(minute)
  x.world({ ddLogs: [{ id: "due", time: iso(x.now() - 1), text: "ERROR reserve" }] })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  x.p.holdDD = { started: entered, promise: release.promise }
  const poll = x.poll()
  try {
    await entered.promise
    await x.control("space", { freeBytes: 256 * 1024 ** 2 - 1, dbBytes: 1024 })
  } finally {
    release.resolve()
    await poll
  }
  const s = await x.status()
  assert.deepEqual([s.paused, s.sources[0].checkpointMs, total(s, "reserve")], ["disk", T, 0])
})

test("Kubernetes EventSeries uses its cumulative count across replay and restart", async t => {
  const x = await setup(t, ["events"])
  const event = count => ({ metadata: { uid: "series-fixture" }, type: "Warning", reason: "BackOff",
    message: "retrying", eventTime: stamp, series: { count, lastObservedTime: iso(x.now() - 1) } })
  x.world({ events: [event(4)] })
  await x.poll()
  await sample(x, {})
  await x.stop()
  await x.start()
  const s = await sample(x, { events: [event(7)] })
  assert.equal(total(s, "backoff"), 7)
})

test("the end of a half-open Kubernetes window belongs to the next slice", async t => {
  const x = await setup(t, ["logs"])
  x.world({ lines: [[iso(T), "ERROR boundary"]] })
  await x.poll()
  const first = total(await x.status(), "boundary")
  const second = total(await sample(x, {}), "boundary")
  assert.deepEqual([first, second], [0, 1])
})

test("inside a second Kubernetes catch-up transaction, SIGKILL exposes only complete slice prefixes", async t => {
  // First measure both transactions through the external trace. A cut near the end of the second
  // leaves the first slice committed. Check before retrying, so replay cannot conceal partial state.
  async function scenario() {
    const x = await setup(t, ["logs"])
    await x.poll()
    await x.advance(12 * hour)
    x.world({ lines: [[iso(T + hour), "ERROR first"], [iso(T + 7 * hour), "ERROR second"]] })
    return x
  }
  const base = await scenario()
  await base.control("trace", { killAfter: null })
  const { writes } = await base.poll()
  assert.ok(writes > 3)
  await base.stop()
  const x = await scenario()
  await x.control("trace", { killAfter: writes - 1 })
  await assert.rejects(x.poll(), /exited/)
  const prefix = await x.json("status")
  assert.deepEqual([prefix.sources[0].checkpointMs, total(prefix, "first"), total(prefix, "second")],
    [T + 6 * hour, 1, 0])
  await x.start()
  await x.advance(minute)
  await x.poll()
  const end = await x.status()
  assert.deepEqual([end.sources[0].checkpointMs, total(end, "first"), total(end, "second")], [x.now(), 1, 1])
})
