import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKubectl, parseEvents, parsePods, parseRevision, parseTop } from "../src/kube.ts";
import { Store, json, type Clean } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { clock } from "../src/clock.ts";

test("kubectl runs only the listed verbs, resources, flags and value shapes", () => {
  assert.doesNotThrow(() => checkKubectl("get", ["pods", "-l", "app=shop", "-o", "json"]));
  assert.doesNotThrow(() => checkKubectl("logs", ["shop-000", "-c", "api", "--timestamps", "--since-time=2026-01-20T12:00:00.000Z", "--previous"]));
  for (const [verb, args] of [
    ["delete", ["pods", "shop-000"]],
    ["get", ["secrets"]],
    ["get", ["pods", "-o", "yaml"]],
    ["get", ["pods", "--kubeconfig=/tmp/x"]],
    ["logs", ["--follow", "shop-000"]],
    ["exec", ["shop-000"]],
    ["top", ["node"]],
  ] as const)
    assert.throws(() => checkKubectl(verb, args), `${verb} ${args.join(" ")}`);
});

test("pods come back in UID order with each container's current and previous instance; revision and usage parse", () => {
  const pod = (uid: string, restart: number) => ({
    metadata: { name: `p-${uid}`, uid },
    spec: { containers: [{ name: "api", resources: { limits: { memory: "512Mi" } } }] },
    status: { containerStatuses: [{ name: "api", containerID: `c-${restart}`, lastState: restart ? { terminated: { containerID: `c-${restart - 1}` } } : {} }] },
  });
  const pods = parsePods(JSON.stringify({ items: [pod("b", 1), pod("a", 0)] }));
  assert.deepEqual(pods.map((p) => p.uid), ["a", "b"]);
  assert.deepEqual(pods[1]!.containers[0]!.instances, [{ id: "c-0", previous: true }, { id: "c-1", previous: false }]);
  assert.equal(pods[0]!.containers[0]!.memoryLimit, 512 * 1024 ** 2);
  assert.equal(parseRevision(JSON.stringify({ items: [{ spec: { template: { metadata: { annotations: { "overwatch.dev/revision": "abc1234" } } } } }] })), "abc1234");
  assert.equal(parseRevision(JSON.stringify({ items: [{ spec: { template: { spec: { containers: [{ image: "shop:0f1e2d3c" }] } } } }] })), "0f1e2d3c");
  assert.deepEqual(parseTop("p-a api 100m 64Mi\n"), [{ pod: "p-a", container: "api", memory: 64 * 1024 ** 2 }]);
  assert.deepEqual(parseTop("p-a api 100m lots\n"), [], "an unreadable quantity is not a measurement");
});

test("an event series counts by its cumulative series count; an event without a time has none", () => {
  const event = (extra: object) => JSON.stringify({ items: [{ metadata: { uid: "u" }, type: "Warning", reason: "BackOff", message: "retrying", count: 1, ...extra }] });
  assert.equal(parseEvents(event({ series: { count: 7 } }))[0]!.count, 7);
  assert.equal(parseEvents(event({ count: "3" }))[0]!.count, 3);
  assert.equal(parseEvents(event({ count: null }))[0]!.count, 1);
  assert.equal(parseEvents(event({}))[0]!.at, null);
});

test("a filing cites only handles delivered to its own attempt, and one valid filing closes the attempt", async () => {
  const store = Store.own(mkdtempSync(join(tmpdir(), "ow-tools-")));
  const tools = new Tools(store);
  const code = { expected: null, read: null, deployed: false };
  for (const [run, session] of [["run_aaaaaaaa", "ses_aaaaaaaa"], ["run_bbbbbbbb", "ses_bbbbbbbb"]] as const) {
    store.tx((w) => {
      w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq) VALUES (?, 'trial', 'x', 'x', 'running', 1)", `job_${run}` as Clean);
      w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms) VALUES (?, ?, 1, ?, 'active', 0, ?, 0)", run as Clean, `job_${run}` as Clean, session as Clean, json(code));
    });
    tools.contexts.set(run, { telemetry: { pods: [{ at: 0, text: "ERROR payments timeout" }] }, repo: null, deadline: clock.mono() + 300_000 });
  }
  const a = (await tools.call("ses_aaaaaaaa", "ow_telemetry", { source: "pods" })) as { pieces: Array<{ handle: string }> };
  const b = (await tools.call("ses_bbbbbbbb", "ow_telemetry", { source: "pods" })) as { pieces: Array<{ handle: string }> };
  const filing = (handles: string[], extra: Record<string, unknown> = {}) => ({
    verdict: "real", cause: "c", claims: [{ statement: "s", evidence: handles, ...extra }], ruled_out: [], not_checked: [], next_check: "n", impact: "i", affected: [], since: null, status: "s",
  });
  await assert.rejects(tools.call("ses_aaaaaaaa", "ow_finding", filing([b.pieces[0]!.handle])), /not delivered/);
  await assert.rejects(tools.call("ses_aaaaaaaa", "ow_finding", filing([a.pieces[0]!.handle, b.pieces[0]!.handle])), /not delivered/);
  await assert.rejects(tools.call("ses_aaaaaaaa", "ow_finding", filing([])), /at least one/);
  await assert.rejects(tools.call("ses_aaaaaaaa", "ow_finding", filing([a.pieces[0]!.handle], { quote: "made up" })), /statement and evidence/);
  await assert.rejects(tools.call("ses_unknown", "ow_finding", filing([a.pieces[0]!.handle])), /no active/);
  const filed = (await tools.call("ses_aaaaaaaa", "ow_finding", filing([a.pieces[0]!.handle]))) as { claims: Array<{ pieces: unknown[] }> };
  assert.deepEqual(filed.claims[0]!.pieces, [a.pieces[0]]);
  await assert.rejects(tools.call("ses_aaaaaaaa", "ow_finding", filing([a.pieces[0]!.handle])), /no active/);
  store.close();
});
