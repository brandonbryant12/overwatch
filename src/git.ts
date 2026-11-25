import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.ts";

const GIT_TIMEOUT = 120_000;

async function git(exec: Exec, cwd: string, args: string[], signal?: AbortSignal) {
  return exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT, ...(signal ? { signal } : {}) });
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
 * A detached worktree of the app at `commit`, so investigations read the code that is deployed rather than
 * whatever the checkout has. Worktrees are reused per commit and the oldest are removed beyond `keep`.
 */
export async function worktreeAt(
  exec: Exec,
  checkout: string,
  root: string,
  commit: string,
  keep = 5,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const directory = join(root, commit.slice(0, 12));
  const existing = await git(exec, directory, ["rev-parse", "HEAD"], signal);
  if (existing.code === 0 && existing.stdout.trim() === commit) return directory;
  await git(exec, checkout, ["worktree", "prune"], signal);
  const added = await git(exec, checkout, ["worktree", "add", "--force", "--detach", directory, commit], signal);
  if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim().slice(0, 300)}`);
  await pruneWorktrees(exec, checkout, root, keep, directory);
  return directory;
}

async function pruneWorktrees(exec: Exec, checkout: string, root: string, keep: number, current: string) {
  const entries = await readdir(root).catch(() => [] as string[]);
  const dated = await Promise.all(
    entries
      .filter((name) => /^[0-9a-f]{12}$/.test(name))
      .map(async (name) => ({ path: join(root, name), mtime: (await stat(join(root, name))).mtimeMs })),
  );
  const stale = dated.filter((d) => d.path !== current).sort((a, b) => b.mtime - a.mtime).slice(Math.max(0, keep - 1));
  for (const entry of stale) await git(exec, checkout, ["worktree", "remove", "--force", entry.path]);
}

export async function defaultRef(exec: Exec, checkout: string, baseBranch: string): Promise<string> {
  const remote = await git(exec, checkout, ["rev-parse", "--verify", "--quiet", `origin/${baseBranch}^{commit}`]);
  return remote.code === 0 ? `origin/${baseBranch}` : baseBranch;
}
