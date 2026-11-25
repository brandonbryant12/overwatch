import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fc from "fast-check";
import { test, expect } from "../harness.ts";
import { tempDir } from "../fixtures/support.ts";
import { backup, restore } from "../../src/service/backup.ts";
import { codeForNewSession } from "../../src/service/worktree.ts";
import { exec } from "../../src/collect/exec.ts";
import { testService, seed, join, until, databaseText } from "./support.ts";

test("failure to create a worktree cannot turn an empty directory into deployed evidence on retry", async () => {
  const repo = tempDir("pending-app");
  const dataDir = tempDir("pending-worktrees");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { encoding: "utf8" },
    ).trim();
  git("init", "-q");
  writeFileSync(join(repo, "revision.txt"), "running release");
  git("add", ".");
  git("commit", "-qm", "release");
  const commit = git("rev-parse", "HEAD");
  const f = await testService();
  let fail = true;
  try {
    const ports = {
      dataDir,
      atomically: f.service.atomically,
      exec: ((cmd, args, options) => {
        if (fail && args[0] === "worktree")
          return Promise.resolve({ code: 1, stdout: "", stderr: "fixture disk temporarily unavailable", killed: false });
        return exec(cmd, args, options);
      }) as typeof exec,
    };
    const create = () => codeForNewSession(ports, "thr_retry", repo, { commit, why: "test fixture" });
    expect((await create()).deployed).toBe(false);
    fail = false;
    const second = await create();
    expect(second.deployed).toBe(true);
    expect(existsSync(join(second.path, "revision.txt"))).toBe(true);
    expect(readFileSync(join(second.path, "revision.txt"), "utf8")).toBe("running release");
    expect(execFileSync("git", ["-C", second.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(commit);
  } finally {
    await f.service.stop();
  }
});

test("restore rejects a column-compatible schema that prevents normal writes and preserves the destination", async () => {
  const source = await testService(),
    target = await testService();
  const original = join(target.dataDir, "overwatch.sqlite");
  const file = join(tempDir("pending-invalid-backup"), "copy.sqlite");
  try {
    await seed(target);
    backup(join(source.dataDir, "overwatch.sqlite"), file);
  } finally {
    await source.service.stop();
    await target.service.stop();
  }
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE checkpoints ADD COLUMN tenant TEXT NOT NULL");
  db.close();
  expect(() => restore(file, original)).toThrow();
  const dest = new DatabaseSync(original, { readOnly: true });
  try {
    expect(dest.prepare("SELECT count(*) n FROM journal WHERE type='IncidentOpened'").get()!.n).toBe(1);
  } finally {
    dest.close();
  }
});

test("overlapping delivery ticks cannot send the same pending desktop notification twice", async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  const f = await testService({
    deps: {
      notify: async () => {
        calls++;
        await gate;
      },
    },
  });
  try {
    await seed(f);
    await until(
      async () => calls,
      (n) => n === 1,
    );
    const other = f.service.deliverNotifications();
    // Wait for the DB read used by the competing delivery before allowing the first to acknowledge.
    await f.service.read((db) => db.prepare("SELECT status FROM notified").all());
    release();
    await other;
    expect(calls).toBe(1);
  } finally {
    release();
    await f.service.stop();
  }
});

test("diagnostic errors from desktop delivery receive the same secret scrubbing as collector errors", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1000, max: 9999 }), async (n) => {
      const sentinel = "FixtureOnly" + n;
      const f = await testService({
        deps: {
          notify: async () => {
            throw Error("fixture adapter: password=" + sentinel);
          },
        },
      });
      try {
        await seed(f);
        await until(
          () => f.service.read((db) => db.prepare("SELECT attempts FROM notified LIMIT 1").get()?.attempts),
          (x) => Number(x) > 0,
        );
        expect((await f.service.read(databaseText)).includes(sentinel)).toBe(false);
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 4, seed: 62188 },
  );
});

test("a real nonzero desktop command is reported to the retry queue", async () => {
  const { macNotifier } = await import("../../src/service/notify.ts");
  if (process.platform !== "darwin") return;
  const notify = macNotifier(async () => ({ code: 1, stdout: "", stderr: "desktop temporarily unavailable", killed: false }));
  await expect(notify("fixture", "an incident opened")).rejects.toThrow();
});
