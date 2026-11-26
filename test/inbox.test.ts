/** The kernel's ways out: deadlines on the stored-delay shape, return decisions, prompts by request key. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { Store, type Clean } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { act, afterChange, ask, deadlines, detail, inbox, search } from "../src/inbox.ts";

function rig() {
  const dataDir = mkdtempSync(join(tmpdir(), "ow-inbox-test-"));
  const config = parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
  const store = Store.own(dataDir);
  let now = Date.UTC(2026, 10, 1), mono = 1e6;
  clock.set(now, mono);
  store.tx((w) => {
    const seq = w.event("slice", "shop/prod/pods" as Clean, {});
    w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_1', 'shop', 'prod', 'shop/prod/pods', 'ERROR payments', 'error', 1, 1, 0, 0, ?, ?)", seq, seq);
  });
  /** One more occurrence, admitted now. */
  const occur = () => store.tx((w) => {
    const seq = w.event("slice", "shop/prod/pods" as Clean, {});
    w.run("UPDATE incidents SET count = count + 1 WHERE id = 'inc_1'");
    afterChange(w, store, "inc_1", { severity: "error", active: 1 }, 1, seq);
  });
  return {
    store, config, occur,
    move(wall: number, mon: number) {
      now += wall;
      mono += mon;
      clock.set(now, mono);
    },
    way: () => detail(store, config, "inc_1").incident.way?.kind ?? null,
    back: () => detail(store, config, "inc_1").incident.returned?.code ?? null,
  };
}

test("Done's grace is one interval on the service's own admission; a wall clock set back cannot extend it", () => {
  const r = rig();
  act(r.store, r.config, "inc_1", { action: "done" });
  r.move(-3_600_000, 30_000);
  r.occur();
  assert.equal(r.way(), "done", "admitted inside the grace: counted, still put away");
  r.move(0, 30_001);
  r.occur();
  assert.equal(r.back(), "again");
  assert.deepEqual(inbox(r.store).groups.needsYou, ["inc_1"]);
});

test("Later with a time comes back at the delay the owner chose, even with the wall clock set back", () => {
  const r = rig();
  act(r.store, r.config, "inc_1", { action: "later", untilMs: clock.now() + 120_000 });
  r.move(-86_400_000, 119_999);
  deadlines(r.store);
  assert.equal(r.way(), "later");
  r.move(0, 1);
  deadlines(r.store);
  assert.equal(r.back(), "deadline");
  const kinds = detail(r.store, r.config, "inc_1").history.map((e) => e.kind);
  assert.deepEqual(kinds.slice(-2), ["deadline", "returned"], "a durable deadline event, then the return");
});

test("a request key answers the same way forever and refuses a different prompt; continue needs an open job", () => {
  const r = rig();
  const key = "rk_" + "a".repeat(24);
  assert.throws(() => ask(r.store, r.config, { subject: "inc_1", text: "why?", mode: "continue" }, "rk_" + "b".repeat(24)), /no open job/);
  const first = ask(r.store, r.config, { subject: "inc_1", text: "why?", mode: "auto" }, key);
  assert.deepEqual(ask(r.store, r.config, { subject: "inc_1", text: "why?", mode: "auto" }, key), first);
  assert.throws(() => ask(r.store, r.config, { subject: "inc_1", text: "other", mode: "auto" }, key), /different prompt/);
  assert.deepEqual(inbox(r.store).groups.working, ["inc_1"]);
  assert.deepEqual(search(r.store, r.config, "WHY?").items.map((i) => i.id), ["inc_1"]);
  assert.throws(() => ask(r.store, r.config, { subject: "env:shop/nowhere", text: "x", mode: "auto" }, "rk_" + "c".repeat(24)), /unknown subject/);
});

test("undo is fenced: only the current action can be undone, once", () => {
  const r = rig();
  const { seq } = act(r.store, r.config, "inc_1", { action: "never", reason: "noise" });
  act(r.store, r.config, "inc_1", { action: "undo", actionSeq: seq });
  assert.equal(r.way(), null);
  assert.throws(() => act(r.store, r.config, "inc_1", { action: "undo", actionSeq: seq }), /no longer/);
  assert.throws(() => act(r.store, r.config, "inc_1", { action: "later", untilMs: clock.now() + 1, when: "worse" }), /not both/);
});
