import assert from "node:assert/strict"
import { rig, iso } from "../m1/rig.mjs"
export async function api(x, path, body, { code = 200, key } = {}) {
  const response = await fetch(x.url + "/v2/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key && { "Idempotency-Key": key }) },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4000),
  })
  assert.equal(response.status, code, path + " HTTP " + response.status)
  return response.json()
}
export const inbox = x => api(x, "inbox")
export const item = (x, id) => api(x, "items/" + encodeURIComponent(id))
export const act = (x, id, body, opts) => api(x, "items/" + encodeURIComponent(id) + "/action", body, opts)
export const ids = g => Object.values(g.groups).flat()
export async function live(t, words = ["ERROR payments"]) {
  const x = await rig(t)
  x.cfg.apps.shop.environments.prod.sources.pods.readings = ["logs", "workloads"]
  x.save()
  x.world({ lines: words.map(w => [iso(x.now() - 1), w]) })
  await x.start()
  await x.poll()
  return x
}
export async function tick(x, words = [], ms = 60000, wall = ms) {
  await x.advance(ms, wall)
  x.world({ lines: [...(x.w().lines ?? []), ...words.map(w => [iso(x.now() - 1), w])] })
  await x.poll()
}
