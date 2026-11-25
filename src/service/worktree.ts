/**
 * Each thread's sessions work in a directory of their own: a git worktree of the app's checkout at the commit it
 * was created from, or an empty directory when there is no checkout to read. It is kept until the thread is archived,
 * so a session can be continued later, and it can be recreated at the same commit.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Exec } from "../collect/exec.ts";

export interface WorktreePorts {
  readonly exec: Exec;
  readonly dataDir: string;
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
}

const git = async (exec: Exec, cwd: string, args: string[]) => {
  const result = await exec("git", args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.trim();
};

export async function ensureWorktree(ports: WorktreePorts, threadId: string, checkout: string | undefined): Promise<string> {
  const known = await ports.atomically(
    (db) => db.prepare("SELECT path, checkout, commit_sha FROM worktrees WHERE thread_id = ?").get(threadId) as { path: string; checkout: string | null; commit_sha: string | null } | undefined,
  );
  const path = known?.path ?? join(ports.dataDir, "worktrees", threadId);
  if (known && existsSync(path)) return path;
  mkdirSync(join(ports.dataDir, "worktrees"), { recursive: true });
  let commit = known?.commit_sha ?? null;
  let source: string | null = null;
  if (checkout && existsSync(join(checkout, ".git"))) {
    try {
      commit ??= await git(ports.exec, checkout, ["rev-parse", "HEAD"]);
      await git(ports.exec, checkout, ["worktree", "add", "--detach", path, commit]);
      source = checkout;
    } catch {
      source = null;
    }
  }
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  await ports.atomically((db) =>
    db
      .prepare("INSERT INTO worktrees (thread_id, path, checkout, commit_sha, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET path = excluded.path, checkout = excluded.checkout, commit_sha = excluded.commit_sha")
      .run(threadId, path, source, source ? commit : null, Date.now()),
  );
  return path;
}

/** Removes a thread's worktree and forgets it. Called when the thread is archived. */
export async function removeWorktree(ports: WorktreePorts, threadId: string): Promise<void> {
  const known = await ports.atomically(
    (db) => db.prepare("SELECT path, checkout FROM worktrees WHERE thread_id = ?").get(threadId) as { path: string; checkout: string | null } | undefined,
  );
  if (!known) return;
  if (known.checkout) await git(ports.exec, known.checkout, ["worktree", "remove", "--force", known.path]).catch(() => undefined);
  rmSync(known.path, { recursive: true, force: true });
  await ports.atomically((db) => db.prepare("DELETE FROM worktrees WHERE thread_id = ?").run(threadId));
}
