import { once } from "node:events";
import fc from "fast-check";
import { test, expect } from "../harness.ts";
import { tempDir } from "../fixtures/support.ts";
import { backup, restore } from "../../src/service/backup.ts";
import { join, watcher, testService, offline, seed, until, threadIdOf } from "./support.ts";

const cuts = ["BEFORE INSERT ON checkpoints", "BEFORE INSERT ON pending_reports", "BEFORE DELETE ON pending_reports"] as const;
for (const cut of cuts) {
  test("real collector receipts survive interruption " + cut, async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), fc.boolean(), async (before, late, reverse) => {
        let f = await testService();
        const { cluster, dataDir } = f;
        const t = Date.now() - 10_000;
        const add = (i: number) => cluster.log(t + i, "ERROR payment " + (40 + i) + " timed out after 300ms");
        try {
          for (let i = 0; i < before; i++) add(i);
          await f.service.atomically((db) =>
            db.exec("CREATE TRIGGER pending_cut " + cut + " BEGIN SELECT RAISE(ABORT,'fixture interrupted'); END"),
          );
          await expect(f.service.collect(watcher)).rejects.toThrow("fixture interrupted");
          await f.service.stop();
          f = await testService({ dataDir, deps: { exec: cluster.exec } });
          await f.service.atomically((db) => db.exec("DROP TRIGGER pending_cut"));
          const additions = Array.from({ length: late }, (_, i) => before + i);
          for (const i of reverse ? additions.reverse() : additions) add(i);
          await f.service.collect(watcher);
          await f.service.collect(watcher);
          const values = await f.service.read((db) =>
            db
              .prepare("SELECT type,json_extract(data,'$.count') AS n FROM journal WHERE type IN ('IncidentOpened','SignalRecurred')")
              .all(),
          );
          expect(values.filter((v) => v.type === "IncidentOpened")).toHaveLength(1);
          expect(values.reduce((n, v) => n + Number(v.n), 0)).toBe(before + late);
          expect(await f.service.read((db) => db.prepare("SELECT count(*) n FROM pending_reports").get()!.n)).toBe(0);
        } finally {
          await f.service.stop();
        }
      }),
      { numRuns: 3, seed: 62188 },
    );
  });
}

test("a live backup at dispatch restores the same inbox, search and work, with one external start", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom("done", "never", "later"), async (way) => {
      let connected = false;
      const starts: string[] = [];
      const prompts: string[] = [];
      const port = {
        ...offline,
        connect: async () => (connected ? "http://opencode.test" : undefined),
        createSession: async (i: { id: string }) => {
          starts.push(i.id);
        },
        prompt: async (i: { id: string }) => {
          prompts.push(i.id);
        },
        promptState: async () => ({ kind: "running" as const }),
      };
      let f = await testService({ opencode: port });
      try {
        const id = await seed(f);
        const thread = threadIdOf(id);
        const view = () => f.client((api) => api.Inbox.get("inbox"));
        await until(view, (v) => !!v?.items.some((x) => x.incidentId === id));
        if (way === "done") await f.client((api) => api.MarkDone(id, {}));
        else if (way === "never") await f.client((api) => api.Mute(id, {}));
        else await f.client((api) => api.Defer(id, { waitsFor: "worse" }));
        await f.client((api) =>
          api.AskThread(thread, {
            subject: id,
            title: "payments",
            text: "why?",
            promptId: "restored-question",
            mode: "investigate",
            origin: "page",
            override: "new",
          }),
        );
        const file = join(tempDir("pending-backup"), "backup.sqlite");
        connected = true;
        await until(
          async () => {
            await f.service.work();
            return prompts.length;
          },
          (n) => n === 1,
        );
        // Capture immediately after dispatch, without first letting ThreadPage or PendingRuns catch up.
        backup(join(f.dataDir, "overwatch.sqlite"), file);
        const expected = await until(view, (v) => v?.items.find((x) => x.incidentId === id)?.disposition === way);
        const search = () => f.client((api) => api.Search({ text: "payment" }));
        const hits = await until(search, (v) => v.length > 0);
        await f.service.stop();
        const dir = tempDir("pending-restored");
        restore(file, join(dir, "overwatch.sqlite"));
        f = await testService({ dataDir: dir, opencode: port });
        const restoredThread = () => f.client((api) => api.ThreadPage.get(thread));
        await until(restoredThread, (v) => !!v?.prompts.some((p) => p.promptId === "restored-question" && p.status === "sent"));
        expect((await view())?.items).toEqual(expected?.items);
        expect(await search()).toEqual(hits);
        for (let i = 0; i < 3; i++) await f.service.work();
        expect(prompts).toHaveLength(1);
        expect(starts).toHaveLength(1);
        const status = await f.service.status();
        expect(status.opencode).toMatchObject({ runningRuns: 1, waitingRuns: 0 });
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 3, seed: 62188 },
  );
});

