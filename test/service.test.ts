/**
 * The service in process, with a fake cluster and OpenCode not running: phase 1A acceptance tests 2 (detect once),
 * 3 (live page and never twice) and 7 (restore). Tests 4, 5, 6 and 8 need a real OpenCode server: scripts/e2e.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { IncidentId, OverwatchApi, threadIdOf } from "../src/domain/index.ts";
import { backup, clearSearch, restore } from "../src/service/backup.ts";
import { testService } from "./fixtures/service.ts";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const MIN = 60_000;
const journal = (service: { read: <A>(f: (db: import("node:sqlite").DatabaseSync) => A) => Promise<A> }) =>
  service.read((db) => db.prepare("SELECT stream, type, data FROM journal ORDER BY position").all() as Array<{ stream: string; type: string; data: string }>);
const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 10_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("2. detect once", () => {
  test("overlapping polls create one incident and count each occurrence once; a poll with nothing new writes no event", async () => {
    const { service, cluster } = await testService();
    try {
      const now = Date.now();
      cluster.log(now - 10 * MIN, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      // The next poll starts two minutes before the checkpoint, so it reads the first line again, and one new one.
      cluster.log(Date.now() - 1_000, "ERROR payment 77 timed out after 300ms");
      await service.collect("shop-api/production");
      const before = await journal(service);
      expect(before.filter((e) => e.type === "IncidentOpened")).toHaveLength(1);
      const recurred = before.filter((e) => e.type === "SignalRecurred").map((e) => JSON.parse(e.data));
      expect(recurred.map((e) => e.count)).toEqual([1]);
      expect(recurred[0].occurrences).toBe(2);
      await service.collect("shop-api/production");
      expect(await journal(service)).toHaveLength(before.length);
    } finally {
      await service.stop();
    }
  });

  test("asleep across three intervals: one catch-up run, covered windows and the gap are explicit, one triage intent", async () => {
    const { service, cluster } = await testService({ config: { lookback: { initial: "30m", slice: "10m", overlap: "2m", max: "35m" } } });
    try {
      const now = Date.now();
      // The watcher last checked 45 minutes ago and has been asleep since: four 10-minute intervals missed.
      await service.atomically((db) => {
        db.prepare("INSERT INTO checkpoints (watcher, source, at, seen) VALUES ('shop-api/production', 'pods', ?, '{}')").run(now - 45 * MIN);
        db.prepare("UPDATE watcher_runs SET next_at = ? WHERE watcher = 'shop-api/production'").run(now - 35 * MIN);
      });
      for (const ago of [30, 22, 14, 6]) cluster.log(now - ago * MIN, "ERROR payment 42 timed out after 300ms");
      const runs = await service.pollDue();
      expect(runs).toHaveLength(1);
      const summary = runs[0]!;
      // Covered: the last 35 minutes, in 10-minute slices, contiguous and oldest first.
      const covered = summary.windows.filter((w) => w.status === "ok");
      expect(covered.length).toBe(4);
      for (let i = 1; i < covered.length; i++) expect(covered[i]!.from).toBe(covered[i - 1]!.to);
      expect(covered.at(-1)!.to).toBe(summary.startedAt);
      // Not covered: from the checkpoint (less the overlap) to where the lookback limit cut it off.
      expect(summary.gaps).toHaveLength(1);
      expect(summary.gaps[0]!.to).toBe(covered[0]!.from);
      expect(summary.gaps[0]!.from).toBe(now - 45 * MIN - 2 * MIN);
      const rows = await service.read((db) => db.prepare("SELECT status FROM coverage WHERE watcher = 'shop-api/production' ORDER BY from_at").all() as Array<{ status: string }>);
      expect(rows.map((r) => r.status)).toEqual(["gap", "ok", "ok", "ok", "ok"]);
      const events = await journal(service);
      expect(events.filter((e) => e.type === "CoverageGapRecorded")).toHaveLength(1);
      expect(events.filter((e) => e.type === "IncidentOpened")).toHaveLength(1);
      // The triage intent is recorded by a policy, after the incident opens.
      const isTriage = (e: { type: string; data: string }) => e.type === "PromptAsked" && JSON.parse(e.data).promptId === "triage";
      const triage = await until(() => journal(service), (all) => all.some(isTriage));
      expect(triage.filter(isTriage)).toHaveLength(1);
      // Waking again finds nothing new and asks nothing new.
      await service.collect("shop-api/production");
      await new Promise((r) => setTimeout(r, 300));
      expect((await journal(service)).filter((e) => e.type === "PromptAsked")).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });
});

describe("3. live page and never twice", () => {
  test("a collector run shows on an open watch without a reload; archive removes it; the same signal updates it silently", async () => {
    const webDir = tempDir("web");
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Overwatch</title>");
    const { service, cluster, client } = await testService({ deps: { webDir } });
    const seen: Array<{ state: { items: ReadonlyArray<{ incidentId: string; occurrences: number }> } | null }> = [];
    const watch = Effect.runFork(
      Effect.gen(function* () {
        const api = yield* OverwatchApi.client;
        yield* (api as any).Inbox.watch("inbox").pipe(Stream.runForEach((v: any) => Effect.sync(() => seen.push(v))));
      }).pipe(Effect.scoped, Effect.provide(Domain.protocolHttp(`${service.url}/api`).pipe(Layer.provide(FetchHttpClient.layer)))) as Effect.Effect<void, unknown, never>,
    );
    try {
      const page = await fetch(`${service.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>Overwatch</title>");
      cluster.log(Date.now() - 5 * MIN, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      const shown = await until(async () => seen.at(-1)?.state?.items ?? [], (items) => items.length === 1).catch((e) => {
        throw new Error(`${(e as Error).message}; seen ${JSON.stringify(seen).slice(0, 500)}`);
      });
      const incidentId = IncidentId.make(shown[0]!.incidentId);
      await client((api) => api.ArchiveIncident(incidentId, {}));
      await until(async () => seen.at(-1)?.state?.items ?? [], (items) => items.length === 0);
      cluster.log(Date.now() - 1_000, "ERROR payment 43 timed out after 300ms");
      await service.collect("shop-api/production");
      const updated = await until(
        () => client((api) => api.IncidentPage.get(incidentId)) as Promise<any>,
        (p) => p?.occurrences === 2,
      );
      expect(updated.disposition).toBe("archived");
      await new Promise((r) => setTimeout(r, 300));
      expect(seen.at(-1)?.state?.items).toEqual([]);
      expect(((await client((api) => api.Inbox.get("inbox"))) as any).items).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(watch));
      await service.stop();
    }
  });

  test("the service answers only on loopback, and refuses requests from another origin", async () => {
    const { service } = await testService();
    try {
      const wrongHost = await new Promise<number>((resolve) => {
        const req = request(`${service.url}/health`, { headers: { host: "evil.example" } }, (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
      expect(wrongHost).toBe(403);
      const crossOrigin = await fetch(`${service.url}/health`, { headers: { origin: "http://evil.example" } });
      expect(crossOrigin.status).toBe(403);
      expect((await fetch(`${service.url}/health`)).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});

describe("7. restore", () => {
  test("rebuild search and restore from a backup: the incident is searchable, the inbox stays quiet, no work starts twice", async () => {
    const calls: string[] = [];
    const recording = {
      connect: async () => "http://opencode.test",
      createSession: async (input: { id: string }) => void calls.push(`create ${input.id}`),
      prompt: async (input: { id: string }) => void calls.push(`prompt ${input.id}`),
      synthetic: async (input: { id: string }) => void calls.push(`synthetic ${input.id}`),
      newUserMessages: async () => [],
      promptState: async () => ({ kind: "running" as const }),
      interrupt: async () => undefined,
      answer: async () => undefined,
    };
    const first = await testService({ opencode: recording, config: { opencode: { autoInvestigate: true } } });
    const now = Date.now();
    first.cluster.log(now - 20 * MIN, "ERROR payment 42 timed out after 300ms");
    first.cluster.log(now - 19 * MIN, "WARN cache miss storm on key prices");
    first.cluster.log(now - 18 * MIN, "ERROR cache miss storm on key prices");
    await first.service.collect("shop-api/production");
    const inbox = await until(() => first.client((api) => api.Inbox.get("inbox")) as Promise<any>, (v) => v?.items.length === 2);
    const archived = inbox.items.find((i: any) => i.title.includes("cache")).incidentId as string;
    const kept = inbox.items.find((i: any) => i.title.includes("payment")).incidentId as string;
    await first.client((api) => api.ArchiveIncident(IncidentId.make(archived), {}));
    // The triage runs are dispatched once.
    await until(async () => (await first.service.work(), calls.length), (n) => n >= 4);
    await first.service.work();
    expect(calls).toHaveLength(4);
    const dispatched = [...calls];
    const dataDir = first.dataDir;
    const file = join(tempDir("backup"), "overwatch.backup.sqlite");
    backup(join(dataDir, "overwatch.sqlite"), file);
    await first.service.stop();

    // A new machine: restore the backup, forget the search index, start.
    const restoredDir = tempDir("restored");
    mkdirSync(restoredDir, { recursive: true });
    restore(file, join(restoredDir, "overwatch.sqlite"));
    clearSearch(join(restoredDir, "overwatch.sqlite"));
    calls.length = 0;
    const second = await testService({ dataDir: restoredDir, opencode: recording, config: { opencode: { autoInvestigate: true } } });
    try {
      second.cluster.lines.push(...first.cluster.lines);
      await second.service.collect("shop-api/production");
      await second.service.work();
      await second.service.work();
      expect(calls).toEqual([]);
      const after = (await second.client((api) => api.Inbox.get("inbox"))) as any;
      expect(after.items.map((i: any) => i.incidentId)).toEqual([kept]);
      const byWords = (await second.client((api) => api.Search({ text: "cache storm" }))) as any[];
      expect(byWords.some((hit) => hit.kind === "incident" && hit.id === archived && hit.state === "archived")).toBe(true);
      const byId = (await second.client((api) => api.Search({ text: kept }))) as any[];
      expect(byId[0]?.id).toBe(kept);
      const thread = (await second.client((api) => api.ThreadPage.get(threadIdOf(IncidentId.make(kept))))) as any;
      expect(thread.prompts[0].status).toBe("sent");
      expect(dispatched).toHaveLength(4);
    } finally {
      await second.service.stop();
    }
  });
});
