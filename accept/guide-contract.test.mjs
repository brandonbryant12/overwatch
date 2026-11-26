// Public setup-guide promises, checked separately from the milestone service suites.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { service } from "./m3/rig.mjs"

const guide = fs.readFileSync(new URL("../docs/setup.md", import.meta.url), "utf8")

test("the setup guide's role count agrees with its OpenCode configuration", () => {
  const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)]
  const roles = Object.keys(JSON.parse(examples[1][1]).agents)
  // The guide can also describe the optional fixer separately.
  if (/the three agents are the roles Overwatch runs/i.test(guide)) {
    assert.equal(roles.length, 3, roles.join(", "))
  }
})

test("the guide's exit-code promise matches doctor when the configured fixer is absent", async t => {
  const x = await service(t, {
    configure(x) {
      x.cfg.apps.shop.fixes = {
        remote: "origin", base: "main", paths: ["settings.json"], verify: [["node", "verify.cjs"]],
      }
    },
  })
  const r = await x.cli("doctor", [], { timeout: 40000 })
  const diagnosis = JSON.parse(r.out)
  assert.equal(diagnosis.checks.find(c => c.id === "agent:fixer")?.ok, false)
  if (/exit 4 if any fails/i.test(guide)) {
    assert.equal(r.code, 4, "guide promises exit 4; configured fixer check failed")
  }
})
