import { describe, expect, test } from "bun:test";
import type { Incident } from "../src/incidents.ts";
import type { SourceConfig } from "../src/options.ts";
import { acquireLease, dueWatchers, releaseLease } from "../src/scheduler.ts";
import { registerSourceType } from "../src/sources/index.ts";
import type { Signal } from "../src/signals.ts";
import { keys, loadWatcher, scanAll } from "../src/store.ts";
import { runWatcher, type InvestigationRequest } from "../src/sweep.ts";
import type { TimeWindow } from "../src/window.ts";
import { options, runtime } from "./helpers.ts";

const H = 3_600_000;
const D = 24 * H;

/** A scripted source: records every window it is asked for and answers from `events`. */
interface Script {
  windows: Array<TimeWindow & { final: boolean }>;
  events: Array<{ at: number; id: string; message: string }>;
  failFrom?: number;
  samples?: (window: TimeWindow) => Array<{ metric: string; at: number; value: number }>;
}
const scripts = new Map<string, Script>();
registerSourceType({
  type: "scripted",
  queryHelp: "",
  validate: () => [],
  async collect(config: SourceConfig, { window, final }) {
    const script = scripts.get(String(config.script))!;
    script.windows.push({ ...window, final });
    if (script.failFrom !== undefined && window.from >= script.failFrom) throw new Error("cluster unreachable");
    const groups = new Map<string, Signal>();
    for (const event of script.events.filter((e) => e.at >= window.from && e.at < window.to)) {
      const prior = groups.get(event.message);
      groups.set(event.message, {
        source: String(config.name),
        kind: "log",
        key: event.message,
        title: event.message,
        severity: "error",
        occurrences: [...(prior?.occurrences ?? []), { at: event.at, id: event.id }],
        total: (prior?.total ?? 0) + 1,
        sample: event.message,
      });
    }
    return { signals: [...groups.values()], samples: script.samples?.(window) ?? [], notes: [] };
  },
  query: async () => "",
});

function setup(name: string, watcher: Record<string, unknown> = {}) {
  const script: Script = { windows: [], events: [] };
  scripts.set(name, script);
  const opts = options({
    apps: { app: { checkout: "/tmp/app", environments: { prod: { sources: { logs: { type: "scripted", script: name, name: "logs" } } } } } },
    watchers: [{ app: "app", environment: "prod", every: "15m", ...watcher }],
    lookback: { initial: "24h", max: "14d", overlap: "2m", slice: "6h" },
  });
  const rt = runtime(opts);
  const investigations: InvestigationRequest[] = [];
  const hooks = { investigate: async (request: InvestigationRequest) => (investigations.push(request), `inv_${investigations.length}`) };
  return { script, rt, watcher: opts.watchers[0]!, investigations, hooks };
}

const incidents = (rt: ReturnType<typeof runtime>) => scanAll<Incident>(rt.kv, "incident/");

