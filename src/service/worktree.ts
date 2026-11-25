/**
 * Each thread's sessions work in a directory of their own: a git worktree of the app's checkout at the commit it
 * was created from, or an empty directory when there is no checkout to read. It is kept until the thread is archived,
 * so a session can be continued later, and it can be recreated at the same commit.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Exec } from "../collect/exec.ts";
import { resolveCommit } from "./deploy.ts";

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

/** What code a thread's sessions read: where, at which commit, and whether that is what is deployed. */
export interface CodeBasis {
  readonly path: string;
  readonly commit: string | null;
  readonly deployed: boolean;
  /** One line for the brief and the finding, saying exactly what the code is. */
  readonly note: string;
}

/**
 * The thread's worktree, made once at the deployed commit when it can be resolved. When it cannot, the code is the
 * checkout's HEAD and the note says plainly it is not the deployed code; when there is no git checkout at all, the
 * directory is empty and the note says no code is available. Nothing is silent.
 */
export async function ensureWorktree(
  ports: WorktreePorts,
  threadId: string,
  checkout: string | undefined,
  deployedRef?: { readonly ref?: string; readonly why?: string },
): Promise<CodeBasis> {
  const known = await ports.atomically(
    (db) =>
      db.prepare("SELECT path, checkout, commit_sha, deployed, note FROM worktrees WHERE thread_id = ?").get(threadId) as
        | { path: string; checkout: string | null; commit_sha: string | null; deployed: number; note: string | null }
        | undefined,
  );
  if (known && existsSync(known.path)) {
    return { path: known.path, commit: known.commit_sha, deployed: known.deployed === 1, note: known.note ?? "No note was recorded for this code." };
  }
  const path = known?.path ?? join(ports.dataDir, "worktrees", threadId);
  mkdirSync(join(ports.dataDir, "worktrees"), { recursive: true });
  let commit: string | null = known?.commit_sha ?? null;
  let deployed = known?.deployed === 1;
  let note: string;
  let source: string | null = null;
  if (checkout && existsSync(join(checkout, ".git"))) {
    try {
      if (commit === null && deployedRef?.ref) {
        const resolved = await resolveCommit(ports.exec, checkout, deployedRef.ref);
        if (resolved) {
          commit = resolved;
          deployed = true;
        }
      }
      if (commit === null) commit = await git(ports.exec, checkout, ["rev-parse", "--verify", "HEAD^{commit}"]);
      await git(ports.exec, checkout, ["worktree", "add", "--detach", path, commit]);
      source = checkout;
      note = deployed
        ? `The working directory is the app's code at the deployed commit ${commit.slice(0, 12)}. Cite code as path:line from here.`
        : `The working directory is the checkout's HEAD ${commit.slice(0, 12)}, NOT the deployed code: ${
            deployedRef?.ref ? `the deployed revision ${deployedRef.ref} was not found in the checkout` : `the deployed revision is unknown (${deployedRef?.why ?? "nothing reports it"})`
          }. Treat code citations as about this commit only.`;
    } catch (error) {
      commit = null;
      deployed = false;
      note = `No code is available: the worktree could not be made (${(error as Error).message.slice(0, 200)}). Work from telemetry alone.`;
    }
  } else {
    note = "No code is available: the app's checkout is not a git repository. Work from telemetry alone.";
  }
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  await ports.atomically((db) =>
    db
      .prepare(
        "INSERT INTO worktrees (thread_id, path, checkout, commit_sha, created_at, deployed, note) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (thread_id) DO UPDATE SET path = excluded.path, checkout = excluded.checkout, commit_sha = excluded.commit_sha, deployed = excluded.deployed, note = excluded.note",
      )
      .run(threadId, path, source, source ? commit : null, Date.now(), deployed && source ? 1 : 0, note),
  );
  return { path, commit: source ? commit : null, deployed: deployed && source !== null, note };
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
