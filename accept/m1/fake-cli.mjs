import fs from "node:fs"
import path from "node:path"
const [name, ...args] = process.argv.slice(2)
const root = process.env.OW_FIXTURE
const state = JSON.parse(fs.readFileSync(path.join(root, "world.json")))
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ name, args }) + "\n")
const fail = (text) => {
  console.error(text)
  process.exit(1)
}
const json = (value) => console.log(JSON.stringify(value))
if (state.failTool === name) fail("fixture unavailable " + name)
if (name === "gh") {
  console.log(args.includes("--version") ? "gh version 2.80.0" : "Logged in to fixture")
  process.exit(0)
}
if (name === "opencode") {
  console.log("2.4.1")
  process.exit(0)
}
if (name === "launchctl") {
  if (!["print", "getenv"].includes(args[0])) fail("fixture supports inspection only")
  if (args[0] === "getenv") console.log(process.env.HTTPS_PROXY)
  else
    console.log(
      "state = running\nprogram = " +
        process.env.OW_BIN +
        "\nenvironment = {\n PATH => " +
        process.env.PATH +
        "\n HTTPS_PROXY => " +
        process.env.HTTPS_PROXY +
        "\n}",
    )
  process.exit(0)
}
if (name !== "kubectl") fail("unexpected executable " + name)
const i = args.findIndex((a) => ["version", "config", "get", "logs", "top", "describe", "auth"].includes(a))
const [verb, res] = args.slice(i)
if (state.kubeFailure) fail(state.kubeFailure)
const option = (n) =>
  args.find((a) => a.startsWith(n + "="))?.slice(n.length + 1) ?? args[args.indexOf(n) + 1]
const pods = Array.from({ length: state.pods ?? 1 }, (_, i) => {
  const id = String(i).padStart(3, "0"),
    restart = state.restart ?? 0
  return {
    metadata: {
      name: "shop-" + id,
      uid: (state.podUIDPrefix ?? "uid-") + id,
      namespace: "shop",
      labels: { app: "shop" },
    },
    spec: {
      containers: [
        {
          name: "api",
          image: "shop:" + state.revision,
          resources: { limits: { cpu: "1", memory: "512Mi" } },
        },
      ],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: state.ready === false ? "False" : "True" }],
      containerStatuses: [
        {
          name: "api",
          ready: true,
          restartCount: restart,
          containerID: state.missingIdentity ? undefined : "containerd://" + id + "-" + restart,
          lastState: restart
            ? { terminated: { containerID: "containerd://" + id + "-" + (restart - 1), exitCode: 0 } }
            : {},
          state: { running: { startedAt: "2020-01-01T00:00:00Z" } },
        },
      ],
    },
  }
})
if (verb === "version") json({ clientVersion: { gitVersion: "v1.32.0" } })
else if (verb === "auth") console.log("yes")
else if (verb === "config") console.log("lab")
else if (verb === "get" && /^po(ds?)?$/.test(res)) json({ items: pods })
else if (verb === "get" && res.startsWith("deploy"))
  json({
    items: [
      {
        metadata: { name: "shop", uid: "deployment" },
        spec: {
          replicas: 1,
          template: {
            metadata: { annotations: { "overwatch.dev/revision": state.revision } },
            spec: pods[0]?.spec,
          },
        },
        status: { readyReplicas: 1, availableReplicas: 1 },
      },
    ],
  })
else if (verb === "get" && res.startsWith("event")) json({ items: state.events ?? [] })
else if (verb === "get") json({ items: [] })
else if (verb === "top") {
  if (state.usageFailure) fail(state.usageFailure)
  if (!state.emptyUsage) console.log(pods.slice(0, state.usagePods ?? pods.length)
    .map((p) => p.metadata.name + " api 100m " + (state.memory ?? "64Mi")).join("\n"))
} else if (verb === "logs") {
  const idx = Number(res.match(/(\d+)$/)?.[1] ?? 0),
    from = Date.parse(option("--since-time")) || 0
  const emit = (stamp, text) => {
    if (Date.parse(stamp) >= from) fs.writeSync(1, stamp + " " + text + "\n")
  }
  if (state.failSince === from) fail("network unreachable")
  if (state.restartDuringLogs) {
    fs.writeFileSync(path.join(root, "world.json"), JSON.stringify({ ...state, restartDuringLogs: false, restart: (state.restart ?? 0) + 1 }))
  }
  const previous = args.includes("--previous") || args.includes("-p")
  for (const [stamp, text, pod = 0] of (previous ? state.previous : state.lines) ?? [])
    if (pod === idx) emit(stamp, text)
  if (!previous && state.burst) {
    const { count, stamp, distinct } = state.burst
    const word = (n) =>
      String.fromCharCode(97 + (Math.floor(n / 676) % 26), 97 + (Math.floor(n / 26) % 26), 97 + (n % 26))
    for (let n = idx; n < count; n += pods.length)
      emit(stamp, "ERROR " + (distinct ? word(n) : "storm") + " " + n)
  }
  if (state.tail && idx === 0) fs.writeSync(1, state.tail)
} else if (verb === "describe") console.log("Ready True")
else fail("unsupported fixture verb " + args.join(" "))
