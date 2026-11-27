import { scratch } from "./scratch.ts";
/**
 * Milestone 4, one property per class: the model's output is a selection, never bytes; the candidate is derived by
 * code and checked as a whole tree; verification is isolated; a forecast exists only when its conditions hold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { derive, gitAt, verify } from "../src/fixes.ts";
import { forecast } from "../src/outlook.ts";
import { parseConfig, type Source } from "../src/config.ts";
import { type Clean } from "../src/store.ts";
import { Tools, Refusal, type Options } from "../src/tools.ts";
import { clock } from "../src/clock.ts";
import { time } from "../src/parse.ts";
import { run, withStore } from "./effect.ts";

/** A bare repository with one file at `previous`, then `base`, and the two commits' IDs. */
function repo(files: Record<string, string>, changed: Record<string, string | null>, executable: string[] = []) {
  const bare = scratch("ow-fix-prop-"), work = scratch("ow-fix-work-");
  const git = (...a: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git("init", "-q");
  const put = (f: Record<string, string | null>) => { for (const [p, t] of Object.entries(f)) { if (t === null) rmSync(join(work, p)); else { mkdirSync(join(work, p, ".."), { recursive: true }); writeFileSync(join(work, p), t); } } };
  put(files); git("add", "-A"); git("commit", "-qm", "previous");
  const previous = git("rev-parse", "HEAD");
  put(changed); git("add", "-A");
  for (const f of executable) git("update-index", "--chmod=+x", f);
  git("commit", "-qm", "the change");
  const base = git("rev-parse", "HEAD");
  git("push", "-q", bare, "HEAD:refs/heads/main");
  rmSync(work, { recursive: true, force: true });
  return { bare, previous, base, git: gitAt(bare), done: () => rmSync(bare, { recursive: true, force: true }) };
}
const policy = { remote: "origin", base: "main", paths: ["settings.json"], verify: [["true"]] };
const scalar = fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.boolean(), fc.string({ maxLength: 8 }).filter((s) => !s.includes("\\")), fc.constant(null));

test("class: restoring a setting changes exactly that key to its previous value, keeps every other value and the file's layout", async () => {
  await fc.assert(
    fc.asyncProperty(fc.dictionary(fc.constantFrom("timeout", "retries", "region", "pool", "mode"), scalar, { minKeys: 2 }), fc.constantFrom(undefined, 2, 4), scalar, async (before, indent, next) => {
      const key = Object.keys(before)[0]!;
      fc.pre(before[key] !== next);
      const after = { ...before, [key]: next };
      const r = repo({ "settings.json": JSON.stringify(before, null, indent) + "\n", "verify.cjs": "1" }, { "settings.json": JSON.stringify(after, null, indent) + "\n" });
      try {
        const c = await run(derive(r.git, { id: "fx_p", previous: r.previous, base: r.base }, policy, { kind: "setting", path: "settings.json", key }));
        const text = await run(r.git.out(["show", `${c.commit}:settings.json`], "show"));
        assert.equal(text, JSON.stringify(before, null, indent) + "\n");
        assert.deepEqual(c.paths, ["settings.json"]);
        assert.equal((await run(r.git.out(["rev-parse", `${c.commit}^1`], "parent"))).trim(), r.base); // on the base tip, one commit
      } finally {
        r.done();
      }
    }),
    { numRuns: 20 },
  );
});

