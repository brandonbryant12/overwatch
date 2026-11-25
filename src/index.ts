import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Plugin } from "@opencode/plugin";
import { iso, queryWindow } from "./duration.ts";
import { exec } from "./exec.ts";
import { createInvestigator, fileFinding, FIXER, INVESTIGATOR, recordEvidence, type Host } from "./investigate.ts";
import { notify } from "./notify.ts";
import { parseOptions, type PermissionRule, type WatcherConfig } from "./options.ts";
import { findingJsonSchema } from "./report.ts";
import { configureRedaction } from "./redact.ts";
import { sleep, sourceContext, validateSources, type Runtime } from "./runtime.ts";
import { isRecord } from "./tolerant.ts";
import { startScheduler } from "./scheduler.ts";
import { sourceType } from "./sources/index.ts";
import { parseInvestigateArgs, pickApp, renderStatus } from "./status.ts";
import type { KV } from "./store.ts";
import { runWatcher } from "./sweep.ts";

type Context = Plugin.Context;

export const SHOW = "[Overwatch] Show the text below to the user exactly as written. Add nothing and call no tools.";

const ENV_FILES: PermissionRule[] = [
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];

const GIT_READ = ["git log *", "git show *", "git blame *", "git diff *", "git grep *", "git status *", "git rev-parse *"];

/** Investigators read code and telemetry and file a finding. Nothing else, unless the user adds rules. */
export function investigatorPermissions(extra: ReadonlyArray<PermissionRule>): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "skill", "overwatch_query", "overwatch_report"].map(
      (action): PermissionRule => ({ action, resource: "*", effect: "allow" }),
    ),
    ...ENV_FILES,
    ...GIT_READ.map((resource): PermissionRule => ({ action: "shell", resource, effect: "allow" })),
    ...extra,
  ];
}

/** Fixers edit inside their worktree and run the app's verify commands. They cannot commit, push or call gh. */
export function fixerPermissions(verify: ReadonlyArray<string>, extra: ReadonlyArray<PermissionRule>): PermissionRule[] {
  return [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "skill", "edit"].map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
    ...ENV_FILES,
    ...[...GIT_READ, ...verify, ...verify.map((v) => `${v} *`)].map((resource): PermissionRule => ({ action: "shell", resource, effect: "allow" })),
    ...["git commit *", "git push *", "gh *", "kubectl *"].map((resource): PermissionRule => ({ action: "shell", resource, effect: "deny" })),
    ...extra,
  ];
}

function storageKV(ctx: Context): KV {
  return {
    get: (key) => ctx.storage.get(key),
    set: (key, value) => ctx.storage.set(key, value),
    remove: (key) => ctx.storage.remove(key),
    scan: (options) => ctx.storage.scan(options),
  };
}

function host(ctx: Context, runtime: Runtime): Host {
  const prompted = new Map<string, number>();
  return {
    async createSession({ title, agent, directory, permissions }) {
      const session = await ctx.session.create({
        title,
        agent,
        location: { directory },
        ...(runtime.options.model ? { model: runtime.options.model } : {}),
        ...(permissions ? { permissions: [...permissions] } : {}),
      });
      return session.id;
    },
    async prompt(sessionID, text, skills) {
      prompted.set(sessionID, Date.now());
      await ctx.session.prompt({ sessionID, text, delivery: "queue", ...(skills.length ? { skills: skills.map((id) => ({ id })) } : {}) });
    },
    async waitIdle(sessionID, signal) {
      // A queued prompt may not have started yet; wait until the session has been busy since it was prompted.
      const since = prompted.get(sessionID) ?? 0;
      for (let i = 0; i < 40 && !signal.aborted; i++) {
        const info = await ctx.session.get({ sessionID });
        if ((info.time.busy ?? 0) >= since - 1_000 || info.outcome) break;
        await sleep(250, signal);
      }
      while (!signal.aborted) {
        await ctx.session.wait({ sessionID }, { signal });
        const info = await ctx.session.get({ sessionID });
        if (!info.time.busy || (info.time.idle ?? 0) >= info.time.busy) return;
        await sleep(500, signal);
      }
    },
    async interrupt(sessionID) {
      await ctx.session.interrupt({ sessionID });
    },
    async show(sessionID, text) {
      // A synthetic message with resume:false waits in the inbox unseen, so start a turn and have the agent relay it.
      await ctx.session.synthetic({ sessionID, text: `${SHOW}\n\n${text}`, description: "Overwatch", delivery: "queue" });
    },
    notify: (title, body) => notify(runtime.exec, runtime.options.notify, title, body),
  };
}

