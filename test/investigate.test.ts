import { afterAll, describe, expect, test } from "./harness.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec.ts";
import { createInvestigator, fileFinding, recordEvidence, type Host } from "../src/investigate.ts";
import { keys, readRecord, type InvestigationRecord } from "../src/store.ts";
import type { InvestigationRequest } from "../src/sweep.ts";
import { fakeExec, options, realFinding, runtime } from "./helpers.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "overwatch-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

/** An app repo with a local bare remote: the deployed commit has a bug, main moved on since. */
function appRepo(name: string) {
  const remote = join(root, `${name}.git`);
  const checkout = join(root, name);
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, checkout], { stdio: "ignore" });
  git(checkout, "checkout", "-q", "-b", "main");
  // Fixes commit with the repository's own identity, as they would on the user's machine.
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) {
    git(checkout, "config", key!, value!);
  }
  writeFileSync(join(checkout, "CHANGELOG.md"), "first release\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first release");
  const initial = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "payments.ts"), "export const TIMEOUT_MS = 300\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "lower the payments timeout");
  const deployed = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "README.md"), "later work\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "later");
  git(checkout, "push", "-q", "origin", "main");
  writeFileSync(join(checkout, "payments.ts"), "uncommitted local edit\n");
  // What an operator's checkout really holds: credentials that were never committed.
  writeFileSync(join(checkout, "service-account.json"), '{"private_key": "not for agents"}\n');
  return { remote, checkout, deployed, initial };
}

interface FakeAgent {
  (role: "investigator" | "fixer", directory: string, text: string, sessionID: string): Promise<void>;
}

/** A host whose "agent" runs a scripted function instead of a model. */
function fakeHost(rt: ReturnType<typeof runtime>, agent: FakeAgent) {
  const sessions = new Map<string, { agent: string; directory: string; prompts: string[] }>();
  const shown: Array<{ sessionID: string; text: string }> = [];
  const notes: string[] = [];
  let next = 0;
  let work = Promise.resolve();
  const host: Host = {
    async createSession({ agent, directory }) {
      const id = `ses_${++next}`;
      sessions.set(id, { agent, directory, prompts: [] });
      return id;
    },
    async prompt(sessionID, text) {
      const session = sessions.get(sessionID)!;
      session.prompts.push(text);
      work = agent(session.agent === "overwatch-fixer" ? "fixer" : "investigator", session.directory, text, sessionID);
    },
    waitIdle: () => work,
    interrupt: async () => undefined,
    show: async (sessionID, text) => void shown.push({ sessionID, text }),
    notify: async (title, body) => void notes.push(`${title}: ${body}`),
  };
  return { host, sessions, notes, shown };
}

function request(overrides: Partial<InvestigationRequest> = {}): InvestigationRequest {
  return {
    title: "payment timeouts",
    brief: "- payment timed out [errors, log] 12 occurrence(s)",
    app: "shop-api",
    environment: "production",
    window: { from: Date.parse("2026-11-25T09:00:00Z"), to: Date.parse("2026-11-25T12:00:00Z") },
    coverage: [],
    skills: ["k8s-debugging"],
    fix: false,
    trigger: { type: "watcher", watcherId: "shop-api/production", incidentIds: ["inc_1"] },
    ...overrides,
  };
}

function config(checkout: string, extra: Record<string, unknown> = {}) {
  return options({
    apps: {
      "shop-api": {
        checkout,
        verify: ["grep -q 3000 payments.ts"],
        environments: { production: { sources: { ci: { type: "github-ci" } }, deployedCommit: { command: ["cat", "DEPLOYED"] } } },
      },
    },
    dataDir: join(root, "data"),
    notify: false,
    ...extra,
  });
}