test("class: a candidate that touches anything outside the policy, adds, deletes or changes a mode is refused whole", async () => {
  const kinds = ["other-file", "add", "delete", "executable", "verify-input", "lockfile", "too-many-lines"] as const;
  await fc.assert(
    fc.asyncProperty(fc.constantFrom(...kinds), async (kind) => {
      const files: Record<string, string> = { "settings.json": '{"timeout":30}\n', "other.json": '{"a":1}\n', "verify.cjs": "1\n", "package-lock.json": "{}\n", "gone.txt": "x\n" };
      const change: Record<string, string | null> = { "settings.json": '{"timeout":3}\n' };
      if (kind === "delete") change["gone.txt"] = null;
      if (kind === "other-file") change["other.json"] = '{"a":2}\n';
      if (kind === "add") change["new.json"] = "{}\n";
      if (kind === "verify-input") change["verify.cjs"] = "2\n";
      if (kind === "lockfile") change["package-lock.json"] = '{"x":1}\n';
      if (kind === "too-many-lines") change["settings.json"] = JSON.stringify(Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`k${i}`, i])), null, 2) + "\n";
      const r = repo(files, change, kind === "executable" ? ["settings.json"] : []);
      try {
        // Revert the whole change: any part outside the policy refuses the whole candidate.
        const p = { ...policy, paths: kind === "verify-input" ? ["settings.json", "verify.cjs"] : policy.paths, verify: [["node", "verify.cjs"]] };
        await assert.rejects(run(derive(r.git, { id: "fx_p", previous: r.previous, base: r.base }, p, { kind: "revert", commit: r.base })));
      } finally {
        r.done();
      }
    }),
    { numRuns: kinds.length * 2 },
  );
});

test("class: the fixer's filing is a member of the options code computed, or it is refused and ends the run", async () => {
  clock.set(Date.UTC(2026, 10, 1), 1e6);
  const options: Options = { commits: [{ sha: "a".repeat(40), subject: "x" }, { sha: "b".repeat(40), subject: "y" }], keys: [{ path: "settings.json", key: "timeout" }] };
  let n = 0;
  await run(
    withStore(scratch("ow-proposal-"), (store) =>
      Effect.gen(function* () {
        const tools = yield* Tools;
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(fc.oneof(
              fc.record({ kind: fc.constantFrom("revert", "setting", "abstain", "patch"), commit: fc.constantFrom("a".repeat(40), "c".repeat(40)), path: fc.constantFrom("settings.json", "other.json"), key: fc.constantFrom("timeout", "retries"), patch: fc.string() }, { requiredKeys: ["kind"] }),
              fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue({ maxDepth: 1 })),
            ), (input) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const runId = `run_${++n}`, session = `ses_${n}`;
                  yield* store.tx((w) =>
                    Effect.gen(function* () {
                      const seq = yield* w.event("job", null, {});
                      yield* w.run("INSERT OR IGNORE INTO jobs (id, kind, subject, title, state, created_seq) VALUES ('job_p', 'trial', 'p', 'p', 'running', ?)", seq);
                      yield* w.run("INSERT INTO runs (id, job_id, attempt, session_id, state, calls, code, started_ms, role) VALUES (?, 'job_p', ?, ?, 'active', 0, '{}', 0, 'fixer')", runId as Clean, n, session as Clean);
                    }),
                  );
                  tools.contexts.set(runId, { telemetry: {}, repo: null, deadline: clock.mono() + 60_000, role: "fixer", options });
                  const valid = (input.kind === "abstain" && Object.keys(input).length === 1)
                    || (input.kind === "revert" && Object.keys(input).every((k) => k === "kind" || k === "commit") && options.commits.some((c) => c.sha === (input.commit ?? null)))
                    || (input.kind === "setting" && Object.keys(input).every((k) => ["kind", "path", "key"].includes(k)) && options.keys.some((k) => k.path === input.path && k.key === input.key));
                  const outcome = yield* Effect.result(tools.call(session, "ow_proposal", input));
                  if (outcome._tag === "Success") assert.ok(valid, JSON.stringify(input));
                  else {
                    assert.ok(outcome.failure instanceof Refusal);
                    assert.ok(!valid || /already/.test(outcome.failure.message), JSON.stringify(input));
                  }
                  const row = yield* store.get<{ refused: string | null }>("SELECT refused FROM proposals WHERE run_id = ?", runId);
                  assert.ok(row, "every filing, accepted or refused, is stored and ends the run");
                  assert.equal(row.refused === null, valid);
                  assert.equal((yield* store.get<{ state: string }>("SELECT state FROM runs WHERE id = ?", runId))!.state, "terminal");
                }),
              ),
            ),
            { numRuns: 60 },
          ),
        );
      }).pipe(Effect.provide(Tools.layer)),
    ),
  );
});

