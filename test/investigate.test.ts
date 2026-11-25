import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec.ts";
import { createInvestigator, fileFinding, type Host } from "../src/investigate.ts";
import { keys, type InvestigationRecord } from "../src/store.ts";
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
  writeFileSync(join(checkout, "payments.ts"), "export const TIMEOUT_MS = 300\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "deployed");
  const deployed = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(checkout, "README.md"), "later work\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "later");
  git(checkout, "push", "-q", "origin", "main");
  writeFileSync(join(checkout, "payments.ts"), "uncommitted local edit\n");
  return { remote, checkout, deployed };
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
    const fake = fakeHost(rt, async (_role, directory, _text, sessionID) => {
      seenCode = readFileSync(join(directory, "payments.ts"), "utf8");
      expect(git(directory, "rev-parse", "HEAD")).toBe(repo.deployed);
      expect(await fileFinding(rt, sessionID, realFinding)).toContain("Recorded");
    });
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ trigger: { type: "manual", text: "checkout broken", originSessionID: "ses_origin" } }));
    await investigator.idle();

    expect(seenCode).toBe("export const TIMEOUT_MS = 300\n");
    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
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
  });

  test("an agent that never files a finding is nudged once, then reported as unsure", async () => {
    const repo = appRepo("inv-silent");
    const rt = runtime(config(repo.checkout), { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async () => undefined);
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request());
    await investigator.idle();
    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
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
    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
    expect(record.coverage[0]).toContain("code read at origin/main");
    expect(record.coverage[0]).toContain("deployed ref 0000000 was not found");
    expect(record.report).toContain("Not checked: code read at origin/main");
  });

  test("findings from sessions that are not investigations are refused", async () => {
    const rt = runtime(config(root));
    expect(await fileFinding(rt, "ses_random", realFinding)).toContain("not an Overwatch investigation");
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

    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
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
    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
    expect(record.pullRequest).toBeUndefined();
    expect(record.fixNote).toContain("verify failed: `grep -q 3000 payments.ts` exited 1");
    expect(exec.calls.some((c) => c.command === "gh")).toBe(false);
    expect(exec.calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
  });

  test("no verify commands, no pull request", async () => {
    const repo = appRepo("fix-noverify");
    const opts = config(repo.checkout);
    const rt = runtime({ ...opts, apps: { "shop-api": { ...opts.apps["shop-api"]!, verify: [] } } }, { exec: execFor(repo.deployed) });
    const fake = fakeHost(rt, async (role, _d, _t, sessionID) => void (role === "investigator" && (await fileFinding(rt, sessionID, realFinding))));
    const investigator = createInvestigator(rt, fake.host);
    const id = await investigator.start(request({ fix: true }));
    await investigator.idle();
    const record = (await rt.kv.get(keys.investigation(id))) as InvestigationRecord;
    expect(record.fixNote).toContain("no verify commands");
    expect([...fake.sessions.values()].some((s) => s.agent === "overwatch-fixer")).toBe(false);
    expect(existsSync(join(root, "data", "worktrees", "shop-api", `fix-${id}`))).toBe(false);
  });
});
