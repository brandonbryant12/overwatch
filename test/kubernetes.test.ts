import { scratch } from "./scratch.ts";
/**
 * The Kubernetes reader against a fake kubectl: identity around each log read, observed loss, catch-up in slices,
 * and problems from gauges with hysteresis.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector, hysteresis, METRIC_RULES } from "../src/collect.ts";
import { LIMITS, parseConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { sample, UNMEASURED } from "../src/parse.ts";
import { snapshot } from "../src/snapshot.ts";
import { clock } from "../src/clock.ts";

const HOUR = 3_600_000;
const bin = scratch("ow-fake-kubectl-");
const world = join(bin, "world.json");
const calls = join(bin, "calls.jsonl");
// A kubectl that answers from world.json: `listings` are the pod lists returned in turn (the last one repeats),
// `logs` the lines of each container instance by its ID; `memory` in MiB against a 512 MiB limit.
writeFileSync(
  join(bin, "kubectl"),
  `#!${process.execPath}
const fs = require("node:fs");
const w = JSON.parse(fs.readFileSync(${JSON.stringify(world)}, "utf8"));
const args = process.argv.slice(6), verb = process.argv[6];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const counter = ${JSON.stringify(join(bin, "listed"))};
const listed = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
const listing = (n) => w.listings[Math.min(n, w.listings.length - 1)];
if (verb === "get" && args[1] === "pods") {
  if (w.unauthorized) { console.error("error: You must be logged in to the server (Unauthorized)"); process.exit(1); }
  fs.writeFileSync(counter, String(listed + 1));
  console.log(JSON.stringify({ items: listing(listed) }));
} else if (verb === "get") console.log(JSON.stringify({ items: [] }));
else if (verb === "top") {
  if (w.memory === null) { console.error("Forbidden: cannot list resource pods.metrics.k8s.io"); process.exit(1); }
  console.log(listing(listed - 1).slice(0, w.topPods ?? 99).map((p) => p.metadata.name + " api 1m " + w.memory + "Mi").join("\\n"));
} else if (verb === "logs") {
  if (w.failLogs && w.failLogs.includes(fs.readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n").filter((l) => l.includes('"logs"')).length)) { console.error("dial tcp: connection refused"); process.exit(1); }
  const pod = listing(listed - 1).find((p) => p.metadata.name === args[1]);
  const status = pod.status.containerStatuses.find((c) => c.name === args[3]);
  const previous = args.includes("--previous");
  const id = previous ? status.lastState?.terminated?.containerID : status.containerID;
  if (!id || !w.logs[id]) { console.error('previous terminated container "api" in pod "' + args[1] + '" not found'); process.exit(1); }
  const since = Date.parse(args.find((a) => a.startsWith("--since-time=")).slice(13));
  for (const [stamp, text] of w.logs[id]) if (!(Date.parse(stamp) < since)) console.log(stamp + " " + text);
} else { console.error("unsupported " + args.join(" ")); process.exit(1); }
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;

type Container = { current: string; previous?: string; restarts?: number };
const pod = (name: string, uid: string, c: Container, ready = true) => ({
  metadata: { name, uid },
  spec: { containers: [{ name: "api", resources: { limits: { memory: "512Mi" } } }] },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
    containerStatuses: [{ name: "api", restartCount: c.restarts ?? (c.previous ? 1 : 0), containerID: c.current, lastState: c.previous ? { terminated: { containerID: c.previous } } : {} }],
  },
});
type World = { listings: unknown[][]; logs: Record<string, Array<[string, string]>>; memory?: number | null; failLogs?: number[]; unauthorized?: boolean; topPods?: number };
const set = (w: World) => {
  writeFileSync(world, JSON.stringify({ memory: 10, ...w }));
  writeFileSync(join(bin, "listed"), "0");
  writeFileSync(calls, "");
};
const at = (ms: number) => new Date(ms).toISOString().replace("Z", "000000Z");

function rig(readings: string[] = ["logs"], namespaces = ["shop"]) {
  const dataDir = scratch("ow-kube-test-");
  const sources = Object.fromEntries(namespaces.map((namespace, i) => [i ? `pods${i}` : "pods", { type: "kubernetes", context: "lab", namespace, selector: "app=shop", readings }]));
  const config = parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
  const store = Store.own(dataDir);
  let collector = new Collector(store, config, dataDir);
  collector.setSpace({ freeBytes: 1024 ** 4, dbBytes: 0 });
  let now = Date.UTC(2026, 10, 1), mono = 1_000_000;
  clock.set(now, mono);
  return {
    store,
    config,
    pass: () => collector.pass(),
    /** A new process: what was only in memory is gone. */
    restart() {
      collector = new Collector(store, config, dataDir);
      collector.setSpace({ freeBytes: 1024 ** 4, dbBytes: 0 });
    },
    setWall(ms: number) {
      now = ms;
      clock.set(now, mono);
    },
    health: () => snapshot(store, config, collector, true).environments[0]!.health,
    advance(ms: number) {
      now += ms;
      mono += ms;
      clock.set(now, mono);
    },
    get now() {
      return now;
    },
    count: () => x(store),
    logs: () => store.get<{ state: string }>("SELECT state FROM readings WHERE source = 'shop/prod/pods' AND reading = 'logs'")?.state,
    checkpoint: () => store.get<{ c: number }>("SELECT checkpoint_ms AS c FROM sources")?.c,
    close: () => store.close(),
  };
}
const x = (store: Store) => store.get<{ n: number }>("SELECT coalesce(sum(count), 0) AS n FROM incidents")!.n;
const logCalls = () => readFileSync(calls, "utf8").split("\n").filter((l) => l.includes('"logs"')).map((l) => JSON.parse(l) as string[]);

