import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { scenario, ledger, refs } from "./rig.mjs"

test("absence of the macOS isolation runner after calibration prevents publication", async t => {
  const { x, end } = await scenario(t, {
    beforeStart(x) {
      // Fault only the OS capability probe in this fixture. Keep the actual system binary intact.
      const preload = x.dir("missing-runner.cjs")
      fs.writeFileSync(preload, [
        'const fs = require("node:fs")',
        'const exists = fs.existsSync',
        'const flag = require("node:path").join(process.env.OW_FIXTURE, "runner-unavailable")',
        'fs.existsSync = p => p === "/usr/bin/sandbox-exec" && exists(flag) ? false : exists(p)',
        'require("node:module").syncBuiltinESMExports()',
      ].join("\n"))
      x.env.NODE_OPTIONS = "--require=" + JSON.stringify(preload)
    },
    afterFinding(x) {
      fs.writeFileSync(x.dir("runner-unavailable"), "")
    },
  })
  assert.equal(end.state, "verify_failed", end.reason)
  assert.match(end.verification[0].summary, /no isolation|sandbox-exec.*required/i)
  assert.equal(end.verification[0].exitCode, null)
  assert.deepEqual(ledger(x), [])
  assert.equal(refs(x), "refs/heads/main " + x.tip)
})

test("the service stays inside the ratified 5500 source-line budget", t => {
  const src = fileURLToPath(new URL("../../src", import.meta.url))
  const files = fs.readdirSync(src, { recursive: true }).filter(name => /\.[cm]?[tj]s$/.test(name))
  assert.ok(files.length)
  const lines = files.reduce((total, name) => {
    const source = fs.readFileSync(path.join(src, name), "utf8").split(/\r?\n/)
    return total + source.filter(line => !/^\s*(?:$|\/\/|\/\*|\*)/.test(line)).length
  }, 0)
  t.diagnostic(lines + " service lines in " + files.length + " source files")
  assert.ok(lines <= 5500, lines + " service lines exceed 5500")
})
