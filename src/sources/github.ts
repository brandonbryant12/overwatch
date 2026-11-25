import { iso } from "../duration.ts";
import { redactText } from "../redact.ts";
import type { Occurrence, Signal } from "../signals.ts";
import { str, type SourceContext, type SourceType } from "./types.ts";

/** CI through the `gh` CLI, read-only, run inside the app's checkout so the repository comes from its remote. */
async function gh(context: SourceContext, args: string[]): Promise<string> {
  const result = await context.exec("gh", args, {
    cwd: context.app.checkout,
    timeoutMs: context.options.timeouts.sourceMs,
    signal: context.signal,
  });
  if (result.code !== 0) throw new Error(`gh ${args[0]} ${args[1]} failed: ${redactText(result.stderr.trim(), { maxBytes: 300 })}`);
  return result.stdout;
}

interface Run {
  readonly databaseId: number;
  readonly workflowName: string;
  readonly displayTitle: string;
  readonly headSha: string;
  readonly headBranch: string;
  readonly createdAt: string;
  readonly url: string;
}

async function failedRuns(context: SourceContext, branch: string | undefined, workflow: string | undefined, since: number): Promise<Run[]> {
  const args = [
    "run",
    "list",
    "--status",
    "failure",
    "--created",
    `>=${iso(since)}`,
    "--limit",
    "100",
    "--json",
    "databaseId,workflowName,displayTitle,headSha,headBranch,createdAt,url",
  ];
  if (branch) args.push("--branch", branch);
  if (workflow) args.push("--workflow", workflow);
  return JSON.parse((await gh(context, args)) || "[]") as Run[];
}

export const githubCiSource: SourceType = {
  type: "github-ci",
  queryHelp: "args: { run?: number }. Without run: failed runs between since and until. With run: the failed steps' log tail.",
  validate: () => [],
  collect: async (config, { window }, context) => {
    const runs = (await failedRuns(context, str(config.branch), str(config.workflow), window.from)).filter((run) => {
      const at = Date.parse(run.createdAt);
      return at >= window.from && at < window.to;
    });
    const groups = new Map<string, { signal: Omit<Signal, "occurrences" | "total">; occurrences: Occurrence[] }>();
    for (const run of runs) {
      const key = `ci:${run.workflowName}`;
      const entry = groups.get(key) ?? {
        signal: {
          source: context.name,
          kind: "ci",
          key,
          title: `${run.workflowName} failed`,
          severity: "warn",
          sample: `${run.createdAt} ${run.workflowName} failed on ${run.headBranch}@${run.headSha.slice(0, 7)}: ${run.displayTitle}`,
          query: `gh run view ${run.databaseId} --log-failed`,
          url: run.url,
        },
        occurrences: [],
      };
      entry.occurrences.push({ at: Date.parse(run.createdAt), id: String(run.databaseId) });
      groups.set(key, entry);
    }
    return {
      signals: [...groups.values()].map((g) => ({ ...g.signal, occurrences: g.occurrences, total: g.occurrences.length })),
      samples: [],
      notes: [],
    };
  },
  query: async (config, input, context) => {
    const run = Number(input.args.run);
    if (Number.isInteger(run) && run > 0) {
      const log = await gh(context, ["run", "view", String(run), "--log-failed"]);
      return redactText(log.split("\n").slice(-300).join("\n"), { maxBytes: 24_000 });
    }
    const runs = (await failedRuns(context, str(config.branch), str(config.workflow), input.since)).filter(
      (r) => Date.parse(r.createdAt) < input.until,
    );
    return runs.map((r) => `${r.databaseId} ${r.createdAt} ${r.workflowName} ${r.headBranch}@${r.headSha.slice(0, 7)} ${r.displayTitle}`).join("\n") || "No failed runs.";
  },
};
