/** The page's pure modules: freshness, frozen rows, staging, focus, the keyboard map and Later's words. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

const fresh = "../web/freshness.mjs", model = "../web/model.mjs";
const { freshness } = await import(fresh);
const m = await import(model);

test("freshness ages by whichever clock moved more, and never by a clock that went back", () => {
  fc.assert(
    fc.property(fc.integer({ min: -60_000, max: 60_000 }), fc.integer({ min: -60_000, max: 60_000 }), (dw, dm) => {
      const last = { wallMs: 1e6, monoMs: 5e5 };
      const age = Math.max(0, dw, dm);
      assert.equal(freshness(last, { wallMs: last.wallMs + dw, monoMs: last.monoMs + dm }), age >= 30_000 ? "down" : age >= 15_000 ? "stale" : "live");
    }),
  );
  assert.equal(freshness(null, { wallMs: 0, monoMs: 0 }), "unknown");
});

const inbox = (groups: Record<string, string[]>) => ({ seq: 1, groups: { needsYou: [], new: [], working: [], quiet: [], ...groups } });

test("rows stay put: arrivals and regroupings wait, own actions remove and restore at once in server order", () => {
  const shown = m.freeze(inbox({ needsYou: ["a", "c"], new: ["x"] }));
  const next = inbox({ needsYou: ["a", "b", "c"], new: [], quiet: ["x"] });
  assert.deepEqual(m.staged(shown, next), { arrivals: ["b"], moved: ["x"], count: 2 });
  const gone = m.without(shown, "a");
  assert.deepEqual(gone.needsYou, ["c"]);
  assert.deepEqual(m.restore(gone, inbox({ needsYou: ["a", "b", "c"] }), "a").needsYou, ["a", "c"], "b is still staged; a returns before c");
});

test("focus moves through displayed rows only, starts at the top, and takes the next row when its row leaves", () => {
  const rows = m.order(m.freeze(inbox({ needsYou: ["a"], new: ["b"], quiet: ["q"] })), { quiet: true });
  assert.deepEqual(rows, ["a", "b"]);
  assert.equal(m.step(rows, null, 1), "a");
  assert.equal(m.step(rows, "b", 1), "b");
  assert.equal(m.after(rows, "a", "a"), "b");
  assert.equal(m.after(["a"], "a", "a"), null);
});

test("keys typed into a field are text; only Escape escapes", () => {
  for (const k of ["d", "l", "n", "u", "j", "r", "p"]) assert.equal(m.command(k, { typing: true }), null);
  assert.equal(m.command("Escape", { typing: true }), "escape");
  assert.equal(m.command("d"), "done");
  assert.equal(m.command("d", { overlay: true }), null);
  assert.equal(m.command("k", { meta: true }), "search");
});

test("Later's words", () => {
  const now = new Date(2026, 10, 25, 14, 0).getTime();
  assert.deepEqual(m.later("", now), { action: "later" });
  assert.deepEqual(m.later("worse", now), { action: "later", when: "worse" });
  assert.deepEqual(m.later("2h", now), { action: "later", untilMs: now + 7_200_000 });
  assert.equal(new Date(m.later("tomorrow", now).untilMs).getHours(), 9);
  assert.ok(m.later("monday", now).untilMs > now);
  assert.ok(m.later("soonish", now).error);
  assert.equal(m.shownHealth("quiet", "stale"), "unknown");
});
