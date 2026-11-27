import "./scratch.ts";
/** The page's pure modules: freshness, frozen rows, staging, focus, the keyboard map and Later's words. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { Schema } from "effect";
import { freshness } from "../web/freshness.mjs";
import { HandoffBundle, LensSpec } from "../web/src/domain/Lens.ts";
import { Piece, Snapshot } from "../web/src/domain/Overwatch.ts";
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
      { kind: "timeline", title: "Timeline", events: [{ at: "4m ago", label: "Deploy landed", kind: "deploy", handle: "e_11111111" }, { at: 1_700_000_000_000, label: "First slow span", kind: "span", handle: "e_11111111" }] },
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

  // Server HandoffBundle with structured handle objects decodes cleanly and feeds buildOpenCodeHandoff
  const serverBundle = Schema.decodeUnknownSync(HandoffBundle)({
    id: "inc_1", title: "Timeout", app: "shop", env: "prod", checkout: "/repo/shop",
    deploy: "a1b2c3d4e5f6", previousDeploy: "9f8e7d6c5b4a",
    handles: [{ handle: "e_span0001", source: "pods", origin: "telemetry", text: "SLOW 890ms checkout POST /v2/authorize" }],
    mcpTools: ["ow_get", "ow_outlook"], commands: ["git diff 9f8e7d6c5b4a..a1b2c3d4e5f6"],
    prompt: "Focus inc_1", markdown: "# Overwatch Handoff: Timeout",
  });
  const fromBundle = buildOpenCodeHandoff(snap, "inc_1", detail, "mcp_only", serverBundle);
  assert.ok(fromBundle && fromBundle.handleCount === 1 && fromBundle.text.includes("`e_span0001`"));
});

test("whatsNew supports 24h first-visit & seq-reset fallbacks, sinceSeq filtering, and bounded caps", () => {
  const now = 1_700_100_000_000;
  const hour = 3_600_000;
  const inc = (overrides: Record<string, unknown>) => ({
    id: "i", title: "Issue", app: "shop", environment: "prod", severity: "error", active: true, group: "needsYou",
    decidedSeq: null, way: null, returned: null, firstSeq: 2, lastSeq: 2, firstMs: now - hour, lastMs: now - hour,
    ...overrides,
  });
  const snap: m.WhatsNewSnapshot = {
    seq: 20,
    atMs: now,
    environments: [{ app: "shop", environment: "prod" }, { app: "shop", environment: "staging" }],
    incidents: [
      inc({ id: "ret_1", title: "Returned checkout timeout", returned: { code: "again", reason: "happened again", seq: 15, causeSeq: 14 }, firstSeq: 3, lastSeq: 15 }),
      inc({ id: "new_1", title: "New error in prod", firstSeq: 16, lastSeq: 16, firstMs: now - 30 * 60_000 }),
      inc({ id: "old_1", title: "Ancient error", firstSeq: 1, lastSeq: 1, firstMs: now - 48 * hour, lastMs: now - 48 * hour }),
      inc({ id: "quiet_1", title: "Quieted spike", active: false, group: "quiet", firstSeq: 4, lastSeq: 18 }),
      inc({ id: "putaway_1", title: "Put away", way: { kind: "done", seq: 19 }, firstSeq: 17, lastSeq: 17 }),
    ],
    deploys: [
      { app: "shop", environment: "prod", revision: "a1b2c3d4e5f6", previous: "9f8e7d6c5b4a", seq: 12 },
      { app: "shop", environment: "staging", revision: "112233445566", previous: null, seq: 19 },
    ],
    outlook: { commits: [] },
    fixes: [
      { id: "fx_1", incident: "new_1", state: "verified", seq: 17, prUrl: null },
      { id: "fx_2", incident: "ret_1", state: "draft", seq: 18, prUrl: "https://github.com/acme/shop/pull/42" },
    ],
  };

  // First visit (caughtUp === null) -> calm 24h fallback excludes old_1 (>24h) and putaway_1
  const first = m.whatsNew(snap, null, now, "since");
  assert.equal(first.window, "24h");
  assert.equal(first.sinceSeq, 0);
  const firstIds = first.groups.flatMap((g) => g.items.map((x) => x.id));
  assert.ok(firstIds.includes("fix:fx_1") && firstIds.includes("fix:fx_2"));
  assert.ok(firstIds.includes("ret:ret_1"));
  assert.ok(firstIds.includes("new:new_1"));
  assert.ok(!firstIds.includes("new:old_1"));
  assert.ok(!firstIds.includes("new:putaway_1"));
  assert.equal(first.groups[0]?.items.find((x) => x.id === "fix:fx_1")?.badge, "⇧P ready");
  assert.equal(first.groups[0]?.items.find((x) => x.id === "fix:fx_2")?.badge, "PR draft");

  // Sequence reset (caughtUp.seq > snapshot.seq) -> falls back to 24h
  const reset = m.whatsNew(snap, { seq: 999, atMs: now - 10_000 }, now, "since");
  assert.equal(reset.window, "24h");
  assert.equal(reset.sinceSeq, 0);

  // Caught up at seq 16 -> only seq > 16 items remain
  const since = m.whatsNew(snap, { seq: 16, atMs: now - 10_000 }, now, "since");
  assert.equal(since.window, "since");
  const sinceIds = since.groups.flatMap((g) => g.items.map((x) => x.id));
  assert.deepEqual(sinceIds, ["fix:fx_2", "fix:fx_1", "deploy:shop:staging:19", "quiet:quiet_1"]);

  // Caught up at current seq -> 0 items
  const empty = m.whatsNew(snap, { seq: 20, atMs: now }, now, "since");
  assert.equal(empty.count, 0);
  assert.equal(empty.groups.length, 0);

  // Explicit 24h toggle overrides caught-up checkpoint
  const forced24h = m.whatsNew(snap, { seq: 20, atMs: now }, now, "24h");
  assert.equal(forced24h.window, "24h");
  assert.ok(forced24h.count > 0);

  // Bounded caps: max 3 per group, max 8 visible, remainder in overflow
  const manyIncidents = Array.from({ length: 12 }, (_, idx) =>
    inc({ id: `n_${idx}`, title: `New ${idx}`, firstSeq: 5 + idx, lastSeq: 5 + idx, firstMs: now - 1000 * (idx + 1) }),
  );
  const manyFixes = Array.from({ length: 5 }, (_, idx) => ({ id: `f_${idx}`, incident: `n_${idx}`, state: "verified", seq: 20 + idx, prUrl: null }));
  const manyDeploys = Array.from({ length: 4 }, (_, idx) => ({ app: "shop", environment: "prod", revision: `abc0000${idx}`, previous: null, seq: 30 + idx }));
  const bounded = m.whatsNew({ seq: 40, atMs: now, environments: snap.environments, incidents: manyIncidents, deploys: manyDeploys, fixes: manyFixes }, null, now, "since");
  assert.ok(bounded.groups.every((g) => g.items.length <= 3));
  const visibleCount = bounded.groups.reduce((sum, g) => sum + g.items.length, 0);
  assert.equal(visibleCount, 8);
  assert.equal(bounded.count, visibleCount + bounded.overflow.length);
  assert.equal(bounded.count, 12 + 5 + 4);
});

test("policyTags emits at most 3 calm pills only for non-default behavior", () => {
  assert.deepEqual(m.policyTags({ environment: "prod", policy: null }), []);
  assert.deepEqual(m.policyTags({ environment: "prod", policy: { investigate: true, notify: true, critical: true, fixMode: "off", databases: [] } }), []);
  assert.deepEqual(m.policyTags({ environment: "staging", policy: { investigate: true, notify: true, critical: false, fixMode: "off", databases: [] } }), []);

  const watchOnly = m.policyTags({ environment: "sandbox", policy: { investigate: false, fixMode: "off" } });
  assert.deepEqual(watchOnly.map((t) => t.label), ["watch only"]);
  assert.ok(watchOnly[0]!.title.length > 0);

  const rich = m.policyTags({
    environment: "canary",
    policy: { investigate: true, notify: false, critical: true, fixMode: "draft_pr", databases: ["orders", "ledger"] },
  });
  assert.equal(rich.length, 3);
  assert.deepEqual(rich.map((t) => t.label), ["draft PR", "DB ro", "critical"]);
  assert.deepEqual(rich.filter((t) => t.highSignal).map((t) => t.label), ["draft PR", "DB ro"]);
  assert.ok(rich.every((t) => t.title.length > 0));

  const mutedProd = m.policyTags({ environment: "prod", policy: { notify: false, critical: true, fixMode: "off" } });
  assert.deepEqual(mutedProd.map((t) => t.label), ["no alerts"]);
});

test("isDbPiece and parseDbEvidence parse JSON, TSV and pipe tables and fall back cleanly on prose", () => {
  assert.equal(m.isDbPiece({ source: "db:orders", origin: "telemetry" }), true);
  assert.equal(m.isDbPiece({ source: "db/main" }), true);
  assert.equal(m.isDbPiece({ source: "db" }), true);
  assert.equal(m.isDbPiece({ source: "orders", origin: "db" }), true);
  assert.equal(m.isDbPiece({ source: "pods", origin: "telemetry" }), false);

  const jsonArr = m.parseDbEvidence(`-- SELECT pid, state FROM pg_stat_activity\n[{"pid":42,"state":"waiting"},{"pid":43,"state":null}]`);
  assert.deepEqual(jsonArr, {
    query: "SELECT pid, state FROM pg_stat_activity",
    columns: ["pid", "state"],
    rows: [["42", "waiting"], ["43", "NULL"]],
  });

  const jsonObj = m.parseDbEvidence(JSON.stringify({ query: "SELECT 1", columns: ["id", "cnt"], rows: [[1, 9], [2, 4]] }));
  assert.deepEqual(jsonObj, { query: "SELECT 1", columns: ["id", "cnt"], rows: [["1", "9"], ["2", "4"]] });

  const tsv = m.parseDbEvidence("SQL: SELECT name, locks FROM locks\nname\tlocks\norders\t14\npayments\t2");
  assert.deepEqual(tsv, {
    query: "SELECT name, locks FROM locks",
    columns: ["name", "locks"],
    rows: [["orders", "14"], ["payments", "2"]],
  });

  const pipe = m.parseDbEvidence("table | count\n------+------\norders | 12\nusers | 3\n(2 rows)");
  assert.deepEqual(pipe, {
    columns: ["table", "count"],
    rows: [["orders", "12"], ["users", "3"]],
  });

  assert.equal(m.parseDbEvidence("ERROR connection refused to 10.0.0.4:5432"), null);
  assert.equal(m.parseDbEvidence("   "), null);
});

test("wire schemas, derived lens, and handoff integrate env policy, DB origin, and snapshot fixes/jobs", () => {
  const decodedSnap = Schema.decodeUnknownSync(Snapshot)({
    seq: 12,
    atMs: 1_700_000_060_000,
    environments: [{
      app: "shop", environment: "prod", subject: "env:shop/prod", health: "attention", readings: [], freshForMs: 180_000, excluded: [],
      policy: { investigate: true, readings: 3, notify: true, critical: true, fixMode: "draft_pr", genUi: true, databases: ["orders"] },
    }],
    sources: [],
    incidents: [{
      id: "inc_db", title: "ERROR checkout: lock timeout", count: 15, exact: true, severity: "error",
      app: "shop", environment: "prod", active: true, group: "needsYou", decidedSeq: 9, way: null,
      returned: { code: "again", reason: "recurred", seq: 11, causeSeq: 10 }, seenSeq: 0,
      firstSeq: 5, lastSeq: 11, firstMs: 1_700_000_000_000, lastMs: 1_700_000_050_000, spark: [0, 5, 10],
    }],
    inbox: { groups: { needsYou: ["inc_db"], new: [], working: [], quiet: [] } },
    coverage: [],
    metrics: [],
    deploys: [],
    causes: [],
    jobs: [{ id: "j_1", kind: "investigate", subject: "inc_db", state: "done", verdict: "real", seq: 8 }],
    fixes: [{ id: "fx_1", incident: "inc_db", state: "verified", seq: 12, prUrl: null }],
  });
  assert.equal(decodedSnap.incidents[0]?.returned?.seq, 11);
  assert.equal(decodedSnap.environments[0]?.policy?.fixMode, "draft_pr");
  assert.equal(decodedSnap.jobs?.[0]?.verdict, "real");
  assert.equal(decodedSnap.fixes?.[0]?.state, "verified");

  const dbPiece = Schema.decodeUnknownSync(Piece)({
    handle: "e_db000001",
    source: "db:orders",
    origin: "db",
    text: '[{"table":"orders","waiting":14}]',
  });
  const detail: any = {
    incident: decodedSnap.incidents[0],
    history: [],
    findings: [{
      id: "f_db", verdict: "real",
      claims: [{ statement: "14 queries waiting on orders lock", pieces: [dbPiece] }],
      body: { cause: "Lock contention on orders table", ruled_out: [], not_checked: [] },
    }],
    investigations: [],
    turns: [],
    corrections: [],
    fixable: false,
    fixes: [],
    comparison: null,
  };

  const lens = synthesizeIncidentLens(decodedSnap, decodedSnap.incidents[0]!, detail, decodedSnap.atMs);
  const dbBlock = lens.blocks.find((b) => b.kind === "key_facts" && b.facts.some((f) => f.origin === "db"));
  assert.ok(dbBlock, "synthesized lens surfaces a key_facts tile with origin: db");
  assert.doesNotThrow(() => Schema.decodeUnknownSync(LensSpec)(lens));

  const handoff = buildOpenCodeHandoff(decodedSnap, "inc_db", detail, "investigate");
  assert.ok(handoff);
  assert.match(handoff.text, /\*\*Policy\*\*: draft PR · DB ro \(databases: orders\)/);
  assert.match(handoff.text, /`e_db000001` \(db · read-only\)/);
  assert.match(handoff.text, /ow_db/);
});

test("readyForKeypress deduplicates visible What's new incidents when expanded and surfaces all needsYou when caught up", () => {
  const now = 1_700_100_000_000;
  const hour = 3_600_000;
  const inc = (overrides: Record<string, unknown>) => ({
    id: "i", title: "Issue", app: "shop", environment: "prod", severity: "error", active: true, group: "needsYou",
    decidedSeq: null, way: null, returned: null, firstSeq: 2, lastSeq: 2, firstMs: now - hour, lastMs: now - hour,
    ...overrides,
  });
  const snap: m.WhatsNewSnapshot = {
    seq: 20,
    atMs: now,
    environments: [{ app: "shop", environment: "prod" }],
    incidents: [
      inc({ id: "inc_new", title: "Fresh prod error", firstSeq: 19, lastSeq: 19, firstMs: now - 10 * 60_000 }),
      inc({ id: "inc_ret", title: "Returned timeout", returned: { code: "again", reason: "recurred", seq: 18 }, firstSeq: 5, lastSeq: 18 }),
      inc({ id: "inc_old", title: "Older ongoing error", firstSeq: 2, lastSeq: 2, firstMs: now - 48 * hour, lastMs: now - 48 * hour }),
    ],
    deploys: [{ app: "shop", environment: "prod", revision: "a1b2c3d4", previous: null, seq: 17 }],
    outlook: { commits: [] },
    fixes: [],
  };

  // Expanded What's new (first visit -> 24h): inc_new and inc_ret are visible in What's new, inc_old is not.
  const expanded = m.whatsNew(snap, null, now, "since");
  assert.ok(expanded.count > 0);
  const partial = m.readyForKeypress(["inc_new", "inc_ret", "inc_old"], expanded);
  assert.deepEqual(partial, { ids: ["inc_old"], coveredInWhatsNew: 2 });

  // When every needsYou incident is already visible in What's new, Ready collapses cleanly (0 non-duplicates).
  const allCovered = m.readyForKeypress(["inc_new", "inc_ret"], expanded);
  assert.deepEqual(allCovered, { ids: [], coveredInWhatsNew: 2 });

  // Once marked caught up (count === 0), Ready immediately surfaces all active needsYou incidents.
  const caughtUp = m.whatsNew(snap, { seq: 20, atMs: now }, now, "since");
  assert.equal(caughtUp.count, 0);
  const restored = m.readyForKeypress(["inc_new", "inc_ret", "inc_old"], caughtUp);
  assert.deepEqual(restored, { ids: ["inc_new", "inc_ret", "inc_old"], coveredInWhatsNew: 0 });
});

test("isEvidenceHandle and splitHandleRefs identify and split grounded evidence handles safely", () => {
  assert.equal(m.isEvidenceHandle("e_12345678"), true);
  assert.equal(m.isEvidenceHandle("e_db000001"), true);
  assert.equal(m.isEvidenceHandle("e_12"), false);
  assert.equal(m.isEvidenceHandle("inc_d0c4ab11"), false);

  assert.deepEqual(m.splitHandleRefs("Plain text with no handles"), [{ kind: "text", value: "Plain text with no handles" }]);
  assert.deepEqual(m.splitHandleRefs("Seen in e_1111aaaa and e_2222bbbb after rollout."), [
    { kind: "text", value: "Seen in " },
    { kind: "handle", value: "e_1111aaaa" },
    { kind: "text", value: " and " },
    { kind: "handle", value: "e_2222bbbb" },
    { kind: "text", value: " after rollout." },
  ]);
});