/** Worktrees git still knows for a checkout (the checkout itself is always the first). */
const worktrees = (checkout: string) => git(checkout, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
/** Worktree directories left on disk under a data directory. */
const leftovers = (dataDir = join(root, "data")) =>
  existsSync(join(dataDir, "worktrees", "shop-api")) ? readdirSync(join(dataDir, "worktrees", "shop-api")) : [];

/** Real git; `cat DEPLOYED` stands in for asking what is deployed; `gh` is faked and recorded. */
function execFor(deployed: string, prUrl = "https://example.invalid/pr/1") {
  return fakeExec(({ command, args }) => {
    if (command === "cat" && args[0] === "DEPLOYED") return { stdout: `${deployed}\n` };
    if (command === "gh") return { stdout: `${prUrl}\n` };
    return undefined;
  }, realExec);
}

describe("investigations", () => {
  test("read code at the deployed commit in a worktree, file a finding, render it, and post it back", async () => {
    const repo = appRepo("inv-ok");
    const exec = execFor(repo.deployed);
    const rt = runtime(config(repo.checkout), { exec });
    let seenCode = "";
    let codeDirectory = "";
    const fake = fakeHost(rt, async (_role, directory, _text, sessionID) => {
      codeDirectory = directory;
      seenCode = readFileSync(join(directory, "payments.ts"), "utf8");
      expect(git(directory, "rev-parse", "HEAD")).toBe(repo.deployed);
      expect(await fileFinding(rt, sessionID, realFinding)).toContain("Recorded");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ trigger: { type: "manual", text: "checkout broken", originSessionID: "ses_origin" } }));
    await investigator.idle();

    expect(seenCode).toBe("export const TIMEOUT_MS = 300\n");
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record).toMatchObject({ status: "done", commit: repo.deployed, finding: realFinding });
    expect(record.report).toContain(`deployed ${repo.deployed.slice(0, 12)}`);
    const session = fake.sessions.get(record.sessionID!)!;
    expect(session.agent).toBe("overwatch-investigator");
    expect(session.prompts[0]).toContain(`deployed commit ${repo.deployed.slice(0, 12)}`);
    expect(session.prompts[0]).toContain("Skills to use: k8s-debugging.");
    expect(fake.shown).toEqual([{ sessionID: "ses_origin", text: record.report! }]);
    expect(fake.notes[0]).toBe(
      "Overwatch: Real · shop-api/production: Some card payments fail at checkout. Affected: customers paying by card. Since: 2026-11-25 10:05 UTC. Status: ongoing.",
    );
    expect(exec.calls.some((c) => c.command === "gh")).toBe(false);
    // The code copy is gone once the investigation is done; only the checkout remains.
    expect(codeDirectory).toBe(join(root, "data", "worktrees", "shop-api", id));
    expect(existsSync(codeDirectory)).toBe(false);
    expect(worktrees(repo.checkout)).toHaveLength(1);
  });

  test("a failed investigation removes its worktree too", async () => {
    const repo = appRepo("inv-throws");
    const rt = runtime(config(repo.checkout), { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async () => undefined);
    fake.host.prompt = async () => {
      throw new Error("server went away");
    };
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record).toMatchObject({ status: "failed", error: "server went away" });
    expect(leftovers()).toEqual([]);
    expect(worktrees(repo.checkout)).toHaveLength(1);
  });

  test("worktrees left by a crash or an older version are swept; a live run keeps its own", async () => {
    const repo = appRepo("inv-sweep");
    const dataDir = join(root, "data-sweep");
    const rt = runtime(config(repo.checkout, { dataDir }), { exec: execFor(repo.deployed) });
    const dir = (name: string) => join(dataDir, "worktrees", "shop-api", name);
    for (const name of [repo.deployed.slice(0, 12), "inv_done", "fix-inv_done", "inv_dead", "inv_live"]) {
      git(repo.checkout, "worktree", "add", "-q", "--detach", dir(name), repo.deployed);
    }
    const base = { title: "t", trigger: { type: "manual", text: "t" }, app: "shop-api", window: { from: 0, to: 1 }, coverage: [] };
    await rt.kv.set(keys.investigation("inv_done"), { ...base, id: "inv_done", status: "done", createdAt: rt.clock.now });
    await rt.kv.set(keys.investigation("inv_dead"), { ...base, id: "inv_dead", status: "running", createdAt: 0, startedAt: rt.clock.now - 24 * 3_600_000 });
    await rt.kv.set(keys.investigation("inv_live"), { ...base, id: "inv_live", status: "running", createdAt: 0, startedAt: rt.clock.now - 60_000 });

    const fake = fakeHost(rt, async (_r, _d, _t, sessionID) => void (await fileFinding(rt, sessionID, realFinding)));
    const investigator = createInvestigator(rt, fake.host);
    await investigator.start(request());
    await investigator.idle();

    expect(leftovers(dataDir)).toEqual(["inv_live"]);
    expect(worktrees(repo.checkout)).toEqual([`worktree ${repo.checkout}`, `worktree ${dir("inv_live")}`]);
  });

  test("an agent that never files a finding is nudged once, then reported as unsure", async () => {
    const repo = appRepo("inv-silent");
    const rt = runtime(config(repo.checkout), { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async () => undefined);
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.status).toBe("failed");
    expect(record.finding?.engineering.verdict).toBe("unsure");
    expect(fake.sessions.get(record.sessionID!)!.prompts).toHaveLength(2);
  });

  test("an unknown deployed commit falls back to the base branch and the report says so", async () => {
    const repo = appRepo("inv-unknown");
    const rt = runtime(config(repo.checkout), { exec: execFor("0000000") });
    const fake = fakeHost(rt, async (_r, _d, _t, sessionID) => void (await fileFinding(rt, sessionID, realFinding)));
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.coverage[0]).toContain("code read at origin/main");
    expect(record.coverage[0]).toContain("deployed ref 0000000 was not found");
    expect(record.report).toContain("Not checked: code read at origin/main");
  });

  test("findings from sessions that are not investigations are refused", async () => {
    const rt = runtime(config(root));
    expect(await fileFinding(rt, "ses_random", realFinding)).toContain("not an Overwatch investigation");
  });
});

