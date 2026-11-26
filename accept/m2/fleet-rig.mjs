import assert from "node:assert/strict"
import { stamp } from "../m1/rig.mjs"
import { finished, send, model, until } from "../m3/rig.mjs"

export async function fleet(x) {
  const environments = x.cfg.apps.shop.environments
  const template = structuredClone(environments.prod)
  x.cfg.watchers = []
  const namespaceLines = {}
  for (const [i, environment] of ["prod", "qa", "stage", "test", "load", "canary"].entries()) {
    const e = environments[environment] = structuredClone(template)
    e.sources.pods.namespace = environment
    e.sources.pods.readings = ["logs", "workloads"]
    x.cfg.watchers.push({ app: "shop", environment, every: "1m" })
    namespaceLines[environment] = Array.from({ length: 33 + Number(i < 2) }, (_, j) => {
      const label = String.fromCharCode(97 + Math.floor(j / 26), 97 + j % 26)
      return [stamp, "ERROR worker " + label]
    })
  }
  x.world({ namespaceLines }); x.save(); await x.start(); await x.poll()
  const ids = (await x.status()).incidents.map((i) => i.id)
  const start = (id) => send(x, "items/" + id + "/investigate", {}, 202, id)
  for (const [index, votes] of [
    ["real", "real", "real"],
    ["real", "not_real", "real"],
    ["ramble", "unsure", "not_real"],
    ["not_real", "not_real", "not_real"],
  ].entries()) {
    model(x, votes)
    await finished(x, (await start(ids[index])).jobId)
  }
  x.p.workScript = async () => ""
  const parked = await send(
    x,
    "ask",
    { subject: ids[4], text: "No response fixture", mode: "new" },
    200,
    ids[4],
  )
  assert.equal((await finished(x, parked.jobId)).state, "parked")
  const hold = Promise.withResolvers()
  x.p.workScript = async () => {
    await hold.promise
    return "Fixture complete"
  }
  await start(ids[5])
  await start(ids[6])
  await until(
    x,
    async () => {
      const states = (await x.status()).jobs.map((j) => j.state)
      return ["queued", "running", "completed", "parked"].every((s) => states.includes(s))
    },
    "did not reach all queue states",
  )
  return hold
}
