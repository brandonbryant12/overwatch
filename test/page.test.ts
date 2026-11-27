import "./scratch.ts";
/** The page's pure modules: freshness, frozen rows, staging, focus, the keyboard map and Later's words. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { Schema } from "effect";
import { freshness } from "../web/freshness.mjs";
import { LensSpec } from "../web/src/domain/Lens.ts";
import { buildOpenCodeHandoff } from "../web/src/handoff.ts";
import { knownHandles, parseSlowSpans, selectActiveLens, synthesizeEnvLens, synthesizeIncidentLens, validateLensHandles } from "../web/src/lens.ts";
import * as m from "../web/src/model.ts";

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

const inbox = (groups: Record<string, Array<string>>) => ({ seq: 1, groups: { needsYou: [], new: [], working: [], quiet: [], ...groups } });

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
  const until = (text: string) => (m.later(text, now) as m.WayOut).untilMs ?? 0;
  assert.equal(new Date(until("tomorrow")).getHours(), 9);
  assert.ok(until("monday") > now);
  assert.ok("error" in m.later("soonish", now));
  assert.equal(m.shownHealth("quiet", "stale"), "unknown");
});

test("class: what waits behind the line is counted once, and only arrivals ask for attention", () => {
  const ids = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e", "f"), { maxLength: 6 });
  const groups = (list: string[], pick: number[]) => Object.fromEntries(m.GROUPS.map((g: string, i: number) => [g, list.filter((_, n) => pick[n] === i)]));
  fc.assert(
    fc.property(ids, fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 6, maxLength: 6 }), ids, fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 6, maxLength: 6 }), (a, pa, b, pb) => {
      const shown = m.freeze({ groups: groups(a, pa) });
      const s = m.staged(shown, { groups: groups(b, pb) });
      const label = m.pendingLabel(s);
      assert.equal(label.count, s.arrivals.length + s.moved.length);
      assert.equal(label.attention, s.arrivals.length > 0);
      assert.equal(/new/.test(label.text), s.arrivals.length > 0);
      assert.ok(s.arrivals.every((id: string) => !a.includes(id)));
    }),
  );
});

test("class: a cell is never shown as measured once any expected reading is older than it stays fresh", () => {
  const health = fc.constantFrom("quiet", "attention", "partial", "stale", "signed_out");
  fc.assert(
    fc.property(health, fc.constantFrom<m.Connection>("live", "stale", "down", "unknown"), fc.array(fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null }), { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 2000 }), (h, connection, ages, now) => {
      const env = { health: h, freshForMs: 300, readings: ages.map((a) => ({ okMs: a === null ? null : now - a })) };
      const shown = m.cellHealth(env, connection, now);
      if (connection !== "live") assert.equal(shown, "unknown");
      else if (ages.some((a) => a === null || a > 300) && h !== "signed_out") assert.equal(shown, "stale");
      if (shown === "quiet") assert.ok(connection === "live" && ages.every((a) => a !== null && a <= 300));
    }),
  );
});

test("class: an investigation looks agreed only when every planned reading filed the same standing verdict", () => {
  const v = fc.constantFrom("real", "not_real", "unsure");
  fc.assert(
    fc.property(v, fc.integer({ min: 1, max: 3 }), fc.nat(3), fc.nat(3), fc.nat(3), fc.option(fc.constantFrom("upheld", "disproved", "unsure", null), { nil: undefined }), (verdict, planned, real, notReal, unsure, outcome) => {
      const missing = Math.max(0, planned - real - notReal - unsure);
      const result = { verdict, planned, counts: { real, not_real: notReal, unsure, missing }, challenge: outcome === undefined ? null : { outcome }, observed: false };
      const view = m.verdictView(result);
      if (verdict === "unsure") assert.equal(view.tone, "undecided");
      if (view.tone === "agreed") assert.ok(Math.max(real, notReal, unsure) === planned && missing === 0 && outcome !== "disproved");
    }),
  );
});

test("additive keyboard bindings support OpenCode handoff (c, Shift+O) and Visual Lens (g)", () => {
  assert.equal(m.command("c"), "copyHandoff");
  assert.equal(m.command("O", { shift: true }), "handoffSheet");
  assert.equal(m.command("g"), "lens");
  assert.equal(m.command("c", { typing: true }), null);
  assert.equal(m.command("g", { overlay: true }), null);
  // Existing bindings remain unchanged
  assert.equal(m.command("o"), "open");
  assert.equal(m.command("P", { shift: true }), "publish");
});

test("LensSpec schema decodes all 6 declarative GenUI block types and rejects malformed blocks", () => {
  const valid = {
    source: "ai",
    title: "Checkout latency spike",
    summary: "Payments timeout cut from 3000ms to 300ms after deploy a1b2c3d.",
    model: "glm-5.3",
    generatedAt: 1_700_000_000_000,
    verifiedHandles: ["e_11111111"],
    blocks: [
      { kind: "causal_flow", title: "Causal path", steps: [{ label: "Deploy", detail: "a1b2c3d", tone: "warn", handle: "e_11111111" }] },
      { kind: "span_waterfall", title: "Slow spans", p50Ms: 120, slowMs: 300, spans: [{ label: "POST /authorize", service: "checkout", durationMs: 840, offsetMs: 0, status: "slow", handle: "e_11111111" }] },
      { kind: "metric_compare", title: "Delta", rows: [{ label: "Timeout", before: "3000 ms", after: "300 ms", beforeNum: 3000, afterNum: 300, unit: "ms", delta: "-90%", tone: "error", handle: "e_11111111" }] },
      { kind: "commit_risk", title: "Commits", commits: [{ sha: "a1b2c3d4", subject: "Adjust payments timeout", files: 2, insertions: 4, deletions: 4, flags: ["timeout"], deployed: true, handle: "e_11111111" }] },
      { kind: "timeline", title: "Timeline", events: [{ at: "4m ago", label: "Deploy landed", kind: "deploy", handle: "e_11111111" }] },
      { kind: "key_facts", title: "Facts", facts: [{ label: "Count", value: "42×", origin: "telemetry", handle: "e_11111111" }] },
    ],
  };
  const decoded = Schema.decodeUnknownSync(LensSpec)(valid);
  assert.equal(decoded.blocks.length, 6);
  assert.throws(() => Schema.decodeUnknownSync(LensSpec)({ ...valid, blocks: [{ kind: "raw_html", html: "<script>alert(1)</script>" }] }));
});

test("validateLensHandles flags invented handles as ungrounded while passing verified handles", () => {
  const lens = Schema.decodeUnknownSync(LensSpec)({
    source: "ai",
    title: "Visual lens",
    summary: "Summary",
    generatedAt: 1_700_000_000_000,
    verifiedHandles: ["e_real0001"],
    blocks: [
      { kind: "causal_flow", title: "Flow", steps: [{ label: "Step 1", detail: "Observed", tone: "error", handle: "e_real0001" }, { label: "Step 2", detail: "Hallucinated", tone: "warn", handle: "e_fake9999" }] },
    ],
  });
  const check = validateLensHandles(lens, new Set(["e_real0001"]));
  assert.deepEqual(check.verified, ["e_real0001"]);
  assert.deepEqual(check.ungrounded, ["e_fake9999"]);
  assert.equal(check.grounded, false);

  const ok = validateLensHandles({ ...lens, blocks: [{ kind: "causal_flow", title: "Flow", steps: [{ label: "Step 1", detail: "Observed", tone: "error", handle: "e_real0001" }] }] }, new Set(["e_real0001"]));
  assert.equal(ok.grounded, true);
  assert.deepEqual(ok.ungrounded, []);
});

test("parseSlowSpans and synthesizeIncidentLens build grounded waterfall, causal flow, delta and commit blocks", () => {
  const spans = parseSlowSpans([
    { handle: "e_span0001", text: "SLOW 890ms checkout POST /v2/authorize trace=tr_1\nSLOW 1420ms orders SELECT pool trace=tr_2" },
  ]);
  assert.equal(spans.length, 2);
  assert.equal(spans[0]!.durationMs, 890);
  assert.equal(spans[0]!.status, "slow");
  assert.equal(spans[1]!.status, "error");

  const snap: any = {
    seq: 10,
    atMs: 1_700_000_060_000,
    environments: [{ app: "shop", environment: "prod", subject: "env:shop/prod", health: "attention", readings: [], freshForMs: 180_000, excluded: [] }],
    sources: [{ id: "shop/prod/pods", subject: "src:shop/prod/pods", app: "shop", environment: "prod", kind: "kubernetes", checkpointMs: 1_700_000_050_000, failure: null, suspended: false, fix: null }],
    incidents: [{
      id: "inc_1", title: "ERROR checkout: payments timeout after 300ms", count: 42, exact: true, severity: "error",
      app: "shop", environment: "prod", active: true, group: "needsYou", decidedSeq: 5, way: null, returned: null, seenSeq: 0,
      firstSeq: 4, lastSeq: 10, firstMs: 1_700_000_000_000, lastMs: 1_700_000_050_000, spark: [0, 0, 12, 30],
    }],
    inbox: { groups: { needsYou: ["inc_1"], new: [], working: [], quiet: [] } },
    coverage: [],
    metrics: [],
    deploys: [{ app: "shop", environment: "prod", revision: "a1b2c3d4e5f6", previous: "9f8e7d6c5b4a", seq: 2 }],
    outlook: {
      forecasts: [],
      comparisons: [],
      commits: [{ app: "shop", sha: "a1b2c3d4e5f6", parent: "9f8e7d6c5b4a", committedAt: 1_700_000_000_000, subject: "Lower payments timeout", files: 1, insertions: 1, deletions: 1, flags: ["timeout"], paths: ["config/payments.json"], deployedEnvs: ["prod"] }],
    },
    causes: [],
  };
  const detail: any = {
    incident: snap.incidents[0],
    history: [{ atMs: 1_700_000_000_000, kind: "incident", data: {} }],
    findings: [{
      id: "f_1", verdict: "real",
      claims: [{ statement: "Timeout reduced", pieces: [{ handle: "e_span0001", source: "pods", text: "SLOW 890ms checkout POST /v2/authorize trace=tr_1" }] }],
      body: { cause: "Deploy a1b2c3d lowered timeout from 3000 ms to 300 ms", ruled_out: [], not_checked: [] },
    }],
    investigations: [{ jobId: "j_1", state: "completed", result: { verdict: "real", planned: 3, counts: { real: 3 }, observed: true, observations: 1, readings: [] } }],
    turns: [],
    corrections: [],
    fixable: true,
    fixes: [],
    comparison: null,
  };

  assert.deepEqual([...knownHandles(detail)], ["e_span0001"]);
  const derived = synthesizeIncidentLens(snap, snap.incidents[0], detail, snap.atMs);
  assert.equal(derived.source, "derived");
  assert.ok(derived.blocks.some((b) => b.kind === "span_waterfall"));
  assert.ok(derived.blocks.some((b) => b.kind === "causal_flow"));
  assert.ok(derived.blocks.some((b) => b.kind === "metric_compare"));

  const envLens = synthesizeEnvLens(snap, snap.environments[0], snap.atMs);
  assert.ok(envLens && envLens.blocks[0]?.kind === "commit_risk");

  const selected = selectActiveLens(detail, "auto", null, derived);
  assert.equal(selected.hasAi, false);
  assert.equal(selected.validation.grounded, true);

  // OpenCode handoff synthesis covers all presets & includes verified handles + git diff command
  const handoff = buildOpenCodeHandoff(snap, "inc_1", detail, "fix_local");
  assert.ok(handoff);
  assert.equal(handoff.handleCount, 1);
  assert.match(handoff.text, /e_span0001/);
  assert.match(handoff.text, /git diff 9f8e7d6c5b4a\.\.a1b2c3d4e5f6/);
  assert.match(handoff.text, /ow_get/);

  const mcpOnly = buildOpenCodeHandoff(snap, "inc_1", detail, "mcp_only");
  assert.ok(mcpOnly && mcpOnly.text.includes('ow_get({ id: "inc_1" })'));
});
