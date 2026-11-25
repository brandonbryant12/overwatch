import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Exec } from "./exec.ts";

const GIT_TIMEOUT = 120_000;

async function git(exec: Exec, cwd: string, args: string[], signal?: AbortSignal) {
  return exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT, ...(signal ? { signal } : {}) });
}

/** True when `directory` is neither the checkout nor a directory the checkout lives inside. */
export function isolated(directory: string, checkout: string): boolean {
  const a = resolve(directory);
  const b = resolve(checkout);
  return a !== b && relative(a, b).startsWith("..");
}

/** Resolves a commit or ref to a full SHA in the checkout, fetching it once if it is not there yet. */
export async function resolveCommit(exec: Exec, checkout: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
  const look = async () => {
    const result = await git(exec, checkout, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal);
    return result.code === 0 ? result.stdout.trim() : undefined;
  };
  if (ref.startsWith("-")) return undefined;
  const found = await look();
  if (found) return found;
  if (!/^[\w./-]+$/.test(ref)) return undefined;
  await git(exec, checkout, ["fetch", "--quiet", "origin", ref], signal);
  return look();
}

/**
 * A detached worktree of the app at `commit`, so an investigation reads the code that is deployed rather than
 * whatever the checkout has. Each investigation gets its own and removes it when it finishes.
 */
export async function addWorktree(exec: Exec, checkout: string, directory: string, commit: string, signal?: AbortSignal): Promise<string> {
  await mkdir(dirname(directory), { recursive: true });
  await git(exec, checkout, ["worktree", "prune"], signal);
  const added = await git(exec, checkout, ["worktree", "add", "--force", "--detach", directory, commit], signal);
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim().slice(0, 300)}`);
  return directory;
}

/** Removes a worktree and, when given, the local branch it was on. Never fails: leftovers are swept later. */
export async function removeWorktree(exec: Exec, checkout: string, directory: string, branch?: string): Promise<void> {
  // The checkout is the operator's own working copy. Nothing here may ever delete it or a parent of it.
  if (!isolated(directory, checkout)) return;
  const removed = await git(exec, checkout, ["worktree", "remove", "--force", directory]);
  if (removed.code !== 0) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await git(exec, checkout, ["worktree", "prune"]);
  }
  if (branch) await git(exec, checkout, ["branch", "-D", branch]);
}

/** Removes every worktree directly under `root` that `keep` does not claim: what a crash or an older version left. */
export async function sweepWorktrees(
  exec: Exec,
  checkout: string,
  root: string,
  keep: (name: string) => Promise<boolean>,
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || (await keep(entry.name))) continue;
    await removeWorktree(exec, checkout, join(root, entry.name));
    removed.push(entry.name);
  }
  return removed;
}

export async function defaultRef(exec: Exec, checkout: string, baseBranch: string): Promise<string> {
  const remote = await git(exec, checkout, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}^{commit}`]);
  return remote.code === 0 ? `origin/${baseBranch}` : baseBranch;
}
