import test from "node:test"
import assert from "node:assert/strict"
import fc from "fast-check"
import { rig, T, stamp, total } from "./rig.mjs"

test("health follows every expected reading, including during a hung read", async (t) => {
  const x = await rig(t, { both: true })
  await x.start()
  const health = async () => (await x.status()).environments[0].health
  assert.notEqual(await health(), "quiet")
  await fc.assert(
    fc.asyncProperty(fc.array(fc.boolean(), { minLength: 3, maxLength: 7 }), async (states) => {
      for (const missing of states) {
        await x.advance(60000)
        x.world({ emptyUsage: missing })
        await x.poll()
        if (missing) assert.notEqual(await health(), "quiet")
        else assert.equal(await health(), "quiet")
      }
    }),
    { numRuns: 2, endOnFailure: true },
  )
  // Hang outside the service. A second loopback request must still age health.
  x.world({ emptyUsage: false })
  await x.advance(60000)
  await x.poll()
  assert.equal(await health(), "quiet")
  x.p.holdDD = { ...Promise.withResolvers(), started: Promise.withResolvers() }
  await x.advance(60000)
  const running = x.poll()
  try {
    await Promise.race([
      x.p.holdDD.started.promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error("DD read never started")), 5000)
        timer.unref()
      }),
    ])
    await x.advance(3 * 60000)
    assert.notEqual(await health(), "quiet")
  } finally {
    x.p.holdDD.resolve()
    await running
    x.p.holdDD = null
  }
})
test("sign-in confirmation survives restart, one cause and one wake probe recover the cluster", async (t) => {
  const x = await rig(t, { both: true })
  x.world({ kubeFailure: "Unauthorized: You must be logged in to the server" })
  await x.start()
  await x.poll()
  await x.advance(60000)
  await x.poll()
  const state = await x.status(),
    k = state.sources.find((s) => s.id.endsWith("/pods"))
  assert.equal(k.failure, "signin")
  assert.equal(k.suspended, true)
  assert.equal(state.environments[0].health, "signed_out")
  assert.equal(state.causes.length, 1)
  assert.notEqual(state.causes[0].kind, "offline")
  const count = () => x.calls().filter((c) => c.name === "kubectl").length
  assert.equal(count(), 2)
  await x.stop("SIGKILL")
  await x.start()
  await x.advance(60000)
  await x.poll()
  assert.equal(count(), 2)
  assert.equal((await x.status()).sources.find((s) => s.id === k.id).nextMs, k.nextMs)
  x.world({ kubeFailure: null })
  await x.control("wake")
  await x.advance(5000)
  await x.poll()
  assert.equal((await x.status()).sources.find((s) => s.id === k.id).failure, null)
  assert.equal((await x.status()).causes.length, 0)
})
test("one forbidden reading leaves the sibling logs alive and the environment partial", async (t) => {
  const x = await rig(t)
  x.world({
    usageFailure: "Forbidden: cannot list resource pods.metrics.k8s.io",
    lines: [[stamp, "ERROR sibling"]],
  })
  await x.start()
  await x.poll()
  let s = await x.status()
  assert.equal(total(s, "sibling"), 1)
  assert.notEqual(s.environments[0].health, "quiet")
  await x.advance(60000)
  x.world({ lines: [[new Date(x.now() - 1).toISOString(), "ERROR sibling"]] })
  await x.poll()
  s = await x.status()
  assert.equal(total(s, "sibling"), 2)
  assert.ok(s.coverage.some((c) => c.reading === "usage" && c.state === "failed"))
})
for (const retryAfter of [0, 31])
  test("rate-limit handling, retry-after " + retryAfter + " seconds", async (t) => {
    const x = await rig(t, { both: true })
    await x.start()
    await x.poll()
    const before = (await x.status()).sources.find((s) => s.id.endsWith("/dd")).checkpointMs
    const requests = () => x.p.requests.filter((r) => r.path.endsWith("logs/events/search")).length
    const n = requests()
    x.world({ ddRate: true, retryAfter })
    await x.advance(60000)
    await x.poll()
    const s = await x.status(),
      dd = s.sources.find((c) => c.id.endsWith("/dd"))
    assert.equal(dd.checkpointMs, before)
    assert.equal(dd.failure, "rate")
    assert.ok(dd.nextMs > x.now())
    assert.equal(requests() - n, retryAfter > 30 ? 1 : 3)
    assert.notEqual(s.environments[0].health, "quiet")
    await x.stop("SIGKILL")
    await x.start()
    await x.poll()
    assert.equal(requests() - n, retryAfter > 30 ? 1 : 3)
  })
