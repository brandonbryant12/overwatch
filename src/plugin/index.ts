/**
 * The thin Overwatch plugin for OpenCode 2.
 *
 * It holds no state and schedules nothing. It registers the investigator agent and the `overwatch` skill, and
 * connects OpenCode to the service's MCP server, which is where sessions get their Overwatch tools. It checks the
 * service's health and Api version with plain `fetch`. It has no Effect and no domain client at run time: imports from
 * OpenCode's plugin package are types only. Install it in the global OpenCode configuration, because agent sessions
 * run in worktrees and a plugin configured for one project would not load there.
 */
import { readFileSync } from "node:fs";
import type { Plugin } from "@opencode/plugin";

/** The service Api version this plugin was built with. Kept equal to `API_VERSION` in src/domain/model.ts by a test. */
export const API_VERSION = 1;
export const INVESTIGATOR = "overwatch-investigator";
export const MCP_SERVER = "overwatch";
export const DEFAULT_URL = "http://127.0.0.1:7450";

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

const GIT_READ = ["git log *", "git show *", "git blame *", "git diff *", "git grep *", "git status *", "git rev-parse *"];

/**
 * Deny by default. The investigator reads code and runs read-only git, uses Overwatch's MCP tools (OpenCode names
 * an MCP tool's permission `<server>_<tool>`), and may load skills. Nothing else, unless the owner adds rules.
 */
export function investigatorPermissions(extra: ReadonlyArray<PermissionRule> = []): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "skill"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    ...GIT_READ.map((resource): PermissionRule => ({ action: "shell", resource, effect: "allow" })),
    ...["query_telemetry", "file_finding", "OverwatchApi_Inbox_get", "OverwatchApi_IncidentPage_get", "OverwatchApi_ThreadPage_get", "OverwatchApi_Search"].map(
      (tool): PermissionRule => ({ action: `${MCP_SERVER}_${tool}`, resource: "*", effect: "allow" }),
    ),
    ...extra,
  ];
}

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

export interface Health {
  readonly ok: boolean;
  readonly detail: string;
}

/** Is the service up, and does it speak this plugin's Api version? */
export async function checkService(url: string, fetcher: typeof fetch = fetch): Promise<Health> {
  try {
    const response = await fetcher(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json()) as { name?: string; version?: string; apiVersion?: number };
    if (body.name !== "overwatch") return { ok: false, detail: `${url} is not an Overwatch service` };
    if (body.apiVersion !== API_VERSION) {
      return { ok: false, detail: `the service speaks Api version ${body.apiVersion}, this plugin ${API_VERSION}: update one of them` };
    }
    return { ok: true, detail: `Overwatch ${body.version} at ${url}` };
  } catch (error) {
    return { ok: false, detail: `the service is not answering at ${url} (${(error as Error).message}); start it with "overwatch serve"` };
  }
}

export const OverwatchPlugin = {
  id: "overwatch",
  async setup(ctx: Plugin.Context) {
    const options = (ctx.options ?? {}) as { url?: string; permissions?: PermissionRule[] };
    const url = (options.url ?? DEFAULT_URL).replace(/\/+$/, "");
    const health = await checkService(url);
    if (!health.ok) console.warn(`[overwatch] ${health.detail}. Agents and tools are registered anyway and work once it is up.`);

    await ctx.mcp.transform((editor) => {
      editor.set(MCP_SERVER, { type: "remote", url: `${url}/mcp`, oauth: false, codemode: false } as never);
    });
    await ctx.agent.transform((editor) => {
      editor.update(INVESTIGATOR, (agent) => {
        agent.name = "Overwatch investigator" as typeof agent.name;
        agent.description = "Investigates a production problem read-only and files a finding whose citations Overwatch checks.";
        agent.mode = "primary";
        agent.system = read("./investigator.md");
        agent.permissions = investigatorPermissions(options.permissions ?? []) as typeof agent.permissions;
      });
    });
    const skillPath = new URL("../../skills/overwatch/SKILL.md", import.meta.url).pathname;
    const skill = readFileSync(skillPath, "utf8");
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "overwatch",
        name: "overwatch",
        description: "How to work with Overwatch, the service that watches this person's apps, from an OpenCode session.",
        path: skillPath,
        content: skill.slice(skill.indexOf("---", 3) + 3).trim(),
      } as never);
    });
  },
} satisfies Plugin.Plugin;

export default OverwatchPlugin;
