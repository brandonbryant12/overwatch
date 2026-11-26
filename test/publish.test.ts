import { scratch } from "./scratch.ts";
/**
 * The owner's publication of a verified candidate, against a local bare remote and a fake `gh` (never a real host):
 * one property that a repeat never makes a second object on the host whatever fails, and one probe per host step
 * that kills the publishing process at that step and presses again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit } from "effect";
import { loadConfig, type Config } from "../src/config.ts";
import { json, type Clean, type StoreShape } from "../src/store.ts";
import { Fixes } from "../src/fixes.ts";
import { keyed } from "../src/inbox.ts";
import { approvalKey, fixGateKey } from "../src/trial.ts";
import { errorText } from "../src/redact.ts";
import { run, withConfig, withStore } from "./effect.ts";

const REAL_GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const ID = "fx_publishprobe000000000001";
type Fault = { op: "protect" | "list" | "create" | "push"; mode: "before" | "after" | "kill" | "killbefore" | "unknown" | "protected" };

/** A fake host: `gh` keeps pull requests in prs.json and consumes faults.json; a `git` wrapper does the same for push. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const dir = process.env.OW_FAKE_HOST, args = process.argv.slice(2);
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) } catch { return d } };
fs.appendFileSync(path.join(dir, "gh.jsonl"), JSON.stringify(args) + "\\n");
const op = args[0] === "api" ? "protect" : args[1];
const faults = read("faults.json", []), i = faults.findIndex((f) => f.op === op), fault = i >= 0 ? faults.splice(i, 1)[0] : null;
fs.writeFileSync(path.join(dir, "faults.json"), JSON.stringify(faults));
const kill = () => process.kill(Number(process.env.OW_PUBLISHER_PID), "SIGKILL");
if (fault?.mode === "killbefore") { kill(); process.exit(1) }
if (fault?.mode === "before") { console.error("fault before " + op); process.exit(1) }
const opt = (n) => args[args.indexOf(n) + 1];
let out = "";
if (op === "protect") out = fault?.mode === "unknown" ? "<html>" : fault?.mode === "protected" ? '[{"type":"update"}]' : "[]";
else if (op === "list") out = JSON.stringify(read("prs.json", []).filter((p) => p.headRefName === opt("--head")));
else if (op === "create") {
  const prs = read("prs.json", []), n = prs.length + 1;
  prs.push({ number: n, url: "http://127.0.0.1/pull/" + n, state: "OPEN", isDraft: args.includes("--draft"), baseRefName: opt("--base"), headRefName: opt("--head"), body: fs.readFileSync(opt("--body-file"), "utf8") });
  fs.writeFileSync(path.join(dir, "prs.json"), JSON.stringify(prs));
  out = "http://127.0.0.1/pull/" + n;
}
if (fault?.mode === "kill") kill();
if (fault?.mode === "after") { console.error("fault after " + op); process.exit(1) }
console.log(out);
`;
const FAKE_GIT = (real: string) => `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const dir = process.env.OW_FAKE_HOST, args = process.argv.slice(2);
const faults = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "faults.json"), "utf8")) } catch { return [] } })();
const i = args.includes("push") ? faults.findIndex((f) => f.op === "push") : -1, fault = i >= 0 ? faults.splice(i, 1)[0] : null;
if (fault) fs.writeFileSync(path.join(dir, "faults.json"), JSON.stringify(faults));
const kill = () => process.kill(Number(process.env.OW_PUBLISHER_PID), "SIGKILL");
if (fault?.mode === "killbefore") { kill(); process.exit(1) }
if (fault?.mode === "before") { console.error("fault before push"); process.exit(1) }
const r = spawnSync(${JSON.stringify(real)}, args, { stdio: "inherit" });
if (fault?.mode === "kill") kill();
process.exit(fault?.mode === "after" ? 1 : r.status ?? 1);
`;

/** Changes the database with the service stopped: one transaction. */
const change = (dir: string, body: (s: StoreShape) => Effect.Effect<unknown, unknown, never>) => run(withStore(dir, body));

