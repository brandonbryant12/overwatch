// Stay alive with the peer's scratch lease until it has stopped writing.
// The worker controls peers through IPC. Chrome's CDP pipes go straight through.
import { spawn } from "node:child_process"

const [transport, executable, ...args] = process.argv.slice(2)
const stdio = transport === "cdp" ? ["ignore", "ignore", 2, 3, 4] : "ignore"
const peer = spawn(executable, args, { stdio })
const stop = () => {
  peer.kill("SIGTERM")
  setTimeout(() => peer.kill("SIGKILL"), 1500).unref()
}
process.once("disconnect", stop)
process.once("SIGTERM", stop)
peer.once("error", error => { console.error(error.message); process.exitCode = 1 })
peer.once("spawn", () => {
  if (transport === "cdp" && process.connected) process.send(peer.pid, error => { if (error) stop() })
})
peer.once("close", code => process.exit(code ?? 1))