export const OverwatchPlugin = {
  id: "overwatch",
  async setup(ctx: Context) {
    const parsed = parseOptions(ctx.options, ctx.location.directory);
    const options = parsed.options;
    const errors = [...parsed.errors, ...validateSources(options)];
    configureRedaction(options.redaction);
    const runtime: Runtime = {
      kv: storageKV(ctx),
      options,
      exec,
      fetch: globalThis.fetch,
      now: Date.now,
      log: (message) => console.log(`[overwatch] ${message}`),
    };
    const opencode = host(ctx, runtime);
    const investigator = createInvestigator(runtime, opencode);
    const running = new Set<string>();
    const runOne = async (watcher: WatcherConfig, signal?: AbortSignal) => {
      if (running.has(watcher.id)) return undefined;
      running.add(watcher.id);
      try {
        return await runWatcher(runtime, watcher, { investigate: (request) => investigator.start(request), notify: opencode.notify }, signal);
      } finally {
        running.delete(watcher.id);
      }
    };

    const [investigatorPrompt, fixerPrompt] = await Promise.all(
      ["investigator", "fixer"].map((name) => readFile(new URL(`../prompts/${name}.md`, import.meta.url), "utf8")),
    );
    const verify = [...new Set(Object.values(options.apps).flatMap((app) => app.verify))];
    await ctx.agent.transform((editor) => {
      editor.update(INVESTIGATOR, (agent) => {
        agent.name = "Overwatch investigator" as typeof agent.name;
        agent.description = "Investigates a production problem read-only and files a structured finding.";
        agent.mode = "primary";
        agent.system = investigatorPrompt!;
        agent.permissions = investigatorPermissions(options.permissions.investigator) as typeof agent.permissions;
      });
      editor.update(FIXER, (agent) => {
        agent.name = "Overwatch fixer" as typeof agent.name;
        agent.description = "Makes the smallest verified fix for a diagnosed problem in a fresh worktree.";
        agent.mode = "primary";
        agent.system = fixerPrompt!;
        agent.permissions = fixerPermissions(verify, options.permissions.fixer) as typeof agent.permissions;
      });
    });

    const sourceList = Object.values(options.apps)
      .flatMap((app) =>
        Object.entries(app.environments).flatMap(([env, config]) =>
          Object.entries(config.sources).map(([name, s]) => `- ${app.name} / ${env} / ${name} (${s.type}): ${sourceType(s.type)?.queryHelp ?? ""}`),
        ),
      )
      .join("\n");

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "overwatch_query",
        description: `Read-only telemetry lookup for an app environment. since/until take an ISO time or a duration back from now such as "6h" (defaults: 1h back to now).\nConfigured sources:\n${sourceList || "(none)"}`,
        input: {
          type: "object",
          additionalProperties: false,
          required: ["app", "environment", "source"],
          properties: {
            app: { type: "string" },
            environment: { type: "string" },
            source: { type: "string" },
            since: { type: "string" },
            until: { type: "string" },
            args: { type: "object", description: "Source-specific arguments; see the source list." },
          },
        },
        options: { codemode: false },
        execute: async (input: any, context) => {
          const env = options.apps[input.app]?.environments[input.environment];
          const config = env?.sources[input.source];
          const type = config ? sourceType(config.type) : undefined;
          if (!config || !type) return { content: `Unknown source ${input.app}/${input.environment}/${input.source}. Configured:\n${sourceList}` };
          const window = queryWindow(input, Date.now());
          if ("error" in window) return { content: `Query not run: ${window.error}` };
          try {
            const text = await type.query(
              config,
              { ...window, args: isRecord(input.args) ? input.args : {} },
              sourceContext(runtime, input.app, input.environment, input.source, context.signal),
            );
            const output = text || "(no output)";
            // Kept so the finding's quotes can be checked against what this investigation was actually shown.
            await recordEvidence(runtime, context.sessionID, String(input.source), `overwatch_query ${input.source} ${iso(window.since)} to ${iso(window.until)} ${JSON.stringify(input.args ?? {})}\n${output}`).catch(() => undefined);
            return { content: output };
          } catch (error) {
            return { content: `Query failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
      });
      editor.add({
        name: "overwatch_report",
        description:
          "File the investigation's finding. Call once, at the end. Lead with the verdict, cite evidence for every claim, keep within the limits. Quotes are checked against what you were shown: copy them exactly from an overwatch_query result, the report you were given, or a file in the working directory. Nothing found is a valid answer.",
        input: findingJsonSchema as any,
        options: { codemode: false },
        execute: async (input: unknown, context) => ({ content: await fileFinding(runtime, context.sessionID, input) }),
      });
      editor.add({
        name: "overwatch_status",
        description: "Overwatch status: watchers, what each source has checked through, coverage gaps, open incidents and recent findings.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => ({ content: await renderStatus(runtime.kv, options, errors, Date.now()) }),
      });
    });

    await ctx.command.transform((editor) => {
      editor.add({
        name: "investigate",
        description: "Investigate a pasted bug report: /investigate [--app a] [--env e] [--since 6h] [--until ISO] <report>",
        execute: async ({ sessionID, prompt }) => {
          const now = Date.now();
          const args = parseInvestigateArgs(prompt.text, now);
          if ("error" in args) throw new Error(args.error);
          const session = await ctx.session.get({ sessionID }).catch(() => undefined);
          const app = pickApp(options, args.app, (session?.location as { directory?: string } | undefined)?.directory);
          if (typeof app !== "string") throw new Error(app.error);
          const envs = Object.keys(options.apps[app]!.environments);
          const environment = args.environment ?? (envs.length === 1 ? envs[0] : undefined);
          if (environment && !options.apps[app]!.environments[environment]) {
            throw new Error(`Unknown environment "${environment}" for ${app}. Configured: ${envs.join(", ")}`);
          }
          const watcher = options.watchers.find((w) => w.app === app && w.environment === environment);
          const id = await investigator.start({
            title: args.text.split("\n")[0]!.slice(0, 80),
            brief: args.text,
            app,
            ...(environment ? { environment } : {}),
            window: { from: args.since ?? now - options.lookback.initialMs, to: args.until ?? now },
            coverage: [],
            skills: [...(watcher?.skills ?? options.apps[app]!.skills)],
            fix: watcher?.fix ?? false,
            trigger: { type: "manual", text: args.text, originSessionID: sessionID },
          });
          await opencode.show(sessionID, `Overwatch is investigating ${app}${environment ? `/${environment}` : ""} (${id}). The report will appear here when it is done.`);
        },
      });
      editor.add({
        name: "overwatch",
        description: "Overwatch status: watchers, coverage, open incidents and recent findings.",
        execute: async ({ sessionID }) => opencode.show(sessionID, await renderStatus(runtime.kv, options, errors, Date.now())),
      });
      editor.add({
        name: "overwatch-run",
        description: "Run watchers now: /overwatch-run [app/environment]",
        execute: async ({ sessionID, prompt }) => {
          if (errors.length) throw new Error(`Fix the Overwatch configuration first:\n- ${errors.join("\n- ")}`);
          const wanted = prompt.text.trim();
          const watchers = options.watchers.filter((w) => !wanted || w.id === wanted);
          if (!watchers.length) throw new Error(`No watcher ${wanted}. Configured: ${options.watchers.map((w) => w.id).join(", ") || "none"}`);
          const lines: string[] = [];
          for (const watcher of watchers) {
            const record = await runOne(watcher);
            if (!record) lines.push(`- ${watcher.id}: already running`);
            else {
              lines.push(
                `- ${watcher.id}: ${record.opened.length} opened, ${record.resolved.length} resolved${record.investigationId ? `, investigating (${record.investigationId})` : ""}`,
                ...record.coverage.map((c) => `  - ⚠ ${c}`),
              );
            }
          }
          await opencode.show(sessionID, lines.join("\n"));
        },
      });
    });

    if (errors.length) runtime.log(`configuration errors; watchers are not scheduled:\n- ${errors.join("\n- ")}`);
    const scheduler =
      options.schedule && !errors.length && options.watchers.length
        ? startScheduler(runtime, `${ctx.location.directory}#${randomUUID()}`, (watcher, signal) => runOne(watcher, signal))
        : undefined;
    return async () => {
      await scheduler?.stop();
    };
  },
} satisfies Plugin.Plugin;

export default OverwatchPlugin;
