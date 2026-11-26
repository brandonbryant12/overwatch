import fc from "fast-check";
import * as Effect from "effect/Effect";
import { test, expect } from "./harness.ts";
import { Incident, ReportSignal } from "../src/domain/incident.ts";
import { WatcherId } from "../src/domain/ids.ts";
import { groupInbox, init, bounceOffer } from "../web/src/app.ts";
import { testService, watcher, seed, until, recordFinding } from "./fixtures/scenario.ts";

const actions = ["done", "later", "never", "undo", "finding", "deploy", "recur", "rise", "surge", "restart"] as const;
test(
  "generated owner decisions and observations preserve membership, the reason for return and its group across restarts",
  { timeout: 120_000 },
  async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...actions), { minLength: 5, maxLength: 12 }), async (generated) => {
        let f = await testService();
        try {
          const cluster = f.cluster;
          const id = await seed(f);
          const get = () => f.client((api) => api.Inbox.get("inbox"));
          const row = async () => (await get())?.items.find((i) => i.incidentId === id);
          const initial = await until(row, (x) => !!x);
          let disposition = "inbox",
            returned = false,
            finding = false;
          let severity = initial!.severity,
            count = initial!.occurrences,
            baseline = count,
            hidden = 0;
          let returns = 0;
          for (const [step, action] of [...generated, "undo", "done", "recur", "done", "recur", "done", "recur"].entries()) {
            let change = false;
            if (action === "restart") {
              const { dataDir } = f;
              await f.service.stop();
              f = await testService({ dataDir, deps: { exec: cluster.exec } });
            } else if (action === "undo") {
              await f.client((api) => api.Restore(id, {}));
              if (disposition !== "inbox") {
                disposition = "inbox";
                returned = false;
              }
            } else if (action === "done" || action === "later" || action === "never") {
              if (disposition !== "inbox") continue;
              if (action === "done") await f.client((api) => api.MarkDone(id, {}));
              if (action === "later") await f.client((api) => api.Defer(id, { waitsFor: "change" }));
              if (action === "never") await f.client((api) => api.Mute(id, {}));
              disposition = action;
              baseline = count;
              hidden = 0;
              returned = false;
            } else if (action === "finding") {
              await recordFinding(f, id, "payment timeout", "run_f" + step);
              finding = true;
              change = disposition === "later";
            } else if (action === "deploy") {
              cluster.state.image = "example/payments:v" + step;
              await f.service.collect(watcher);
              change = disposition === "later";
            } else {
              const delta = action === "surge" ? 50 : 1;
              // The seed is an error. Reducing severity in later reports must not itself cause a return.
              const reportSeverity = action === "rise" ? "error" : "warn";
              const stamp = Date.now() + 601_000 + step;
              await f.service.runtime.runPromise(
                Effect.gen(function* () {
                  const incidents = yield* Incident;
                  yield* incidents.send(
                    Incident.ref(id),
                    new ReportSignal({
                      app: "shop-api",
                      environment: "production",
                      watcher: WatcherId.make(watcher),
                      source: "pods",
                      fingerprint: "payment",
                      title: "payment timeout",
                      count: delta,
                      at: stamp,
                      severity: reportSeverity,
                    }),
                  );
                }) as Effect.Effect<void, never, never>,
              );
              count += delta;
              hidden += delta;
              change =
                disposition === "done" ||
                (disposition === "later" && hidden >= 5 && count >= baseline * 2) ||
                (disposition === "never" && count >= Math.max(10, baseline * 10));
              if (disposition === "done" && change) returns++;
              if (reportSeverity === "error") severity = "error";
            }
            if (change) {
              disposition = "inbox";
              returned = true;
            }
            const current = await until(
              row,
              (x) =>
                !!x &&
                x.disposition === disposition &&
                x.occurrences === count &&
                (!change || !!x.back) &&
                (!finding || x.verdict === "real"),
            );
            const model = { ...init({ session: "review" }).model, inbox: [current!], status: (await f.service.status()) as never };
            const groups = groupInbox(model);
            const visible = Object.entries(groups)
              .filter(([, rows]) => rows.some((r) => r.id === id))
              .map(([k]) => k);
            expect(visible).toEqual(disposition !== "inbox" ? [] : [returned || finding ? "needs" : "new"]);
            if (change) expect(current!.back?.trim().length).toBeGreaterThan(0);
            if (returns >= 3 && change && current!.back?.includes("happened again")) expect(bounceOffer(model, current!)).toBe(returns);
            expect(current!.severity).toBe(severity);
          }
        } finally {
          await f.service.stop();
        }
      }),
      { numRuns: 24, seed: 62188 },
    );
  },
);

