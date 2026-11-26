import { iso } from "../duration.ts";
import { redactText } from "../redact.ts";
import type { Sample, Signal } from "../signals.ts";
import type { SourceContext, SourceType } from "./types.ts";

/**
 * Any program as a source, so new telemetry needs no Overwatch change.
 *
 * The program runs without a shell in the app's checkout with OVERWATCH_FROM, OVERWATCH_TO (ISO 8601) and
 * OVERWATCH_FINAL ("1" on the newest slice) set, and prints JSON lines:
 *
 *   {"signal": {"key": "...", "title": "...", "at": "<ISO>", "id": "...", "severity": "error", "sample": "...", "state": false}}
 *   {"metric": "queue_depth", "value": 42, "at": "<ISO>"}
 *
 * For `overwatch_query` it runs with OVERWATCH_QUERY set to the JSON args and its stdout is returned.
 */
async function run(command: ReadonlyArray<string>, env: Record<string, string>, context: SourceContext) {
  const [program, ...args] = command;
  const result = await context.exec(program!, args, {
    cwd: context.app.checkout,
    timeoutMs: context.options.timeouts.sourceMs,
    signal: context.signal,
    env,
  });
  if (result.code !== 0) throw new Error(`${program} exited ${result.code}: ${redactText(result.stderr.trim(), { maxBytes: 300 })}`);
  return result.stdout;
}

export const commandSource: SourceType = {
  type: "command",
  queryHelp: "args: any JSON, passed to the program as OVERWATCH_QUERY.",
  validate: (config) =>
    Array.isArray(config.command) && config.command.length > 0 && config.command.every((p) => typeof p === "string")
      ? []
      : ['command source needs "command": ["program", "arg", ...]'],
  collect: async (config, { window, final }, context) => {
    const stdout = await run(
      config.command as string[],
      { OVERWATCH_FROM: iso(window.from), OVERWATCH_TO: iso(window.to), OVERWATCH_FINAL: final ? "1" : "0" },
      context,
    );
    const groups = new Map<string, Signal>();
    const samples: Sample[] = [];
    const notes: string[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        notes.push(`${context.name}: ignored a line that is not JSON`);
        continue;
      }
      if (typeof parsed?.metric === "string" && typeof parsed.value === "number") {
        const at = parsed.at ? Date.parse(parsed.at) : window.to;
        if (Number.isFinite(at)) samples.push({ metric: parsed.metric, value: parsed.value, at });
        continue;
      }
      const s = parsed?.signal;
      if (!s || typeof s.key !== "string") continue;
      const at = s.at ? Date.parse(s.at) : window.to;
      if (!Number.isFinite(at)) continue;
      const key = `cmd:${s.key}`;
      const prior = groups.get(key);
      const occurrence = { at, ...(typeof s.id === "string" ? { id: s.id } : {}) };
      groups.set(key, {
        source: context.name,
        kind: typeof s.kind === "string" ? s.kind : "custom",
        key,
        title: String(s.title ?? s.key).slice(0, 120),
        severity: s.severity === "info" || s.severity === "warn" ? s.severity : "error",
        occurrences: [...(prior?.occurrences ?? []), occurrence],
        ...(s.sample ? { sample: redactText(String(s.sample), { maxBytes: 400 }) } : {}),
        ...(s.state === true ? { state: true } : {}),
      });
    }
    return { signals: [...groups.values()], samples, notes };
  },
  query: async (config, input, context) =>
    redactText(
      await run(
        config.command as string[],
        { OVERWATCH_FROM: iso(input.since), OVERWATCH_TO: iso(input.until), OVERWATCH_FINAL: "1", OVERWATCH_QUERY: JSON.stringify(input.args) },
        context,
      ),
      { maxBytes: 24_000 },
    ),
};
