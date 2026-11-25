import { test, expect } from "../harness.ts";
import { seed, testService, watcher, until } from "./support.ts";
import { withPage } from "./page.ts";

test("a delayed deploy reaction can only wake a Later that was already in force when the deploy occurred", async () => {
  let unblock!: () => void,
    blocked = false;
  const gate = new Promise<void>((ok) => {
    unblock = ok;
  });
  const f = await testService({
    deps: {
      notify: async () => {
        blocked = true;
        await gate;
      },
    },
  });
  try {
    const id = await seed(f);
    await until(async () => blocked, Boolean);
    f.cluster.state.image = "example/shop:release-two";
    await f.service.collect(watcher);
    const pos = await f.service.read((db) =>
      Number(db.prepare("SELECT max(position) n FROM journal WHERE type='DeployObserved'").get()!.n),
    );
    expect(pos).toBeGreaterThan(0);
    await f.client((api) => api.Defer(id, { waitsFor: "change" }));
    const row = async () => (await f.client((api) => api.Inbox.get("inbox")))?.items.find((x) => x.incidentId === id);
    await until(row, (x) => x?.disposition === "later");
    unblock();
    await until(
      () => f.service.read((db) => Number(db.prepare("SELECT position FROM projections WHERE name='changes'").get()?.position ?? 0)),
      (n) => n >= pos,
    );
    expect(
      await f.service.read(
        (db) => db.prepare("SELECT count(*) n FROM journal WHERE type='IncidentCameBack' AND stream=?").get("Incident/" + id)!.n,
      ),
    ).toBe(0);
    expect((await row())?.disposition).toBe("later");
    f.cluster.state.image = "example/shop:release-three";
    await f.service.collect(watcher);
    const back = await until(row, (x) => x?.disposition === "inbox" && !!x.back);
    expect(back!.back).toContain("release-three");
  } finally {
    unblock();
    await f.service.stop();
  }
});

test("two open tabs keep both seen marks when different incidents are read", async () => {
  const f = await testService();
  try {
    const a = await seed(f, "ERROR checkout provider stopped");
    const b = await seed(f, "ERROR inventory update timed out");
    expect(a).not.toBe(b);
    await withPage(f.service.url, async (evaluate, openSibling) => {
      const n = "document.querySelectorAll('.inbox-item[data-incident]').length";
      await until(
        () => evaluate(n),
        (v) => v === "2",
      );
      const peer = await openSibling();
      await until(
        () => peer(n),
        (v) => v === "2",
      );
      const selector = (id: string) => JSON.stringify('.inbox-item[data-incident="' + id + '"]');
      await evaluate("document.querySelector(" + selector(a) + ").click()");
      const marks = "Object.keys(JSON.parse(localStorage.getItem('overwatch.seen')||'{}'))";
      await until(
        () => evaluate(marks + ".includes(" + JSON.stringify(a) + ")"),
        (v) => v === "true",
      );
      await peer("document.querySelector(" + selector(b) + ").click()");
      await until(
        () => evaluate(marks + ".includes(" + JSON.stringify(b) + ")"),
        (v) => v === "true",
      );
      const seen = JSON.parse(await evaluate("JSON.stringify(" + marks + ")"));
      expect(seen).toContain(a);
      expect(seen).toContain(b);
    });
  } finally {
    await f.service.stop();
  }
});

test("a deploy immediately after Later wakes it even when the inbox subscriber has not acknowledged Later", async () => {
  const f = await testService();
  try {
    const id = await seed(f);
    const get = async () => (await f.client((api) => api.Inbox.get("inbox")))?.items.find((r) => r.incidentId === id);
    await until(get, (row) => row?.disposition === "inbox");
    for (let n = 0; n < 5; n++) {
      await f.client((api) => api.Defer(id, { waitsFor: "change" }));
      f.cluster.state.image = "example/shop:release-immediate-" + n;
      await f.service.collect(watcher);
      const positions = await f.service.read((db) =>
        db
          .prepare("SELECT type, max(position) p FROM journal WHERE type IN ('DeployObserved','IncidentDeferred') GROUP BY type ORDER BY p")
          .all(),
      );
      expect(positions.map((r) => r.type)).toEqual(["IncidentDeferred", "DeployObserved"]);
      const pos = Number(positions[1]!.p);
      await until(
        () => f.service.read((db) => Number(db.prepare("SELECT position FROM projections WHERE name='changes'").get()?.position ?? 0)),
        (x) => x >= pos,
      );
      const returns = await f.service.read((db) =>
        db.prepare("SELECT data FROM journal WHERE type='IncidentCameBack' AND stream=? AND position>?").all("Incident/" + id, pos),
      );
      expect(returns).toHaveLength(1);
      expect(String(returns[0]!.data)).toContain("release-immediate-" + n);
      await until(get, (row) => row?.disposition === "inbox" && !!row.back);
    }
  } finally {
    await f.service.stop();
  }
});