test("a muted or deferred lower severity stays hidden on another equal reading and resurfaces on a severity rise", async () => {
  for (const way of ["never", "later"]) {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("info" as const, "warn" as const), fc.integer({ min: 1, max: 3 }), async (start, repeat) => {
        const f = await testService();
        try {
          const { IncidentId } = await import("../src/domain/ids.ts");
          const id = IncidentId.make("inc_notifications");
          const epoch = Date.now() - 1000;
          const send = (severity: "info" | "warn" | "error", at: number, count: number) =>
            f.service.runtime.runPromise(
              Effect.gen(function* () {
                const port = yield* Incident;
                yield* port.send(
                  Incident.ref(id),
                  new ReportSignal({
                    app: "shop-api",
                    environment: "production",
                    watcher: WatcherId.make(watcher),
                    source: "pods",
                    fingerprint: "queue",
                    title: "queue delay",
                    count,
                    at,
                    severity,
                  }),
                );
              }) as Effect.Effect<void, never, never>,
            );
          await send(start, epoch, 1);
          if (way === "never") await f.client((api) => api.Mute(id, {}));
          else await f.client((api) => api.Defer(id, { waitsFor: "worse" }));
          await send(start, epoch + 1, repeat);
          const get = async () => (await f.client((api) => api.Inbox.get("inbox")))?.items.find((r) => r.incidentId === id);
          await until(get, (r) => r?.disposition === way && r.occurrences === 1 + repeat);
          await send("error", epoch + 2, 1);
          const active = await until(get, (r) => r?.disposition === "inbox" && r.occurrences === repeat + 2);
          expect(active?.back).toMatch(/error/i);
          expect(active?.back).toContain(start);
        } finally {
          await f.service.stop();
        }
      }),
      { numRuns: 3, seed: 62188 },
    );
  }
});

test("a two-occurrence report straddling Done's grace boundary reports the one that happened after it", async () => {
  const f = await testService();
  try {
    const id = await seed(f);
    await f.client((api) => api.MarkDone(id, {}));
    const done = await f.service.read((db) =>
      Number(db.prepare("SELECT json_extract(data,'$.at') at FROM journal WHERE type='IncidentDone'").get()!.at),
    );
    const end = done + 600_000;
    await f.service.runtime.runPromise(
      Effect.gen(function* () {
        const port = yield* Incident;
        yield* port.send(
          Incident.ref(id),
          new ReportSignal({
            app: "shop-api",
            environment: "production",
            watcher: WatcherId.make(watcher),
            source: "pods",
            fingerprint: "payment",
            title: "payment timeout",
            count: 2,
            firstAt: end - 1,
            at: end + 1,
            severity: "error",
          }),
        );
      }) as Effect.Effect<void, never, never>,
    );
    const get = async () => (await f.client((api) => api.Inbox.get("inbox")))?.items.find((r) => r.incidentId === id);
    const row = await until(get, (r) => !!r?.back && r.disposition === "inbox");
    expect(row!.back).toMatch(/\b(1|one|once)\b/i);
  } finally {
    await f.service.stop();
  }
});
