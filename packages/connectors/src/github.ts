import { ExternalCallFailed, GitHubExternal } from "@overwatch/domain";
import * as Effect from "effect/Effect";
import { redactText } from "./redactor.ts";

async function runGh(args: ReadonlyArray<string>, cwd?: string) {
  const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Live host GitHub adapter using ambient `gh auth` and local `git` credentials.
 * Implements crash-safe marker lookup (`<!-- overwatch-action-id: ... -->`) before write.
 */
export const GitHubLiveLayer = GitHubExternal.toLayer(
  Effect.succeed({
  findExistingArtifact: ({ repo, actionId, kind, branch }) =>
    Effect.tryPromise({
      try: async () => {
        if (kind === "open_draft_pr" && branch) {
          const res = await runGh([
            "pr",
            "list",
            "--repo",
            repo,
            "--head",
            branch,
            "--json",
            "url,number",
            "--limit",
            "1",
          ]);
          if (res.ok && res.stdout) {
            const list = JSON.parse(res.stdout) as Array<{ url: string; number: number }>;
            if (list[0]) {
              return { found: true, url: list[0].url, number: list[0].number };
            }
          }
        }
        const marker = `overwatch-action-id: ${actionId}`;
        const searchCmd = kind === "create_github_issue" ? "issue" : "pr";
        const res = await runGh([
          searchCmd,
          "list",
          "--repo",
          repo,
          "--search",
          `"${marker}" in:body`,
          "--json",
          "url,number",
          "--limit",
          "1",
        ]);
        if (res.ok && res.stdout) {
          const list = JSON.parse(res.stdout) as Array<{ url: string; number: number }>;
          if (list[0]) {
            return { found: true, url: list[0].url, number: list[0].number };
          }
        }
        return { found: false };
      },
      catch: (err) =>
        new ExternalCallFailed({
          system: "GitHub",
          operation: "findExistingArtifact",
          reason: redactText(err instanceof Error ? err.message : String(err), { maxBytes: 300 }),
        }),
    }),

  createIssue: ({ repo, title, body, labels }) =>
    Effect.tryPromise({
      try: async () => {
        const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
        for (const label of labels) args.push("--label", label);
        const res = await runGh(args);
        if (!res.ok) throw new Error(res.stderr || "gh issue create failed");
        const url = res.stdout.split("\n").pop()?.trim() ?? res.stdout;
        const numMatch = url.match(/\/issues\/(\d+)$/);
        return { url, number: numMatch ? Number(numMatch[1]) : 0 };
      },
      catch: (err) =>
        new ExternalCallFailed({
          system: "GitHub",
          operation: "createIssue",
          reason: redactText(err instanceof Error ? err.message : String(err), { maxBytes: 300 }),
        }),
    }),

  pushAndOpenDraftPr: ({ repo, worktreePath, branch, baseBranch, title, body }) =>
    Effect.tryPromise({
      try: async () => {
        const push = Bun.spawn(["git", "push", "-u", "origin", branch], {
          cwd: worktreePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        if ((await push.exited) !== 0) {
          throw new Error((await new Response(push.stderr).text()) || "git push failed");
        }
        const res = await runGh(
          [
            "pr",
            "create",
            "--repo",
            repo,
            "--draft",
            "--head",
            branch,
            "--base",
            baseBranch,
            "--title",
            title,
            "--body",
            body,
          ],
          worktreePath,
        );
        if (!res.ok) throw new Error(res.stderr || "gh pr create failed");
        const url = res.stdout.split("\n").pop()?.trim() ?? res.stdout;
        const numMatch = url.match(/\/pull\/(\d+)$/);
        return { url, number: numMatch ? Number(numMatch[1]) : 0 };
      },
      catch: (err) =>
        new ExternalCallFailed({
          system: "GitHub",
          operation: "pushAndOpenDraftPr",
          reason: redactText(err instanceof Error ? err.message : String(err), { maxBytes: 300 }),
        }),
    }),
  }),
);

/**
 * Deterministic local demo GitHub adapter (zero outbound network calls; keeps in-memory
 * artifact registry so crash-reconciliation works identically in demo mode).
 */
export function makeDemoGitHubLayer() {
  const created = new Map<string, { url: string; number: number }>();
  let nextNum = 412;
  return GitHubExternal.toLayer(
    Effect.succeed({
      findExistingArtifact: ({ actionId, branch }) =>
        Effect.sync(() => {
          const hit = created.get(actionId) ?? (branch ? created.get(`branch:${branch}`) : undefined);
          return hit ? { found: true, url: hit.url, number: hit.number } : { found: false };
        }),
      createIssue: ({ repo, actionId }) =>
        Effect.sync(() => {
          const num = nextNum++;
          const url = `https://github.com/${repo}/issues/${num}`;
          created.set(actionId, { url, number: num });
          return { url, number: num };
        }),
      pushAndOpenDraftPr: ({ repo, actionId, branch }) =>
        Effect.sync(() => {
          const num = nextNum++;
          const url = `https://github.com/${repo}/pull/${num}`;
          created.set(actionId, { url, number: num });
          created.set(`branch:${branch}`, { url, number: num });
          return { url, number: num };
        }),
    }),
  );
}