test("a container restarted during its log read is discarded as a gap, then counted once from the next read", async () => {
  const r = rig();
  const before = pod("shop-a", "uid-a", { current: "c-1" });
  const after = pod("shop-a", "uid-a", { current: "c-2", previous: "c-1" });
  set({ listings: [[before], [after]], logs: { "c-1": [[at(r.now - 30_000), "ERROR payment failed"]], "c-2": [] } });
  await r.pass();
  assert.equal(r.logs(), "gap");
  assert.equal(r.count(), 0);
  r.advance(60_000);
  await r.pass();
  assert.equal(r.logs(), "ok");
  assert.equal(r.count(), 1);
  r.advance(60_000);
  await r.pass();
  assert.equal(r.count(), 1);
  r.close();
});

test("a pod gone after its read cannot be established and is a gap", async () => {
  const r = rig();
  set({ listings: [[pod("shop-a", "uid-a", { current: "c-1" })], []], logs: { "c-1": [[at(r.now - 30_000), "ERROR payment failed"]] } });
  await r.pass();
  assert.equal(r.logs(), "gap");
  assert.equal(r.count(), 0);
  r.close();
});

test("lines counted before and no longer returned (rotation, a shorter same-time run) are a gap, never a recount", async () => {
  const r = rig();
  const p = pod("shop-a", "uid-a", { current: "c-1" });
  const t = at(r.now - 30_000), t2 = at(r.now - 20_000);
  set({ listings: [[p]], logs: { "c-1": [[t, "ERROR same"], [t, "ERROR same"], [t, "ERROR same"], [t2, "ERROR other"]] } });
  await r.pass();
  assert.equal(r.logs(), "ok");
  assert.equal(r.count(), 4);
  r.advance(60_000);
  set({ listings: [[p]], logs: { "c-1": [[t, "ERROR same"], [t, "ERROR same"], [t2, "ERROR other"]] } });
  await r.pass();
  assert.equal(r.logs(), "gap", "one of three identical lines vanished");
  assert.equal(r.count(), 4);
  r.advance(60_000);
  set({ listings: [[p]], logs: { "c-1": [[at(r.now - 10_000), "ERROR later"]] } });
  await r.pass();
  assert.equal(r.logs(), "gap", "the earlier lines were rotated away inside the overlap");
  assert.equal(r.count(), 5);
  r.advance(5 * 60_000);
  await r.pass();
  assert.equal(r.logs(), "ok", "outside the overlap nothing is expected any more");
  r.close();
});

test("a restarted container with no previous instance to read is a lower bound", async () => {
  const r = rig();
  set({ listings: [[pod("shop-a", "uid-a", { current: "c-2", restarts: 1 })]], logs: { "c-2": [] } });
  await r.pass();
  assert.equal(r.logs(), "gap");
  set({ listings: [[pod("shop-a", "uid-a", { current: "c-2", previous: "c-1" })]], logs: { "c-2": [] } });
  r.advance(60_000);
  await r.pass();
  assert.equal(r.logs(), "gap", "the previous instance is named but its logs are gone");
  r.close();
});

