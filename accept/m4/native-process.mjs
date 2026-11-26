// Parent the native peer so its lifetime follows the test worker's IPC connection.
import { spawn } from "node:child_process"

const peer = spawn(process.argv[2], process.argv.slice(3), {stdio: "ignore"})
const stop = () => {
  peer.kill("SIGTERM")
  setTimeout(() => peer.kill("SIGKILL"), 1500).unref()
}
process.once("disconnect", stop)
process.once("SIGTERM", stop)
peer.on("error", error => { console.error(error.message); process.exit(1) })
peer.once("close", code => process.exit(code ?? 1))