test("disk reserve pauses at boundary, compaction preserves counts and sequence", async (t) => {
  const x = await rig(t)
  await x.start()
  x.world({ lines: [[stamp, "ERROR retained"]] })
  await x.poll()
  const before = await x.status()
  await x.advance(60000)
  await x.control("space", { freeBytes: 256 * 1024 ** 2 - 1, dbBytes: 2000 })
  await x.poll()
  const paused = await x.status()
  assert.equal(paused.paused, "disk")
  assert.notEqual(paused.environments[0].health, "quiet")
  assert.equal(paused.sources[0].checkpointMs, before.sources[0].checkpointMs)
  await x.control("space", { freeBytes: 1024 ** 3, dbBytes: 1024 ** 3 + 1 })
  await x.poll()
  await x.control("space", { freeBytes: 1024 ** 3, dbBytes: 2000 })
  await x.advance(60000)
  await x.poll()
  const end = await x.status()
  assert.equal(end.paused, null)
  assert.ok(end.seq > before.seq)
  assert.equal(total(end, "retained"), 1)
  await x.stop()
  x.inspect((db) => {
    const row = db.prepare("select data from events where kind='compacted' order by seq desc limit 1").get()
    assert.ok(row)
    assert.ok(Number.isInteger(JSON.parse(row.data).throughSeq))
  })
})
test("snapshot precedes changes and a heartbeat arrives even without business writes", async (t) => {
  const x = await rig(t)
  await x.start()
  const ac = new AbortController(),
    deadline = setTimeout(() => ac.abort(), 12000)
  try {
    const r = await fetch(x.url + "/v2/changes", { signal: ac.signal })
    assert.match(r.headers.get("content-type"), /text\/event-stream/)
    let buffer = "",
      seenSnapshot = false,
      seenChange = false,
      seenBeat = false
    for await (const chunk of r.body) {
      buffer += Buffer.from(chunk).toString().replaceAll("\r", "")
      let cut
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const part = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const event = part.match(/^event:\s*(.+)$/m)?.[1],
          data = part.match(/^data:\s*(.+)$/m)?.[1]
        if (!event || !data) continue
        const v = JSON.parse(data)
        if (!seenSnapshot) {
          assert.equal(event, "snapshot")
          seenSnapshot = true
          x.world({ lines: [[stamp, "ERROR streamed"]] })
          await x.poll()
          await x.advance(5000)
        } else if (event === "change" && total(v, "streamed") === 1) seenChange = true
        else if (event === "heartbeat") {
          assert.ok(v.atMs >= T && Number.isInteger(v.seq))
          seenBeat = true
        }
      }
      if (seenChange && seenBeat) break
    }
    assert.ok(seenSnapshot && seenChange && seenBeat)
  } finally {
    clearTimeout(deadline)
    ac.abort()
  }
})

test("simultaneous unreachable sources share one cause; a successful sibling splits it and slow probes recover", async (t) => {
  const x = await rig(t, { both: true })
  await x.start()
  await x.poll()
  x.world({ kubeFailure: "Unable to connect to the server: dial tcp: i/o timeout", ddFailure: 503 })
  for (const step of [60000, 60000, 120000]) {
    await x.advance(step)
    await x.poll()
  }
  let s = await x.status()
  assert.ok(
    s.sources.every((src) => src.suspended),
    "third ordinary failure suspended each source",
  )
  assert.equal(s.causes.length, 1)
  assert.equal(s.causes[0].kind, "offline")
  assert.equal(new Set(s.causes[0].sources).size, 2)
  assert.notEqual(s.environments[0].health, "quiet")
  x.world({ ddFailure: null })
  await x.advance(300000)
  await x.poll()
  s = await x.status()
  assert.equal(s.causes.length, 1)
  assert.notEqual(s.causes[0].kind, "offline")
  x.world({ kubeFailure: null })
  await x.advance(300000)
  await x.poll()
  s = await x.status()
  assert.equal(s.causes.length, 0)
  assert.equal(s.environments[0].health, "quiet")
})
