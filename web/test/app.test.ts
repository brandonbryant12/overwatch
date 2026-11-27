/** The page's own transitions, as stories: no browser, no service; each Command is resolved with what it would send. */
import test from "node:test";
import assert from "node:assert/strict";
import { Story } from "foldkit";
import { freshness } from "../freshness.mjs";
import { Act, AppMessage, type AppModel, init, ReadItem, Remember, ScrollToTop, Undo, update, WaitBeforeDismissal, WaitBeforeSeen } from "../src/App.ts";
import * as Dock from "../src/components/Dock.ts";
import * as Inbox from "../src/components/Inbox.ts";
import type { Incident, Snapshot } from "../src/domain/Overwatch.ts";

const { Command, given, message, model, story } = Story;

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
const start = given(init({ initialTheme: null, initialCollapsed: { needsYou: false, new: false, working: true, quiet: true }, now: at(0) }).model);
const expect = (f: (model: AppModel) => void) => model<AppModel>(f);

/** What a subject coming into focus reads, answered as if nothing came back: its item, its row, where a prompt goes. */
const reads = (id: string, seq: number) =>
  Story.steps(
    Command.resolve(ReadItem({ id, seq }), AppMessage.FailedReadItem({ id })),
    Command.resolve(Inbox.RevealRow({ id }), Inbox.Message.CompletedMount({ name: "RevealRow" })),
    Command.resolve(Dock.LoadTarget({ subject: id }), Dock.Message.FailedTarget({ subject: id })),
  );

test("rows stay put while the service moves on; r releases what waits", () => {
  const a = incident("a", "first"), b = incident("b", "second"), c = incident("c", "arrival");
  story(
    update,
    start,
    message(AppMessage.ReceivedSnapshot({ snapshot: snapshot(5, ["a", "b"], [a, b]), at: at(10) })),
    expect((s) => assert.deepEqual(s.shown?.needsYou, ["a", "b"])),
    message(AppMessage.ReceivedSnapshot({ snapshot: snapshot(6, ["c", "a", "b"], [a, b, c]), at: at(20) })),
    expect((s) => assert.deepEqual(s.shown?.needsYou, ["a", "b"], "an arrival waits behind the line")),
    message(AppMessage.ReceivedSnapshot({ snapshot: snapshot(4, [], []), at: at(30) })),
    expect((s) => assert.equal(s.snapshot?.seq, 6, "an older snapshot is ignored")),
    message(AppMessage.PressedKey({ command: "refresh" })),
    expect((s) => assert.deepEqual(s.shown?.needsYou, ["c", "a", "b"])),
  );
});