describe("the investigator never works in the operator's checkout", () => {
  const telemetryOnly = { ...realFinding, engineering: { ...realFinding.engineering, evidence: [{ source: "errors", quote: "payment 42 timed out after 300ms" }], codeLocation: undefined } };

  test("when the worktree cannot be created the session gets an empty directory, and the report says the code was not read", async () => {
    const repo = appRepo("inv-noworktree");
    const exec = fakeExec(({ command, args }) => {
      if (command === "cat" && args[0] === "DEPLOYED") return { stdout: `${repo.deployed}\n` };
      if (command === "git" && args[0] === "worktree" && args[1] === "add") return { code: 128, stderr: "fatal: could not create leading directories" };
      return undefined;
    }, realExec);
    const rt = runtime(config(repo.checkout), { exec });
    let directory = "";
    let listing: string[] = ["unset"];
    const answers: string[] = [];
    const fake = fakeHost(rt, async (_role, dir, _text, sessionID) => {
      directory = dir;
      listing = readdirSync(dir);
      answers.push(await fileFinding(rt, sessionID, realFinding));
      answers.push(await fileFinding(rt, sessionID, telemetryOnly));
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();

    expect(directory).toBe(join(root, "data", "worktrees", "shop-api", id));
    expect(directory).not.toContain(repo.checkout);
    expect(listing).toEqual([]);
    expect(existsSync(join(repo.checkout, "service-account.json"))).toBe(true);
    expect(answers[0]).toContain("this investigation has no code to read");
    expect(answers[1]).toContain("Recorded");
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.status).toBe("done");
    expect(record.commit).toBeUndefined();
    expect(record.report).toContain("Not checked: code not read: git worktree add failed: fatal: could not create leading directories");
    expect(fake.sessions.get(record.sessionID!)!.prompts[0]).toContain("No code is available for this investigation");
    expect(leftovers()).toEqual([]);
  });

  test("a checkout with no commit to read gets an empty directory too, never the checkout itself", async () => {
    const plain = join(root, "not-a-repo");
    mkdirSync(plain);
    writeFileSync(join(plain, ".env.local"), "API_KEY=not-for-agents\n");
    const rt = runtime(config(plain), { exec: execFor("0000000") });
    let directory = "";
    const fake = fakeHost(rt, async (_role, dir, _text, sessionID) => {
      directory = dir;
      expect(readdirSync(dir)).toEqual([]);
      await fileFinding(rt, sessionID, telemetryOnly);
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    expect(directory).toBe(join(root, "data", "worktrees", "shop-api", id));
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.coverage.join("\n")).toContain("code not read: no commit of shop-api could be resolved in its checkout");
    // The clean-up removed the empty directory and left the "checkout" alone.
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(join(plain, ".env.local"), "utf8")).toBe("API_KEY=not-for-agents\n");
  });
});

describe("citations are checked against what the investigation was shown", () => {
  const finding = (evidence: Array<{ source: string; quote: string }>, codeLocation?: string) => ({
    ...realFinding,
    engineering: { ...realFinding.engineering, evidence, codeLocation },
  });

  test("a made-up line, a line that is not in the file and a location past the end of the file are sent back", async () => {
    const repo = appRepo("inv-cite");
    const rt = runtime(config(repo.checkout), { exec: execFor(repo.deployed) });
    const answers: string[] = [];
    const fake = fakeHost(rt, async (_role, _dir, _text, sessionID) => {
      await recordEvidence(rt, sessionID, "ci", "overwatch_query ci\n812 2026-11-25T10:00:00Z deploy main@abc1234 Deploy to production failed");
      answers.push(await fileFinding(rt, sessionID, finding([{ source: "ci", quote: "Deploy to production succeeded" }])));
      answers.push(await fileFinding(rt, sessionID, finding([{ source: "payments.ts", quote: "const TIMEOUT_MS = 3000" }])));
      answers.push(await fileFinding(rt, sessionID, finding([{ source: "payments.ts", quote: "TIMEOUT_MS = 300" }], "payments.ts:40")));
      answers.push(await fileFinding(rt, sessionID, finding([{ source: "payments.ts", quote: "TIMEOUT_MS = 300" }], "../../../etc/passwd:1")));
      answers.push(
        await fileFinding(
          rt,
          sessionID,
          finding(
            [
              { source: "ci", quote: "deploy main@abc1234 ... failed" },
              { source: "payments.ts:1", quote: "export const   TIMEOUT_MS = 300" },
              { source: "k8s-debugging skill", quote: "Last State: Terminated, Reason: OOMKilled" },
            ],
            "payments.ts:1",
          ),
        ),
      );
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();

    expect(answers[0]).toContain('engineering.evidence[0]: the quote is not in anything source "ci" returned');
    expect(answers[1]).toContain("engineering.evidence[0]: the quote is not in payments.ts");
    expect(answers[2]).toContain("payments.ts has 1 line(s); payments.ts:40 is outside it");
    expect(answers[3]).toContain("is not a file in the working directory");
    expect(answers[4]).toContain("Recorded");
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.finding!.engineering.evidence.map((e) => e.verified)).toEqual([true, true, false]);
    expect(record.report).toContain("1. [ci] deploy main@abc1234 ... failed");
    expect(record.report).toContain("3. [k8s-debugging skill, not verified] Last State: Terminated, Reason: OOMKilled");
    // What the investigation was shown is dropped once it is over.
    expect((await rt.kv.scan({ prefix: keys.evidencePrefix(id) })).entries).toEqual([]);
  });

  test("the agent cannot mark its own quotes verified, and secrets in a finding are redacted before it is stored", async () => {
    const repo = appRepo("inv-cite-redact");
    const rt = runtime(config(repo.checkout), { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async (_role, _dir, _text, sessionID) => {
      const claimed = finding([{ source: "a tool", quote: "value k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU was rejected", verified: true } as { source: string; quote: string }]);
      expect(await fileFinding(rt, sessionID, claimed)).toContain("Recorded");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.finding!.engineering.evidence[0]!.verified).toBe(false);
    expect(record.report).not.toContain("k8Hq2ZpL9xVb3NcR7tYw5MdF1sGj4AeU");
    expect(record.report).toContain("[a tool, not verified] value [REDACTED:high_entropy:");
  });
});

describe("the brief says what is deployed and since when", () => {
  test("running revisions, when the rollout began, what it replaced and the commits it brought in", async () => {
    const repo = appRepo("inv-deploy");
    const pod = (name: string) => ({
      metadata: { name, labels: { app: "shop-api" }, ownerReferences: [{ kind: "ReplicaSet", name: "shop-api-new" }] },
      spec: { containers: [{ name: "api", image: `registry.example/shop-api:${repo.deployed}` }] },
      status: { phase: "Running", startTime: "2026-11-25T09:59:00Z", containerStatuses: [{ name: "api", restartCount: name.endsWith("1") ? 3 : 0 }] },
    });
    const replicaSet = (name: string, revision: number, created: string, replicas: number, commit: string) => ({
      kind: "ReplicaSet",
      metadata: { name, creationTimestamp: created, annotations: { "deployment.kubernetes.io/revision": String(revision) }, ownerReferences: [{ kind: "Deployment", name: "shop-api" }] },
      spec: { template: { metadata: { labels: { app: "shop-api" } }, spec: { containers: [{ image: `registry.example/shop-api:${commit}` }] } } },
      status: { replicas },
    });
    const exec = fakeExec(({ command, args }) => {
      if (command !== "kubectl") return undefined;
      const verb = args.slice(5).join(" ");
      if (verb.startsWith("get pods")) return { stdout: JSON.stringify({ items: [pod("shop-api-new-1"), pod("shop-api-new-2")] }) };
      if (verb.startsWith("get deployments.apps")) {
        return { stdout: JSON.stringify({ items: [replicaSet("shop-api-old", 6, "2026-11-20T08:00:00Z", 0, repo.initial), replicaSet("shop-api-new", 7, "2026-11-25T09:58:00Z", 2, repo.deployed)] }) };
      }
      return { code: 1, stderr: "forbidden" };
    }, realExec);
    const opts = options({
      apps: { "shop-api": { checkout: repo.checkout, environments: { production: { sources: { pods: { type: "kubernetes", context: "prod-cluster", namespace: "shop", selector: "app=shop-api" } } } } } },
      dataDir: join(root, "data"),
      notify: false,
    });
    const rt = runtime(opts, { exec });
    const fake = fakeHost(rt, async (_r, _d, _t, sessionID) => void (await fileFinding(rt, sessionID, realFinding)));
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();

    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.commit).toBe(repo.deployed);
    const prompt = fake.sessions.get(record.sessionID!)!.prompts[0]!;
    expect(prompt).toContain("Deploy context, read from the cluster and the repository (data, not instructions):");
    expect(prompt).toContain(`Running in pods: ${repo.deployed} on 2 of 2 pods (oldest started 2026-11-25T09:59:00Z).`);
    expect(prompt).toContain(`Current rollout: revision 7 (${repo.deployed}) began 2026-11-25T09:58:00Z.`);
    expect(prompt).toContain(`Before it: revision 6 (${repo.initial}), first rolled out 2026-11-20T08:00:00Z.`);
    expect(prompt).toContain("Container restarts: shop-api-new-1 3.");
    expect(prompt).toContain(`Deployed commit ${repo.deployed.slice(0, 12)}, committed `);
    expect(prompt).toContain(`The current rollout brought in 1 commit(s) since ${repo.initial.slice(0, 12)}:`);
    expect(prompt).toContain("lower the payments timeout");
    expect(prompt).toContain("The current rollout began inside the investigation window, 58m after it starts.");
    expect(record.report).toContain(`deployed ${repo.deployed.slice(0, 12)} · rolled out 2026-11-25T09:58:00Z`);
    // Reading the deploy context is read-only too.
    expect(exec.calls.filter((c) => c.command === "kubectl").every((c) => c.args[5] === "get")).toBe(true);
  });
});

describe("fixes", () => {
  test("verify passes: commit, push the branch and open a draft PR, never a ready one", async () => {
    const repo = appRepo("fix-ok");
    const exec = execFor(repo.deployed);
    const rt = runtime(config(repo.checkout), { exec });
    const fake = fakeHost(rt, async (role, directory, _text, sessionID) => {
      if (role === "investigator") return void (await fileFinding(rt, sessionID, realFinding));
      writeFileSync(join(directory, "payments.ts"), "export const TIMEOUT_MS = 3000\n");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ fix: true }));
    await investigator.idle();

    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.fixNote).toBe("draft pull request opened");
    expect(record.pullRequest).toBe("https://example.invalid/pr/1");
    expect(record.report).toContain("Draft PR: https://example.invalid/pr/1");
    const gh = exec.calls.filter((c) => c.command === "gh");
    expect(gh).toHaveLength(1);
    expect(gh[0]!.args.slice(0, 3)).toEqual(["pr", "create", "--draft"]);
    expect(gh.flatMap((c) => c.args)).not.toContain("merge");
    const branch = `overwatch/${id.slice(4)}`;
    expect(git(repo.remote, "log", "-1", "--format=%s", branch)).toStartWith("fix: The payments client timeout");
    // The fix branched from main, not from the deployed commit or the dirty checkout.
    expect(git(repo.remote, "show", `${branch}:README.md`)).toBe("later work");
    expect(readFileSync(join(repo.checkout, "payments.ts"), "utf8")).toBe("uncommitted local edit\n");
    // Both worktrees and the local branch are gone; the pushed branch is the only copy that matters.
    expect(leftovers()).toEqual([]);
    expect(worktrees(repo.checkout)).toHaveLength(1);
    expect(git(repo.checkout, "branch", "--list", "overwatch/*")).toBe("");
  });

  test("verify fails: nothing is pushed and no PR is opened", async () => {
    const repo = appRepo("fix-fail");
    const exec = execFor(repo.deployed);
    const rt = runtime(config(repo.checkout), { exec });
    const fake = fakeHost(rt, async (role, directory, _text, sessionID) => {
      if (role === "investigator") return void (await fileFinding(rt, sessionID, realFinding));
      writeFileSync(join(directory, "payments.ts"), "export const TIMEOUT_MS = 30\n");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ fix: true }));
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.pullRequest).toBeUndefined();
    expect(record.fixNote).toContain("verify failed: `grep -q 3000 payments.ts` exited 1");
    expect(exec.calls.some((c) => c.command === "gh")).toBe(false);
    expect(exec.calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
    expect(record.fixNote).toContain("the attempt was discarded");
    expect(leftovers()).toEqual([]);
    expect(worktrees(repo.checkout)).toHaveLength(1);
    expect(git(repo.checkout, "branch", "--list", "overwatch/*")).toBe("");
  });

  test("push fails: the worktree goes, the committed fix stays on its local branch", async () => {
    const repo = appRepo("fix-nopush");
    const exec = fakeExec(({ command, args }) => {
      if (command === "cat" && args[0] === "DEPLOYED") return { stdout: `${repo.deployed}\n` };
      if (command === "git" && args[0] === "push") return { code: 1, stderr: "remote: permission denied" };
      return undefined;
    }, realExec);
    const rt = runtime(config(repo.checkout), { exec });
    const fake = fakeHost(rt, async (role, directory, _text, sessionID) => {
      if (role === "investigator") return void (await fileFinding(rt, sessionID, realFinding));
      writeFileSync(join(directory, "payments.ts"), "export const TIMEOUT_MS = 3000\n");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ fix: true }));
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    const branch = `overwatch/${id.slice(4)}`;
    expect(record.pullRequest).toBeUndefined();
    expect(record.fixNote).toContain(`the fix is committed on local branch ${branch}`);
    expect(exec.calls.some((c) => c.command === "gh")).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(worktrees(repo.checkout)).toHaveLength(1);
    expect(git(repo.checkout, "show", `${branch}:payments.ts`)).toBe("export const TIMEOUT_MS = 3000");
  });

  test("no verify commands, no pull request", async () => {
    const repo = appRepo("fix-noverify");
    const opts = config(repo.checkout);
    const rt = runtime({ ...opts, apps: { "shop-api": { ...opts.apps["shop-api"]!, verify: [] } } }, { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async (role, _d, _t, sessionID) => void (role === "investigator" && (await fileFinding(rt, sessionID, realFinding))));
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ fix: true }));
    await investigator.idle();
    const record = (await readRecord<InvestigationRecord>(rt.kv, keys.investigation(id)))!;
    expect(record.fixNote).toContain("no verify commands");
    expect([...fake.sessions.values()].some((s) => s.agent === "overwatch-fixer")).toBe(false);
    expect(existsSync(join(root, "data", "worktrees", "shop-api", `fix-${id}`))).toBe(false);
  });
});