describe("watcher runs", () => {
  test("first run looks 24h back; the next looks from its checkpoint minus the overlap", async () => {
    const { script, rt, watcher, hooks } = setup("first");
    await runWatcher(rt, watcher, hooks);
    expect(script.windows[0]!.from).toBe(rt.clock.now - 24 * H);
    expect(script.windows.at(-1)).toMatchObject({ to: rt.clock.now, final: true });
    const firstEnd = rt.clock.now;
    script.windows.length = 0;
    rt.clock.now += 47 * 60_000;
    await runWatcher(rt, watcher, hooks);
    expect(script.windows).toEqual([{ from: firstEnd - 2 * 60_000, to: rt.clock.now, final: true }]);
  });

  test("a new error opens one incident and one investigation; the overlap does not double count", async () => {
    const { script, rt, watcher, hooks, investigations } = setup("open");
    script.events.push({ at: rt.clock.now - 60_000, id: "e1", message: "payment timed out" });
    const first = await runWatcher(rt, watcher, hooks);
    expect(first.opened).toHaveLength(1);
    expect(investigations).toHaveLength(1);
    expect(investigations[0]).toMatchObject({ app: "app", environment: "prod", trigger: { type: "watcher", incidentIds: first.opened } });
    expect(investigations[0]!.brief).toContain("payment timed out");

    rt.clock.now += 15 * 60_000;
    const second = await runWatcher(rt, watcher, hooks);
    expect(second.opened).toEqual([]);
    expect(investigations).toHaveLength(1);
    const [incident] = await incidents(rt);
    expect(incident).toMatchObject({ count: 1, cleanRuns: 1, investigationId: "inv_1" });
  });

  test("recurrence updates the open incident; it resolves after resolveAfter clean runs", async () => {
    const { script, rt, watcher, hooks } = setup("resolve", { resolveAfter: 2 });
    script.events.push({ at: rt.clock.now - 60_000, id: "e1", message: "boom" });
    await runWatcher(rt, watcher, hooks);
    rt.clock.now += 15 * 60_000;
    script.events.push({ at: rt.clock.now - 60_000, id: "e2", message: "boom" });
    expect((await runWatcher(rt, watcher, hooks)).opened).toEqual([]);
    expect((await incidents(rt))[0]).toMatchObject({ count: 2, cleanRuns: 0, status: "open" });
    rt.clock.now += 15 * 60_000;
    await runWatcher(rt, watcher, hooks);
    rt.clock.now += 15 * 60_000;
    const last = await runWatcher(rt, watcher, hooks);
    expect(last.resolved).toHaveLength(1);
    expect((await incidents(rt))[0]!.status).toBe("resolved");
  });

  test("a failed source keeps its checkpoint, freezes its incidents, and says what was not checked", async () => {
    const { script, rt, watcher, hooks } = setup("fail");
    script.events.push({ at: rt.clock.now - 60_000, id: "e1", message: "boom" });
    await runWatcher(rt, watcher, hooks);
    const checkpoint = (await loadWatcher(rt.kv, watcher.id)).checkpoints.logs;
    rt.clock.now += 15 * 60_000;
    script.failFrom = 0;
    const failed = await runWatcher(rt, watcher, hooks);
    expect(failed.failedSources).toEqual(["logs"]);
    expect(failed.coverage[0]).toContain("logs: not checked from");
    expect(failed.coverage[0]).toContain("cluster unreachable");
    expect((await loadWatcher(rt.kv, watcher.id)).checkpoints.logs).toBe(checkpoint);
    expect((await incidents(rt))[0]).toMatchObject({ cleanRuns: 0, status: "open" });

    script.failFrom = undefined;
    script.windows.length = 0;
    rt.clock.now += 15 * 60_000;
    await runWatcher(rt, watcher, hooks);
    expect(script.windows[0]!.from).toBe(checkpoint! - 2 * 60_000);
  });

  test("after a long gap it catches up in slices oldest first, capped at 14 days, and reports the cap", async () => {
    const { script, rt, watcher, hooks, investigations } = setup("gap");
    await runWatcher(rt, watcher, hooks);
    script.windows.length = 0;
    rt.clock.now += 20 * D;
    script.events.push({ at: rt.clock.now - 10 * D, id: "old", message: "disk full" });
    script.events.push({ at: rt.clock.now - 1 * D, id: "new", message: "disk full" });
    const record = await runWatcher(rt, watcher, hooks);
    expect(script.windows[0]!.from).toBe(rt.clock.now - 14 * D);
    expect(script.windows.map((w) => w.from)).toEqual([...script.windows.map((w) => w.from)].sort((a, b) => a - b));
    expect(script.windows.filter((w) => w.final)).toHaveLength(1);
    expect(record.coverage.find((c) => c.includes("lookback is capped at 14d"))).toBeDefined();
    expect(record.opened).toHaveLength(1);
    expect(investigations[0]!.coverage.some((c) => c.includes("lookback is capped at 14d"))).toBe(true);
    const [incident] = await incidents(rt);
    expect(incident).toMatchObject({ count: 2, firstAt: rt.clock.now - 10 * D });
  });

  test("metrics breach only after hysteresis, and a stale series is not judged healthy", async () => {
    const { script, rt, watcher, hooks } = setup("metrics", { resolveAfter: 1 });
    let memory = 50;
    script.samples = (w) => [{ metric: "memory_pct_of_limit", at: w.to, value: memory }];
    await runWatcher(rt, watcher, hooks);
    memory = 95;
    rt.clock.now += 15 * 60_000;
    expect((await runWatcher(rt, watcher, hooks)).opened).toEqual([]);
    rt.clock.now += 15 * 60_000;
    const breach = await runWatcher(rt, watcher, hooks);
    expect(breach.opened).toHaveLength(1);
    expect((await incidents(rt))[0]!.title).toContain("memory_pct_of_limit 95 over 90");
    script.samples = () => [];
    rt.clock.now += 15 * 60_000;
    expect((await runWatcher(rt, watcher, hooks)).resolved).toEqual([]);
  });

  test("a watcher with investigate off notifies instead", async () => {
    const { script, rt, watcher } = setup("notify", { investigate: false });
    script.events.push({ at: rt.clock.now - 60_000, id: "e1", message: "boom" });
    const notes: string[] = [];
    await runWatcher(rt, watcher, { investigate: async () => "never", notify: async (title, body) => void notes.push(`${title}: ${body}`) });
    expect(notes).toEqual(["Overwatch: app/prod: boom"]);
  });
});

describe("scheduling", () => {
  test("one lease holder at a time; it expires so another instance can take over", async () => {
    const { rt } = setup("lease");
    expect(await acquireLease(rt, "a")).toBe(true);
    expect(await acquireLease(rt, "b")).toBe(false);
    expect(await acquireLease(rt, "a")).toBe(true);
    rt.clock.now += 4 * 60_000;
    expect(await acquireLease(rt, "b")).toBe(true);
    await releaseLease(rt, "b");
    expect(await rt.kv.get(keys.lease)).toBeUndefined();
  });

  test("missed slots are skipped: after a long sleep a watcher is due once", async () => {
    const { rt, watcher, hooks } = setup("missed");
    expect(await dueWatchers(rt, [watcher])).toHaveLength(1);
    await runWatcher(rt, watcher, hooks);
    expect(await dueWatchers(rt, [watcher])).toHaveLength(0);
    rt.clock.now += 9 * H;
    expect(await dueWatchers(rt, [watcher])).toHaveLength(1);
    await runWatcher(rt, watcher, hooks);
    expect(await dueWatchers(rt, [watcher])).toHaveLength(0);
  });
});