async function rig() {
  const root = scratch("ow-publish-"), bin = join(root, "bin"), host = join(root, "host"), remote = join(root, "remote.git"), checkout = join(root, "checkout"), work = join(root, "work");
  for (const d of [bin, host, work]) mkdirSync(d);
  writeFileSync(join(bin, "gh"), FAKE_GH), chmodSync(join(bin, "gh"), 0o755);
  writeFileSync(join(bin, "git"), FAKE_GIT(REAL_GIT)), chmodSync(join(bin, "git"), 0o755);
  const git = (...a: string[]) => execFileSync(REAL_GIT, a, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "--bare", remote);
  git("-C", work, "init", "-q");
  writeFileSync(join(work, "settings.json"), '{"timeout":3}\n');
  git("-C", work, "add", "settings.json");
  git("-C", work, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "base");
  git("-C", work, "push", "-q", remote, "HEAD:refs/heads/main");
  const base = git("-C", work, "rev-parse", "HEAD");
  git("init", "-q", checkout);
  git("-C", checkout, "remote", "add", "origin", remote);
  const dataDir = join(root, "data"), file = join(root, "config.json");
  writeFileSync(file, JSON.stringify({
    version: 2, dataDir, opencode: { url: "http://127.0.0.1:9", model: "fixture/m" },
    apps: { shop: { checkout, fixes: { remote: "origin", base: "main", paths: ["settings.json"], verify: [["true"]] }, environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } },
    watchers: [{ app: "shop", environment: "prod", every: "1m" }],
  }));
  const config = await run(loadConfig(file));
  // The verified candidate in the private mirror: settings.json restored on top of the base.
  const mirror = join(dataDir, "fixes", "shop.git");
  mkdirSync(join(dataDir, "fixes"), { recursive: true });
  git("init", "-q", "--bare", mirror);
  git("-C", mirror, "fetch", "-q", remote, "main:refs/ow/base");
  const blob = execFileSync(REAL_GIT, ["-C", mirror, "hash-object", "-w", "--stdin"], { input: '{"timeout":30}\n', encoding: "utf8" }).trim();
  const tree = execFileSync(REAL_GIT, ["-C", mirror, "mktree"], { input: `100644 blob ${blob}\tsettings.json\n`, encoding: "utf8" }).trim();
  const head = execFileSync(REAL_GIT, ["-C", mirror, "commit-tree", tree, "-p", base, "-m", "Restore timeout"], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "o", GIT_AUTHOR_EMAIL: "o@localhost", GIT_COMMITTER_NAME: "o", GIT_COMMITTER_EMAIL: "o@localhost" } }).trim();
  await change(dataDir, (store) =>
    store.tx((w) =>
      Effect.gen(function* () {
        const seq = yield* w.event("seed", null, {});
        yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_p', 'shop', 'prod', 'shop/prod/pods', 'ERROR checkout', 'error', 3, 1, 0, 0, ?, ?)", seq, seq);
        yield* w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'prod', 'deployed0', 'previous0')", seq);
        yield* w.run("INSERT INTO jobs (id, kind, subject, title, state, created_seq, result) VALUES ('job_p', 'investigation', 'inc_p', 'p', 'completed', ?, ?)", seq, json({ verdict: "real", observed: true, planned: 3, counts: { real: 3 }, challenge: { outcome: "upheld", reason: null }, readings: [] }));
        yield* w.run("INSERT INTO fixes (id, incident, job_id, app, environment, origin, state, previous, deployed, base, candidate, head, diff, seq, data) VALUES (?, 'inc_p', 'job_p', 'shop', 'prod', 'automatic', 'verified', 'previous0', 'deployed0', ?, ?, ?, 'diff', ?, ?)",
          ID as Clean, base as Clean, head as Clean, head as Clean, seq, json({ summary: "Restore timeout", paths: ["settings.json"], verification: [{ argv: ["true"], exitCode: 0, elapsedMs: 1, summary: "" }], repo: "local/remote" }));
        yield* w.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, 'on')", approvalKey(config) as Clean);
        yield* w.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, 'on')", fixGateKey(config, "shop") as Clean);
      }),
    ),
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OW_FAKE_HOST: host, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  return {
    root, file, config, base, head, host, remote, env,
    faults: (f: Fault[]) => writeFileSync(join(host, "faults.json"), JSON.stringify(f)),
    prs: () => (existsSync(join(host, "prs.json")) ? (JSON.parse(readFileSync(join(host, "prs.json"), "utf8")) as Array<{ headRefName: string; isDraft: boolean; baseRefName: string; body: string }>) : []),
    branches: () => git("--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean),
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;
let n = 0;
const key = () => `rk_${(++n).toString(16).padStart(24, "0")}`;
/** One keypress against the attempt, with the basis given (or the item's current one), in this process. */
const keypress = (config: Config, basis?: number | null) =>
  run(
    withStore(config.dataDir, (store) =>
      Effect.gen(function* () {
        const fixes = yield* Fixes;
        const shown = basis === undefined ? (yield* store.get<{ decided_seq: number }>("SELECT decided_seq FROM incidents WHERE id = 'inc_p'"))!.decided_seq : basis;
        const exit = yield* Effect.exit(Effect.flatMap(fixes.publication(ID, shown), (plan) => keyed(key(), plan)));
        // A refusal is thrown with its own message.
        if (Exit.isFailure(exit)) return yield* Effect.die(new Error(errorText(Cause.squash(exit.cause))));
        return exit.value.fix!;
      }).pipe(Effect.provide(Fixes.layer), withConfig(config)),
    ),
  );
/** One keypress, in this process, with the host's PATH; returns the attempt as the page then sees it. */
async function press(r: Rig, config: Config = r.config) {
  const before = { PATH: process.env.PATH, OW_FAKE_HOST: process.env.OW_FAKE_HOST };
  Object.assign(process.env, { PATH: r.env.PATH, OW_FAKE_HOST: r.host, OW_PUBLISHER_PID: String(process.pid) });
  try {
    return await keypress(config);
  } finally {
    Object.assign(process.env, before);
  }
}
/** The host holds at most one branch for the attempt (exactly the verified commit), at most one pull request, and main is untouched. */
function oneOfEach(r: Rig) {
  const branches = r.branches(), mine = branches.filter((b) => b.startsWith(`refs/heads/ow/fix/${ID} `));
  assert.ok(mine.length <= 1);
  for (const b of mine) assert.equal(b.split(" ")[1], r.head);
  assert.ok(branches.includes(`refs/heads/main ${r.base}`));
  assert.ok(r.prs().length <= 1, JSON.stringify(r.prs()));
}

test("the action: one keypress pushes the verified commit and opens one draft against main in the resolved repository", async () => {
  const r = await rig();
  const f = await press(r);
  assert.equal(f.state, "published", f.reason ?? "");
  assert.equal(f.pr?.number, 1);
  assert.equal(f.action, null);
  oneOfEach(r);
  const pr = r.prs()[0]!;
  assert.deepEqual([pr.headRefName, pr.baseRefName, pr.isDraft], [`ow/fix/${ID}`, "main", true]);
  assert.match(pr.body, new RegExp(`overwatch-attempt: ${ID}`));
  const calls = readFileSync(join(r.host, "gh.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  for (const c of calls.filter((c) => c[0] === "pr")) assert.equal(c[c.indexOf("--repo") + 1], "local/remote");
  // A repeat after success changes nothing on the host.
  assert.equal((await press(r)).state, "published");
  oneOfEach(r);
});

test("the action: protection that is set or unknown stops before the push; nothing is on the host and the reason says so", async () => {
  for (const mode of ["protected", "unknown"] as const) {
    const r = await rig();
    r.faults([{ op: "protect", mode }]);
    const f = await press(r);
    assert.equal(f.state, "verified");
    assert.match(f.reason!, /Stopped at protection check: .*nothing was pushed.*On the host: nothing/);
    assert.deepEqual(r.branches(), [`refs/heads/main ${r.base}`]);
    assert.equal((await press(r)).state, "published"); // read positively again on the next keypress
    oneOfEach(r);
  }
});

test("the action: a base that moved stops it before anything is pushed and offers to derive again", async () => {
  const r = await rig();
  const work = join(r.root, "work");
  execFileSync(REAL_GIT, ["-C", work, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "someone merged"]);
  execFileSync(REAL_GIT, ["-C", work, "push", "-q", r.remote, "HEAD:refs/heads/main"]);
  const f = await press(r);
  assert.equal(f.state, "stale");
  assert.match(f.reason!, /main moved from .* Press f to derive again\. On the host: nothing\./);
  assert.equal(r.prs().length, 0);
  assert.equal(r.branches().some((b) => b.includes("ow/fix/")), false);
  assert.equal(f.action, null);
});

test("the action: refused before any host step when the item was decided since, put away, a gate fell or a newer rollout came", async () => {
  const cases: Array<[string, (s: StoreShape) => Effect.Effect<unknown, unknown>, RegExp]> = [
    ["put away", (s) => s.tx((w) => w.run("UPDATE incidents SET way = '{\"kind\":\"done\"}' WHERE id = 'inc_p'")), /put away/],
    ["gate", (s) => s.tx((w) => w.run("DELETE FROM meta")), /trial/],
    ["rollout", (s) => s.tx((w) => Effect.flatMap(w.event("seed", null, {}), (seq) => w.run("INSERT INTO deploys (seq, app, environment, revision, previous) VALUES (?, 'shop', 'prod', 'newer0', 'deployed0')", seq))), /newer deployment/],
  ];
  for (const [what, alter, why] of cases) {
    const r = await rig();
    await change(r.config.dataDir, alter);
    await assert.rejects(press(r), (e: Error) => why.test(e.message), what);
    assert.equal(existsSync(join(r.host, "gh.jsonl")), false, `${what}: the host was asked`);
  }
  const r = await rig();
  await assert.rejects(keypress(r.config, 99), /decided again/);
  await assert.rejects(keypress(r.config, null), /basisSeq/);
});

test("class: whatever fails at whichever step, a repeat never makes a second branch or pull request, and once the host answers it is published", async () => {
  const fault = fc.record({ op: fc.constantFrom("protect", "list", "create", "push"), mode: fc.constantFrom("before", "after") }) as fc.Arbitrary<Fault>;
  await fc.assert(
    fc.asyncProperty(fc.array(fault, { maxLength: 6 }), async (faults) => {
      const r = await rig();
      r.faults(faults);
      let f;
      for (let i = 0; i < faults.length + 2; i++) {
        f = await press(r);
        oneOfEach(r);
        if (f.state === "published") break;
        assert.equal(f.state, "verified");
        assert.match(f.reason!, /^Stopped at .*On the host: .*Press P/);
      }
      assert.equal(f!.state, "published", `${JSON.stringify(faults)}: ${f!.reason}`);
      assert.equal(r.prs().length, 1);
      assert.equal(r.branches().filter((b) => b.includes("ow/fix/")).length, 1);
    }),
    { numRuns: 12 },
  );
});

// A crash at each host step: a child process presses, the fake host kills it before or after the step's effect,
// and a second keypress in a fresh process reconciles from the host and finishes with one branch and one draft.
const CHILD = fileURLToPath(new URL("./publish-child.ts", import.meta.url));
for (const op of ["protect", "push", "list", "create"] as const) {
  for (const mode of ["killbefore", "kill"] as const) {
    test(`probe: killed ${mode === "kill" ? "after" : "before"} the ${op} step, the next keypress finishes with one branch and one draft`, async () => {
      const r = await rig();
      r.faults([{ op, mode }]);
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, r.file, ID], { env: r.env, encoding: "utf8" });
      assert.equal(child.signal, "SIGKILL", child.stderr);
      const step = await run(withStore(r.config.dataDir, (s) => Effect.map(s.get<{ data: string }>("SELECT data FROM fixes WHERE id = ?", ID), (row) => (JSON.parse(row!.data) as { step?: string }).step)));
      assert.ok(step, "the step's intent is recorded before it runs");
      oneOfEach(r);
      const f = await press(r);
      assert.equal(f.state, "published", f.reason ?? "");
      oneOfEach(r);
      assert.equal(r.prs().length, 1);
    });
  }
}
