import { limiter } from "./exec.ts";
import type { WatcherConfig } from "./options.ts";
import type { Runtime } from "./runtime.ts";
import { keys, loadWatcher, readRecord, writeRecord } from "./store.ts";

/**
 * Overwatch schedules its own runs with a timer in the plugin, rather than OpenCode automations.
 *
 * OpenCode loads the plugin once per location, so several instances can be alive; a lease in plugin storage
 * lets one of them run watchers at a time. A watcher is due when `every` has passed since its last run. After a
 * sleep or downtime it runs once, not once per missed slot, and its sources pick up from their own checkpoints.
 */
export const LEASE_MS = 3 * 60_000;
export const TICK_MS = 60_000;

export async function acquireLease(runtime: Runtime, owner: string): Promise<boolean> {
  const now = runtime.now();
  const current = await readRecord<{ owner: string; until: number }>(runtime.kv, keys.lease);
  if (current && current.owner !== owner && current.until > now) return false;
  await writeRecord(runtime.kv, keys.lease, { owner, until: now + LEASE_MS });
  const check = await readRecord<{ owner: string }>(runtime.kv, keys.lease);
  return check?.owner === owner;
}

export async function releaseLease(runtime: Runtime, owner: string): Promise<void> {
  const current = await readRecord<{ owner: string }>(runtime.kv, keys.lease);
  if (current?.owner === owner) await runtime.kv.remove(keys.lease);
}

export async function dueWatchers(runtime: Runtime, watchers: ReadonlyArray<WatcherConfig>): Promise<WatcherConfig[]> {
  const now = runtime.now();
  const due: WatcherConfig[] = [];
  for (const watcher of watchers) {
    const state = await loadWatcher(runtime.kv, watcher.id);
    if (state.lastRunAt === undefined || now - state.lastRunAt >= watcher.everyMs) due.push(watcher);
  }
  return due;
}

export function startScheduler(
  runtime: Runtime,
  owner: string,
  run: (watcher: WatcherConfig, signal: AbortSignal) => Promise<unknown>,
): { stop(): Promise<void>; tick(): Promise<void> } {
  const queue = limiter(runtime.options.concurrency.watchers);
  const running = new Set<string>();
  const controller = new AbortController();
  let ticking = false;

  const tick = async () => {
    if (ticking || controller.signal.aborted) return;
    ticking = true;
    try {
      if (!(await acquireLease(runtime, owner))) return;
      for (const watcher of await dueWatchers(runtime, runtime.options.watchers)) {
        if (running.has(watcher.id)) continue;
        running.add(watcher.id);
        void queue(() => run(watcher, controller.signal))
          .catch((error) => runtime.log(`${watcher.id} failed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => running.delete(watcher.id));
      }
    } catch (error) {
      runtime.log(`scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  };

  const first = setTimeout(() => void tick(), 5_000);
  const timer = setInterval(() => void tick(), TICK_MS);
  return {
    tick,
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      controller.abort();
      await releaseLease(runtime, owner).catch(() => undefined);
    },
  };
}