test("class: verification runs without network and cannot write outside its checkout", { skip: process.platform !== "darwin" }, async () => {
  const outside = join(tmpdir(), `ow-escape-${process.pid}`);
  const r = repo({ "settings.json": "{}\n" }, { "settings.json": '{"a":1}\n' });
  try {
    const write = await run(verify(r.bare, r.base, { ...policy, verify: [["node", "-e", `require('fs').writeFileSync(${JSON.stringify(outside)}, 'x')`]] }));
    assert.notEqual(write[0]!.exitCode, 0, "wrote outside the checkout");
    const net = await run(verify(r.bare, r.base, { ...policy, verify: [["node", "-e", "require('net').connect(80, '1.1.1.1').on('connect', () => process.exit(0)).on('error', () => process.exit(3))"]] }));
    assert.notEqual(net[0]!.exitCode, 0, "reached the network");
    const inside = await run(verify(r.bare, r.base, { ...policy, verify: [["node", "-e", "require('fs').writeFileSync(require('os').tmpdir() + '/ok', 'x')"]] }));
    assert.equal(inside[0]!.exitCode, 0, inside[0]!.summary);
  } finally {
    r.done();
    rmSync(outside, { force: true });
  }
});

test("class: a forecast exists only for six fresh, evenly spaced, consistently rising samples, and its ETA follows from them", () => {
  const cfg = parseConfig({ version: 2, dataDir: "/tmp/ow-f", apps: { a: { checkout: "/tmp", environments: { p: { sources: { d: { type: "datadog", apiKey: "env:A", appKey: "env:B", query: "q", metric: "m", readings: ["metrics"], capacity: { resource: "disk", unit: "units", limit: 1000 } } } } } } }, watchers: [{ app: "a", environment: "p", every: "1m" }] }, "/tmp/c.json");
  const source = cfg.sources[0] as Source, seen = [0, 0];
  fc.assert(
    fc.property(fc.oneof(
      fc.array(fc.option(fc.integer({ min: 0, max: 1200 }), { nil: null, freq: 12 }), { minLength: 1, maxLength: 10 }),
      fc.tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 1, max: 60 }), fc.array(fc.integer({ min: -20, max: 20 }), { minLength: 6, maxLength: 9 }))
        .map(([start, step, noise]) => noise.map((n, i) => start + i * step + Math.round((n * step) / 100))),
    ), fc.integer({ min: 0, max: 90_000 }), (values, lag) => {
      seen[0]!++;
      const t0 = 1_000_000_000_000;
      const hash = createHash("sha256").update(JSON.stringify(["m", "disk", "units", 1000])).digest("hex");
      const rows = values.map((v, i) => ({ series: hash, at_ms: time(new Date(t0 + i * 60_000).toISOString())!, value: v }));
      const now = t0 + (values.length - 1) * 60_000 + lag;
      const f = forecast(source, rows, now);
      if (f.state !== "forecast") return assert.equal(f.etaMinutes, null);
      seen[1]!++;
      const last = values.slice(-6) as number[];
      assert.ok(values.length >= 6 && last.every((v) => v !== null) && lag <= 60_000);
      for (let i = 1; i < 6; i++) assert.ok(last[i]! > last[i - 1]!);
      assert.ok(last[5]! < 1000);
      assert.equal(f.etaMinutes, Math.ceil((1000 - last[5]!) / f.ratePerMinute!));
      assert.ok(f.etaMinutes! <= 24 * 60);
    }),
    { numRuns: 400 },
  );
  assert.ok(seen[1]! > 20 && seen[1]! < seen[0]!, `forecasts ${seen[1]} of ${seen[0]}: both outcomes exercised`);
});
