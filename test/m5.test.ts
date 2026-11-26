import { scratch } from "./scratch.ts";
/**
 * Milestone 5, one property per class: a permit is spent only on the exact effect it was minted for; a forecast needs
 * the provider's unit to be the limit's; the start-up sweep removes exactly the orphans of processes that no longer run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { sweep } from "../src/exec.ts";
import { forecast } from "../src/outlook.ts";
import { parseConfig, type Source } from "../src/config.ts";
import { time } from "../src/parse.ts";
import { run, withStore } from "./effect.ts";

test("class: a permit is spent once, and only on a call that contains every argument it was minted for", async () => {
  const token = fc.constantFrom("pr", "create", "--repo", "acme/shop", "acme/other", "ow/fix/a", "ow/fix/b", "a".repeat(40), "b".repeat(40), "main");
  await run(
    withStore(scratch("ow-permit-"), (store) =>
      Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(fc.uniqueArray(token, { maxLength: 4 }), fc.array(token, { maxLength: 6 }), fc.constantFrom("host", "push"), fc.constantFrom("host", "push"), async (bind, args, minted, used) => {
            const permit = await Effect.runPromise(store.permit(minted, "fx_p", {}, bind));
            const ok = minted === used && bind.every((b) => args.includes(b));
            if (ok) {
              permit.spend(used, args);
              assert.throws(() => permit.spend(used, args), /committed intent/); // once
            } else assert.throws(() => permit.spend(used, args));
          }),
          { numRuns: 200 },
        ),
      ),
    ),
  );
});

test("class: a forecast needs the provider's unit to be the limit's; otherwise no time, with the reason", () => {
  fc.assert(
    fc.property(fc.constantFrom("bytes", "units"), fc.option(fc.constantFrom("byte", "second", "percent", "", "kibibyte"), { nil: null }), (limitUnit, providerUnit) => {
      const cfg = parseConfig({ version: 2, dataDir: "/tmp/ow-u", apps: { a: { checkout: "/tmp", environments: { p: { sources: { d: { type: "datadog", apiKey: "env:A", appKey: "env:B", query: "q", metric: "m", readings: ["metrics"], capacity: { resource: "disk", unit: limitUnit, limit: 10_000 } } } } } } }, watchers: [{ app: "a", environment: "p", every: "1m" }] }, "/tmp/c.json");
      const source = cfg.sources[0] as Source, t0 = 1_000_000_000_000;
      const series = createHash("sha256").update(JSON.stringify(["m", "disk", limitUnit, 10_000])).digest("hex") + (providerUnit ? `:${providerUnit}` : "");
      const rows = Array.from({ length: 6 }, (_, i) => ({ series, at_ms: time(new Date(t0 + i * 60_000).toISOString())!, value: 100 + i * 50 }));
      const f = forecast(source, rows, t0 + 5 * 60_000);
      const matches = (providerUnit ?? "") === (limitUnit === "bytes" ? "byte" : "");
      if (matches) assert.equal(f.state, "forecast", JSON.stringify(f));
      else {
        assert.equal(f.etaMinutes, null, JSON.stringify(f));
        assert.match(f.reason ?? "", /not the limit's/);
      }
    }),
    { numRuns: 60 },
  );
});

test("class: the start-up sweep removes exactly the scratch of processes that no longer run", async () => {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const prefixes = ["overwatch-demo", "overwatch-trial", "ow-verify", "ow-fix", "ow-pr", "ow-calibration", "ow-calibration-work", "ow-other", "verify"];
  let n = 0;
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(...prefixes), fc.constantFrom(dead, process.pid, 1)), { minLength: 1, maxLength: 6 }), async (dirs) => {
      const names = dirs.map(([p, pid]) => `${p}-${pid}-${++n}`);
      for (const name of names) mkdirSync(join(tmpdir(), name));
      await run(sweep);
      const left = new Set(readdirSync(tmpdir()));
      dirs.forEach(([p, pid], i) => {
        const orphan = pid === dead && !["ow-other", "verify"].includes(p);
        assert.equal(left.has(names[i]!), !orphan, names[i]);
      });
    }),
    { numRuns: 40 },
  );
});