test("done removes the row at once, moves focus to the next and u restores it in place", () => {
  const a = incident("a", "first"), b = incident("b", "second");
  const decided = { ...snapshot(7, ["b"], [{ ...a, way: { kind: "done", seq: 7 } }, b]), action: { seq: 7 } };
  story(
    update,
    start,
    message(AppMessage.ReceivedSnapshot({ snapshot: snapshot(5, ["a", "b"], [a, b]), at: at(10) })),
    message(AppMessage.PressedKey({ command: "next" })),
    Command.expectExact(WaitBeforeSeen({ id: "a", n: 1 }), ReadItem({ id: "a", seq: 5 }), Inbox.RevealRow({ id: "a" }), Dock.LoadTarget({ subject: "a" })),
    reads("a", 5),
    expect((s) => assert.equal(s.focus, "a")),
    // Held in focus, a row already seen is not marked again.
    Command.resolve(WaitBeforeSeen, AppMessage.ElapsedSeenWait({ id: "a", n: 1 })),
    Command.expectNone(),
    message(AppMessage.PressedKey({ command: "done" })),
    Command.expectExact(Act({ id: "a", body: { action: "done" }, basis: 1, before: ["a", "b"] })),
    Command.resolve(Act, AppMessage.SucceededAct({ id: "a", before: ["a", "b"], action: "done", decided, at: at(40) })),
    Command.expectExact(WaitBeforeDismissal({ n: 1 }), WaitBeforeSeen({ id: "b", n: 2 }), ReadItem({ id: "b", seq: 7 }), Inbox.RevealRow({ id: "b" }), Dock.LoadTarget({ subject: "b" })),
    expect((s) => {
      assert.deepEqual(s.shown?.needsYou, ["b"]);
      assert.equal(s.focus, "b");
      assert.equal(s.toast.text, "Done: first · u puts it back");
    }),
    reads("b", 7),
    Command.resolve(WaitBeforeSeen, AppMessage.ElapsedSeenWait({ id: "b", n: 2 })),
    Command.resolve(WaitBeforeDismissal, AppMessage.ElapsedToast({ n: 1 })),
    message(AppMessage.PressedKey({ command: "undo" })),
    expect((s) => assert.deepEqual(s.actions, [])),
    Command.resolve(Undo, AppMessage.SucceededUndo({ id: "a", decided: { ...snapshot(8, ["a", "b"], [a, b]), action: { seq: 8 } }, at: at(50) })),
    reads("a", 8),
    expect((s) => {
      assert.deepEqual(s.shown?.needsYou, ["a", "b"]);
      assert.equal(s.focus, "a");
      assert.equal(s.toast.text, "Put back");
    }),
    // The note leaves after its time; a wait that a later one replaced counts for nothing.
    Command.resolve(WaitBeforeDismissal, AppMessage.ElapsedToast({ n: 2 })),
    Command.resolve(WaitBeforeSeen, AppMessage.ElapsedSeenWait({ id: "a", n: 1 })),
    Command.expectNone(),
    expect((s) => assert.equal(s.toast.shown, false)),
  );
});

test("the page's own clock ages the connection: live, stale after 15 s, down after 30 s", () => {
  const connection = (s: AppModel) => freshness(s.last, s.now);
  story(
    update,
    start,
    expect((s) => assert.equal(connection(s), "unknown")),
    message(AppMessage.ReceivedHeartbeat({ atMs: 1_000_000, at: at(0) })),
    expect((s) => assert.equal(connection(s), "live")),
    message(AppMessage.Ticked({ at: at(15_000) })),
    expect((s) => assert.equal(connection(s), "stale")),
    message(AppMessage.Ticked({ at: at(30_000) })),
    expect((s) => assert.equal(connection(s), "down")),
    // A status read while the stream is away updates the picture, never liveness.
    message(AppMessage.SucceededStatus({ snapshot: { ...snapshotOf(9) }, at: at(31_000) })),
    expect((s) => {
      assert.equal(connection(s), "down");
      assert.equal(s.snapshot?.seq, 9);
    }),
  );
});

test("ClickedOverview returns to the board without reload; ClickedMarkCaughtUp persists checkpoint", () => {
  const a = incident("a", "checkout timeout");
  story(
    update,
    start,
    message(AppMessage.ReceivedSnapshot({ snapshot: snapshot(5, ["a"], [a]), at: at(10) })),
    message(AppMessage.PressedKey({ command: "next" })),
    reads("a", 5),
    Command.resolve(WaitBeforeSeen, AppMessage.ElapsedSeenWait({ id: "a", n: 1 })),
    expect((s) => assert.equal(s.focus, "a")),
    // Overview button clears focus and scrolls to top.
    message(AppMessage.ClickedOverview()),
    Command.expectExact(ScrollToTop()),
    Command.resolve(ScrollToTop, AppMessage.CompletedScrollToTop()),
    expect((s) => assert.equal(s.focus, null)),
    // Mark caught up saves seq + atMs in KeyValueStore and resets the window to "since".
    message(AppMessage.ToggledWhatsNewWindow()),
    expect((s) => assert.equal(s.whatsNewWindow, "24h")),
    message(AppMessage.ClickedMarkCaughtUp()),
    Command.expectExact(Remember({ key: "ow-caught-up", value: JSON.stringify({ seq: 5, atMs: 1_000_000 }) })),
    Command.resolve(Remember, AppMessage.CompletedRemember()),
    expect((s) => {
      assert.deepEqual(s.caughtUp, { seq: 5, atMs: 1_000_000 });
      assert.equal(s.whatsNewWindow, "since");
    }),
  );
});
