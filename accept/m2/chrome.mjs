// Chrome DevTools Protocol over inherited pipes. No browser downloads or shared profile.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import assert from "node:assert/strict"

export const binary = [
  process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(p => p && fs.existsSync(p))

export async function browser(t, x) {
  // The rig tears its own directory down first. Keep Chrome in an independently owned temporary home.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-m2-chrome-"))
  const env = { HOME: root, TMPDIR: root, PATH: x.env.PATH, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root,
    XDG_STATE_HOME: root, XDG_DATA_HOME: root }
  const child = spawn(binary, ["--headless=new", "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
    "--use-mock-keychain", "--password-store=basic", "--no-proxy-server", "--disable-features=HttpsUpgrades",
    "--host-resolver-rules=EXCLUDE 127.0.0.1, EXCLUDE localhost, MAP * ~NOTFOUND", "--remote-debugging-pipe",
    "--user-data-dir=" + path.join(root, "profile"), "about:blank"], {
    env, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  })
  const closed = once(child, "close")
  let logs = "", incoming = "", id = 0, sessionId
  const pending = new Map()
  child.stderr.on("data", b => { logs = (logs + b).slice(-1000) })
  child.stdio[3].on("error", () => {})
  child.stdio[4].setEncoding("utf8").on("data", data => {
    incoming += data
    let nul
    while ((nul = incoming.indexOf("\0")) >= 0) {
      const msg = JSON.parse(incoming.slice(0, nul))
      incoming = incoming.slice(nul + 1)
      if (msg.id) pending.get(msg.id)?.(msg)
    }
  })
  const cmd = (method, params = {}, sid = sessionId) => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(Error(method + " timed out " + logs)) }, 6500)
    pending.set(key, msg => {
      clearTimeout(timer)
      pending.delete(key)
      msg.error ? reject(Error(method + " " + msg.error.message)) : resolve(msg.result)
    })
    child.stdio[3].write(JSON.stringify({ id: key, method, params, sessionId: sid }) + "\0")
  })
  t.after(async () => { child.kill("SIGTERM"); const tm = setTimeout(() => child.kill("SIGKILL"), 2000)
    try { await closed } finally { clearTimeout(tm); fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }) } })
  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" })
  sessionId = (await cmd("Target.attachToTarget", { targetId, flatten: true })).sessionId
  const evaluate = async expression => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description)
    return result.result.value
  }
  const wait = async (expression, message, ms = 5000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    assert.fail(message || expression)
  }
  const visit = async url => {
    await cmd("Page.navigate", { url })
    await wait("location.href===" + JSON.stringify(url) + " && document.readyState!=='loading'", "navigation")
  }
  const key = async key => {
    const named = { Enter: [13, "Enter"], Escape: [27, "Escape"], "/": [191, "Slash"] }
    const [windowsVirtualKeyCode, code] = named[key] ?? [key.toUpperCase().charCodeAt(0), "Key" + key.toUpperCase()]
    const fields = { key, code, windowsVirtualKeyCode }
    const text = key === "Enter" ? "\r" : key.length === 1 ? key : ""
    await cmd("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...fields, text })
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", ...fields })
  }
  return { cmd, evaluate, visit, wait, key, type: text => cmd("Input.insertText", { text }) }
}