test("catch-up reads six-hour slices, commits each with its checkpoint, and resumes at the next slice after a failure", async () => {
  const r = rig();
  const p = pod("shop-a", "uid-a", { current: "c-1" });
  set({ listings: [[p]], logs: { "c-1": [] } });
  await r.pass();
  const start = r.checkpoint()!;
  // Asleep for two days: one error every hour, the last 20 minutes before waking.
  const lines: Array<[string, string]> = [];
  for (let h = 1; h <= 48; h++) lines.push([at(start + h * HOUR - 20 * 60_000), `ERROR hourly ${h}`]);
  r.advance(48 * HOUR);
  set({ listings: [[p]], logs: { "c-1": lines }, failLogs: [4] });
  await r.pass();
  assert.equal(r.checkpoint(), start + 3 * LIMITS.sliceMs, "three slices committed before the fourth failed");
  assert.equal(r.count(), 18);
  const failed = logCalls();
  assert.equal(failed.length, 4);
  failed.forEach((args, i) => assert.equal(args.find((a) => a.startsWith("--since-time="))!.slice(13), new Date(start + i * LIMITS.sliceMs - LIMITS.overlapMs.kubernetes).toISOString()));
  r.advance(60_000);
  set({ listings: [[p]], logs: { "c-1": lines } });
  await r.pass();
  assert.equal(r.checkpoint(), r.now);
  assert.equal(r.count(), 48, "every line counted exactly once across slices and the retry");
  assert.equal(logCalls().length, 6, "resumed at the fourth slice: four, five, six, seven, eight and the minute after");
  assert.equal(r.logs(), "ok");
  r.close();
});

test("memory over its limit opens one problem after two samples; an unmeasured sample never clears it", async () => {
  const r = rig(["logs", "usage"]);
  const p = pod("shop-a", "uid-a", { current: "c-1" });
  const breach = () => r.store.get<{ breach: number }>("SELECT breach FROM metrics WHERE name LIKE 'memory%'")!.breach;
  const step = async (memory: number | null) => {
    set({ listings: [[p]], logs: { "c-1": [] }, memory });
    r.advance(60_000);
    await r.pass();
  };
  for (const m of [490, 256, 490]) await step(m);
  assert.equal(r.count(), 0, "one sample over, then under, then one over: no problem");
  await step(490);
  assert.equal(r.count(), 1);
  assert.equal(breach(), 1);
  await step(490);
  await step(null);
  await step(256);
  await step(null);
  await step(256);
  assert.equal(breach(), 1, "unmeasured samples break the run under the limit");
  await step(256);
  assert.equal(breach(), 0);
  assert.equal(r.count(), 1);
  await step(490);
  await step(490);
  assert.equal(r.count(), 2, "a new breach after a clear is counted again");
  r.close();
});

test("pods not ready open a problem after two samples", async () => {
  const r = rig(["logs", "workloads"]);
  for (const ready of [false, false, false]) {
    set({ listings: [[pod("shop-a", "uid-a", { current: "c-1" }, ready)]], logs: { "c-1": [] } });
    r.advance(60_000);
    await r.pass();
  }
  assert.equal(r.count(), 1);
  assert.equal(r.store.get<{ value: number }>("SELECT value FROM metrics WHERE name = 'pods not ready'")!.value, 1);
  r.close();
});

test("hysteresis agrees with the kept rule: open after n measured samples over in a row, close after n under", () => {
  const rule = METRIC_RULES[0]!;
  fc.assert(
    fc.property(fc.array(fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }), { maxLength: 40 }), (samples) => {
      let state = { over: 0, under: 0, breach: false };
      let open = false;
      samples.forEach((value, i) => {
        state = hysteresis(rule, state, value === null ? UNMEASURED : sample(value));
        // The trailing run of measured samples on one side of the limit, as the earlier detection computed it.
        const tail = samples.slice(Math.max(0, i - rule.samples + 1), i + 1);
        const full = tail.length === rule.samples && tail.every((v) => v !== null);
        if (full && tail.every((v) => v! > rule.over)) open = true;
        else if (full && tail.every((v) => v! <= rule.over)) open = false;
        assert.equal(state.breach, open);
      });
    }),
    { numRuns: 300 },
  );
});

test("a refused sign-in on a shared cluster costs one call per interval, for every source on it", async () => {
  const r = rig(["logs"], ["shop", "other"]);
  set({ listings: [[]], logs: {}, unauthorized: true });
  await r.pass();
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.deepEqual(r.store.all<{ failure: string }>("SELECT failure FROM sources ORDER BY id").map((s) => s.failure), ["signin", "signin"]);
  assert.equal(r.health(), "signed_out");
  r.close();
});

test("after a restart with the wall clock set back, a failing source is probed within its own delay", async () => {
  const r = rig();
  set({ listings: [[]], logs: {}, unauthorized: true });
  await r.pass();
  r.restart();
  r.setWall(r.now - HOUR);
  set({ listings: [[pod("shop-a", "uid-a", { current: "c-1" })]], logs: { "c-1": [] } });
  await r.pass();
  assert.equal(readFileSync(calls, "utf8").trim(), "", "not due yet");
  r.advance(60_000);
  await r.pass();
  assert.equal(r.store.get<{ failure: string | null }>("SELECT failure FROM sources")!.failure, null);
  r.close();
});

