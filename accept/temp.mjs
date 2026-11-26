import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"

let workspace

// A worker killed by SIGKILL cannot run its test hooks. Give a detached helper the
// read end of a private pipe before creating any files. The kernel closes the other
// end when the worker exits. Only the directory belonging to that worker is removed.
export function fixtureTemp(prefix) {
  if (!workspace) {
    const root = path.join(os.tmpdir(), "owa-" + randomBytes(10).toString("hex"))
    const cleanup = spawn("/bin/sh", ["-c", '/bin/cat >/dev/null; /bin/rm -rf -- "$1"', "cleanup", root], {
      detached: true, stdio: ["pipe", "ignore", "ignore"],
    })
    cleanup.unref()
    cleanup.stdin.unref()
    fs.mkdirSync(root, {mode: 0o700})
    workspace = {root, cleanup}
    process.once("exit", () => {
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 4})
      cleanup.stdin.destroy()
    })
  }
  return fs.mkdtempSync(path.join(workspace.root, prefix))
}
