/**
 * The code a session reads. A thread has one worktree per commit its sessions have read, under
 * `worktrees/<thread>/<commit>`, kept until the thread is archived so a session can be continued. A new session reads
 * the deployed commit when it can be resolved; a continued session keeps the directory it started in (OpenCode fixes a
 * session's directory), and is told when the deployment has moved on since. Each run records exactly which commit it
 * was given and whether that was the deployed one; its finding carries that record.
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

/** What code a run read: where, which commit, whether it was the deployed one, and one line saying so. */
export interface CodeBasis {
  readonly path: string;
  readonly commit: string | null;
  readonly deployed: boolean;
  readonly note: string;
}

const git = async (exec: Exec, cwd: string, args: string[]) => {
  const result = await exec("git", args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.trim();
};

const short = (commit: string) => commit.slice(0, 12);

/**
 * The worktree for a new session: at `deployedCommit` when there is one, else at the checkout's HEAD (and said so),
 * else an empty directory (and said so). Made once per thread and commit.
 */
export async function codeForNewSession(
  ports: WorktreePorts,
  threadId: string,
  checkout: string | undefined,
  deployed: { readonly commit?: string; readonly ref?: string; readonly why: string },
): Promise<CodeBasis> {
  const root = join(ports.dataDir, "worktrees", threadId);
  if (!checkout || !existsSync(join(checkout, ".git"))) {
    const path = join(root, "no-code");
    mkdirSync(path, { recursive: true });
    return { path, commit: null, deployed: false, note: "No code is available: the app's checkout is not a git repository. Work from telemetry alone." };
  }
  let commit: string;
  let note: string;
  try {
    commit = deployed.commit ?? (await git(ports.exec, checkout, ["rev-parse", "--verify", "HEAD^{commit}"]));
  } catch (error) {
    const path = join(root, "no-code");
    mkdirSync(path, { recursive: true });
    return { path, commit: null, deployed: false, note: `No code is available: the checkout's commit could not be read (${(error as Error).message.slice(0, 200)}). Work from telemetry alone.` };
  }
  // A directory is the commit's code only when git says so: its HEAD is that commit and no tracked file differs. A
  // directory that exists is not taken on trust; one that fails the check is removed and made again.
  const path = join(root, short(commit));
  const isCommit = async () =>
    existsSync(path) &&
    (await git(ports.exec, path, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "")) === commit &&
    (await git(ports.exec, path, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "dirty")) === "";
  if (!(await isCommit())) {
    try {
      if (existsSync(path)) {
        await git(ports.exec, checkout, ["worktree", "remove", "--force", path]).catch(() => undefined);
        rmSync(path, { recursive: true, force: true });
        await git(ports.exec, checkout, ["worktree", "prune"]).catch(() => undefined);
      }
      mkdirSync(root, { recursive: true });
      await git(ports.exec, checkout, ["worktree", "add", "--detach", path, commit]);
      if (!(await isCommit())) throw new Error(`the worktree at ${path} is not at ${short(commit)}`);
    } catch (error) {
      rmSync(path, { recursive: true, force: true });
      const fallback = join(root, "no-code");
      mkdirSync(fallback, { recursive: true });
      return { path: fallback, commit: null, deployed: false, note: `No code is available: the worktree could not be made (${(error as Error).message.slice(0, 200)}). Work from telemetry alone.` };
    }
  }
  await ports.atomically((db) =>
    db.prepare("INSERT OR IGNORE INTO code_worktrees (thread_id, path, checkout, commit_sha, created_at) VALUES (?, ?, ?, ?, ?)").run(threadId, path, checkout, commit, Date.now()),
  );
  note = deployed.commit
    ? `The working directory is the app's code at the deployed commit ${short(commit)}. Cite code as path:line from here.`
    : `The working directory is the checkout's HEAD ${short(commit)}, NOT the deployed code: ${
        deployed.ref ? `the deployed revision ${deployed.ref} was not found in the checkout` : `the deployed revision is unknown (${deployed.why})`
      }. Treat code citations as about this commit only.`;
  return { path, commit, deployed: deployed.commit !== undefined, note };
}

/** A continued session keeps its directory; whether it is still the deployed code is decided now. */
export function codeForContinuedSession(previous: CodeBasis, deployedCommit: string | undefined): CodeBasis {
  if (!previous.commit) return previous;
  if (deployedCommit === previous.commit) {
    return { ...previous, deployed: true, note: `The working directory is the app's code at the deployed commit ${short(previous.commit)}.` };
  }
  return {
    ...previous,
    deployed: false,
    note: deployedCommit
      ? `This session's working directory is still at ${short(previous.commit)}; the deployed commit is now ${short(deployedCommit)}. Code citations are about ${short(previous.commit)}; ask in a new session to read the deployed code.`
      : `This session's working directory is at ${short(previous.commit)}; which commit is deployed now is unknown.`,
  };
}

/** Removes every worktree a thread's sessions read. Called when the thread is archived. */
export async function removeWorktrees(ports: WorktreePorts, threadId: string): Promise<void> {
  const rows = await ports.atomically(
    (db) => db.prepare("SELECT path, checkout FROM code_worktrees WHERE thread_id = ?").all(threadId) as Array<{ path: string; checkout: string | null }>,
  );
  for (const row of rows) {
    if (row.checkout) await git(ports.exec, row.checkout, ["worktree", "remove", "--force", row.path]).catch(() => undefined);
    rmSync(row.path, { recursive: true, force: true });
  }
  rmSync(join(ports.dataDir, "worktrees", threadId), { recursive: true, force: true });
  await ports.atomically((db) => db.prepare("DELETE FROM code_worktrees WHERE thread_id = ?").run(threadId));
}