test(
  "process death at checkpoint, intent, domain write or acknowledgement counts the changed upstream exactly once",
  { timeout: 100_000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const child = fileURLToPath(new URL("./outbox-child.ts", import.meta.url));
    for (const point of ["checkpoint", "intent", "event", "acknowledgement"]) {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), async (n, extra) => {
          const dir = tempDir("pending-power");
          const epoch = Date.now() - 10_000;
          const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", child, dir, point, String(epoch), String(n)], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let errors = "";
          p.stderr.on("data", (chunk) => (errors += String(chunk)));
          const [code, signal] = await once(p, "exit");
          if (signal !== "SIGKILL") throw Error("Unexpected child exit " + code + ": " + errors);
          const f = await testService({ dataDir: dir });
          try {
            for (let i = n + extra - 1; i >= 0; i--) f.cluster.log(epoch + i, "ERROR payment " + (42 + i) + " timed out after 300ms");
            await f.service.collect(watcher);
            await f.service.collect(watcher);
            const total = await f.service.read(
              (db) =>
                db
                  .prepare("SELECT sum(json_extract(data,'$.count')) n FROM journal WHERE type IN ('IncidentOpened','SignalRecurred')")
                  .get()!.n,
            );
            expect(total).toBe(n + extra);
          } finally {
            await f.service.stop();
          }
        }),
        { numRuns: 2, seed: 62188 },
      );
    }
  },
);

test("a changed upstream tail after a durable report survives log grouping's sampling limit", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 201, max: 230 }), fc.integer({ min: 1, max: 6 }), async (initial, more) => {
      let f = await testService();
      const { cluster, dataDir } = f;
      const epoch = Date.now() - 3000;
      const add = (n: number) => cluster.log(epoch + n, "ERROR payment " + (42 + n) + " timed out after 300ms");
      try {
        for (let n = 0; n < initial; n++) add(n);
        await f.service.atomically((db) =>
          db.exec("CREATE TRIGGER interrupt_delivery BEFORE DELETE ON pending_reports BEGIN SELECT RAISE(ABORT,'fixture restart'); END"),
        );
        await expect(f.service.collect(watcher)).rejects.toThrow("fixture restart");
        await f.service.stop();
        f = await testService({ dataDir, deps: { exec: cluster.exec } });
        await f.service.atomically((db) => db.exec("DROP TRIGGER interrupt_delivery"));
        for (let n = initial; n < initial + more; n++) add(n);
        await f.service.collect(watcher);
        await f.service.collect(watcher);
        const applied = await f.service.read((db) =>
          Number(
            db.prepare("SELECT sum(json_extract(data,'$.count')) n FROM journal WHERE type IN ('IncidentOpened','SignalRecurred')").get()!
              .n,
          ),
        );
        expect(applied).toBe(initial + more);
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 3, seed: 62188 },
  );
});

test("work queued while offline is still pending after restore and starts once when OpenCode returns", async () => {
  let online = false;
  const starts: string[] = [],
    prompts: string[] = [];
  const port = {
    ...offline,
    connect: async () => (online ? "http://opencode.test" : undefined),
    createSession: async (p: { id: string }) => {
      starts.push(p.id);
    },
    prompt: async (p: { id: string }) => {
      prompts.push(p.id);
    },
    promptState: async () => ({ kind: "running" as const }),
  };
  let f = await testService({ opencode: port });
  try {
    const id = await seed(f);
    const ask = (promptId: string) =>
      f.client((api) =>
        api.AskThread(threadIdOf(id), {
          subject: id,
          title: "Queue",
          text: "Investigate " + promptId,
          promptId,
          mode: "investigate",
          origin: "page",
          override: "new",
        }),
      );
    await ask("queued-one");
    await ask("queued-two");
    const waiting = async () => {
      await f.service.work();
      return (await f.service.status()).opencode as { waitingRuns: number; runningRuns: number };
    };
    const original = await until(waiting, (s) => s.waitingRuns === 2);
    const file = join(tempDir("pending-queue"), "backup.sqlite");
    backup(join(f.dataDir, "overwatch.sqlite"), file);
    await f.service.stop();
    const dir = tempDir("pending-restored-queue");
    restore(file, join(dir, "overwatch.sqlite"));
    f = await testService({ dataDir: dir, opencode: port });
    const restored = await until(waiting, (s) => s.waitingRuns === 2);
    expect(restored.runningRuns).toBe(original.runningRuns);
    expect(starts).toEqual([]);
    online = true;
    await until(waiting, (s) => s.runningRuns === 2 && s.waitingRuns === 0);
    await f.service.work();
    await f.service.work();
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(new Set(prompts).size).toBe(2);
  } finally {
    await f.service.stop();
  }
});