test("memory measured for one pod of two is not measured: it neither clears nor confirms a breach", async () => {
  const r = rig(["usage"]);
  const pods = [pod("shop-a", "uid-a", { current: "c-1" }), pod("shop-b", "uid-b", { current: "c-2" })];
  const step = async (memory: number, topPods?: number) => {
    set({ listings: [pods], logs: {}, memory, ...(topPods ? { topPods } : {}) });
    r.advance(60_000);
    await r.pass();
  };
  await step(490);
  await step(490);
  assert.equal(r.health(), "attention");
  await step(64, 1);
  await step(64, 1);
  assert.equal(r.store.get<{ breach: number }>("SELECT breach FROM metrics")!.breach, 1);
  assert.equal(r.health(), "partial");
  await step(64);
  await step(64);
  assert.equal(r.health(), "quiet", "two fully measured samples under the limit clear it");
  r.close();
});

test("a log problem goes quiet after three fully measured intervals with nothing new; an unmeasured one starts the count again", async () => {
  const r = rig();
  const p = pod("shop-a", "uid-a", { current: "c-1" });
  set({ listings: [[p]], logs: { "c-1": [[at(r.now - 10_000), "ERROR payment failed"]] } });
  await r.pass();
  assert.equal(r.health(), "attention");
  const step = async (listing = p) => {
    set({ listings: [[listing]], logs: { "c-1": [], "c-2": [] } });
    r.advance(60_000);
    await r.pass();
  };
  await step();
  await step();
  await step(pod("shop-a", "uid-a", { current: "c-1", restarts: 1 })); // restarted, previous unreadable: a gap
  assert.equal(r.health(), "partial");
  await step();
  await step();
  assert.equal(r.health(), "attention", "the gap restarted the count");
  await step();
  assert.equal(r.health(), "quiet");
  const i = r.store.get<{ count: number; exact: number; active: number }>("SELECT count, exact, active FROM incidents")!;
  assert.deepEqual([i.count, i.exact, i.active], [1, 0, 0], "the gap made the total a lower bound; quiet keeps it");
  r.close();
});

test("a running container without an instance cannot be read, and is a gap", async () => {
  const r = rig();
  set({ listings: [[pod("shop-a", "uid-a", { current: "" })]], logs: {} });
  await r.pass();
  assert.equal(r.logs(), "gap");
  r.close();
});

test("class: any sequence of measured, unmeasured and failed passes moves a gauge exactly as the kept rule says", async () => {
  const rule = METRIC_RULES[0]!;
  await fc.assert(
    fc.asyncProperty(fc.array(fc.constantFrom<number | "fail" | null>(490, 64, null, "fail"), { minLength: 1, maxLength: 7 }), async (steps) => {
      const r = rig(["usage"]);
      const p = pod("shop-a", "uid-a", { current: "c-1" });
      let model = { over: 0, under: 0, breach: false };
      for (const s of steps) {
        set({ listings: [[p]], logs: {}, memory: s === "fail" ? 1 : s, ...(s === "fail" ? { unauthorized: true } : {}) });
        r.advance(60_000);
        r.restart(); // each pass as if fresh: no in-memory schedule hides a failure
        await r.pass();
        // A failed pass and an unmeasured sample are the same thing to the rule: not measured.
        model = hysteresis(rule, model, typeof s === "number" ? sample((100 * s) / 512) : UNMEASURED);
        const row = r.store.get<{ breach: number }>("SELECT breach FROM metrics");
        assert.equal(Boolean(row?.breach), model.breach, JSON.stringify(steps));
      }
      r.close();
    }),
    { numRuns: 12 },
  );
});

test("a log line without a readable time is a gap and makes the active total a lower bound", async () => {
  const r = rig();
  const p = pod("shop-a", "uid-a", { current: "c-1" });
  const t = at(r.now - 10_000);
  set({ listings: [[p]], logs: { "c-1": [[t, "ERROR checkout"]] } });
  await r.pass();
  r.advance(60_000);
  set({ listings: [[p]], logs: { "c-1": [[t, "ERROR checkout"], ["not-a-time", "ERROR checkout"]] } });
  await r.pass();
  assert.equal(r.logs(), "gap");
  assert.equal(r.store.get<{ exact: number }>("SELECT exact FROM incidents")!.exact, 0);
  r.close();
});
