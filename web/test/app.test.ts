/** The page's own transitions, as stories: no browser, no service; each Command is resolved with what it would send. */
import test from "node:test";
import assert from "node:assert/strict";
import { Story } from "@effect/ui/testing";
import { Effect, type Scope } from "effect";
import { freshness } from "../freshness.mjs";
import { Act, AppMessage, AppNoDeps, Undo, WaitBeforeDismissal, WaitBeforeSeen } from "../src/App.ts";
import type { Incident, Snapshot } from "../src/domain/Overwatch.ts";

const at = (ms: number) => ({ wallMs: 1_000_000 + ms, monoMs: 5_000 + ms });
const incident = (id: string, title: string): Incident => ({
  id, title, count: 3, exact: true, severity: "error", app: "shop", environment: "prod", active: true, group: "needsYou",
  decidedSeq: 1, way: null, returned: null, seenSeq: 2, firstSeq: 1, lastSeq: 2, firstMs: 0, lastMs: 0, spark: [],
});
const snapshot = (seq: number, needsYou: ReadonlyArray<string>, incidents: ReadonlyArray<Incident>): Snapshot => ({
  seq, atMs: 1_000_000, environments: [], sources: [], incidents, coverage: [], metrics: [], deploys: [], causes: [],
  inbox: { groups: { needsYou, new: [], working: [], quiet: [] } },
});
const snapshotOf = (seq: number) => snapshot(seq, [], []);
const props = { initialTheme: null, initialCollapsed: { needsYou: false, new: false, working: true, quiet: true }, now: at(0) };
const run = (story: Effect.Effect<void, never, Scope.Scope>): void => Effect.runSync(Effect.scoped(story));

test("rows stay put while the service moves on; r releases what waits", () =>
  run(Effect.gen(function* () {
    const a = incident("a", "first"), b = incident("b", "second"), c = incident("c", "arrival");
    const s = yield* Story.make(AppNoDeps, props);
    s.send(AppMessage.ReceivedSnapshot({ snapshot: snapshot(5, ["a", "b"], [a, b]), at: at(10) }));
    assert.deepEqual(s.model.shown?.needsYou, ["a", "b"]);
    s.send(AppMessage.ReceivedSnapshot({ snapshot: snapshot(6, ["c", "a", "b"], [a, b, c]), at: at(20) }));
    assert.deepEqual(s.model.shown?.needsYou, ["a", "b"], "an arrival waits behind the line");
    s.send(AppMessage.ReceivedSnapshot({ snapshot: snapshot(4, [], []), at: at(30) }));
    assert.equal(s.model.snapshot?.seq, 6, "an older snapshot is ignored");
    s.send(AppMessage.PressedKey({ command: "refresh" }));
    assert.deepEqual(s.model.shown?.needsYou, ["c", "a", "b"]);
  })));

test("done removes the row at once, moves focus to the next and u restores it in place", () =>
  run(Effect.gen(function* () {
    const a = incident("a", "first"), b = incident("b", "second");
    const s = yield* Story.make(AppNoDeps, props);
    s.send(AppMessage.ReceivedSnapshot({ snapshot: snapshot(5, ["a", "b"], [a, b]), at: at(10) }));
    s.send(AppMessage.PressedKey({ command: "next" })).expectExact(WaitBeforeSeen.make({ id: "a" })).keepPending("detail");
    assert.equal(s.model.focus, "a");
    s.send(AppMessage.PressedKey({ command: "done" }))
      .expectExact(WaitBeforeSeen.make({ id: "a" }), Act.make({ id: "a", body: { action: "done" }, basis: 1, before: ["a", "b"] }));
    const decided = { ...snapshot(7, ["b"], [{ ...a, way: { kind: "done", seq: 7 } }, b]), action: { seq: 7 } };
    s.resolve(Act, AppMessage.SucceededAct({ id: "a", before: ["a", "b"], action: "done", decided, at: at(40) })).keepPending("detail");
    assert.deepEqual(s.model.shown?.needsYou, ["b"]);
    assert.equal(s.model.focus, "b");
    assert.equal(s.model.toast.text, "Done: first · u puts it back");
    s.send(AppMessage.PressedKey({ command: "undo" }));
    assert.deepEqual(s.model.actions, []);
    s.resolve(Undo, AppMessage.SucceededUndo({ id: "a", decided: { ...snapshot(8, ["a", "b"], [a, b]), action: { seq: 8 } }, at: at(50) })).keepPending("detail");
    assert.deepEqual(s.model.shown?.needsYou, ["a", "b"]);
    assert.equal(s.model.focus, "a");
    assert.equal(s.model.toast.text, "Put back");
    // The note leaves after its time; a row already seen is not marked again.
    s.resolve(WaitBeforeDismissal, AppMessage.ElapsedToast({ n: 2 })).resolve(WaitBeforeSeen, AppMessage.ElapsedSeenWait({ id: "a" }));
    assert.equal(s.model.toast.shown, false);
  })));

test("the page's own clock ages the connection: live, stale after 15 s, down after 30 s", () =>
  run(Effect.gen(function* () {
    const s = yield* Story.make(AppNoDeps, props);
    const connection = () => freshness(s.model.last, s.model.now);
    assert.equal(connection(), "unknown");
    s.send(AppMessage.ReceivedHeartbeat({ atMs: 1_000_000, at: at(0) }));
    assert.equal(connection(), "live");
    s.send(AppMessage.Ticked({ at: at(15_000) }));
    assert.equal(connection(), "stale");
    s.send(AppMessage.Ticked({ at: at(30_000) }));
    assert.equal(connection(), "down");
    // A status read while the stream is away updates the picture, never liveness.
    s.send(AppMessage.SucceededStatus({ snapshot: { ...snapshotOf(9) }, at: at(31_000) }));
    assert.equal(connection(), "down");
    assert.equal(s.model.snapshot?.seq, 9);
  })));
