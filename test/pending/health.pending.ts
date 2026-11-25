import fc from "fast-check";
import { test, expect } from "../harness.ts";
import { fakeCluster } from "../fixtures/cluster.ts";
import { allQuiet, environmentChips } from "../../web/src/app.ts";
import type { ServiceStatus, EnvironmentStatus } from "../../src/domain/status.ts";
import { testService, watcher } from "./support.ts";
import type { Exec } from "../../src/collect/exec.ts";

test("one unhealthy environment prevents an all-clear, including stale individual samples under a fresh checkpoint", async () => {
  const f = await testService();
  try {
    await f.service.collect(watcher);
    const snapshot = (await f.service.status()) as unknown as ServiceStatus;
    const healthy = snapshot.environments[0]!;
    expect(allQuiet({ inbox: [], status: snapshot })).toBe(true);
    const faults = ["unchecked", "failed", "stale", "suspended", "missing", "old sample", "unknown"] as const;
    for (const fault of faults)
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 1, max: 5 }), (at, n) => {
          const envs: EnvironmentStatus[] = Array.from({ length: n }, (_, i) => ({ ...healthy, environment: "env" + i }));
          const i = at % n;
          const m = healthy.memoryPctOfLimit!;
          const old = snapshot.at - healthy.everyMs * 4;
          const examples: Record<(typeof faults)[number], Partial<EnvironmentStatus>> = {
            unchecked: { checkedThrough: null },
            failed: { lastError: "unavailable" },
            stale: { checkedThrough: old },
            suspended: { suspended: { words: "signed out", since: old } },
            missing: { memoryPctOfLimit: null },
            "old sample": { memoryPctOfLimit: { ...m, sampledAt: old } },
            unknown: { memoryPctOfLimit: { ...m, state: "unknown" } },
          };
          envs[i] = { ...envs[i]!, ...examples[fault] };
          const input = { inbox: [], status: { ...snapshot, environments: envs } };
          expect(allQuiet(input)).toBe(false);
          expect(environmentChips(input).find((c) => c.environment === envs[i]!.environment)?.state).not.toBe("quiet");
        }),
        { numRuns: 6, seed: 62188 },
      );
  } finally {
    await f.service.stop();
  }
});

for (const kind of ["signin", "unreachable"] as const) {
  test(kind + " backoff survives restart, suspends once, and recovers automatically without losing incidents", async () => {
    const cluster = fakeCluster();
    let broken = false,
      attempts = 0;
    const exec: Exec = async (bin, args, opts) => {
      if (broken && bin === "kubectl") {
        attempts++;
        return {
          code: 1,
          stdout: "",
          stderr: kind === "signin" ? "Unauthorized: You must be logged in to the server" : "i/o timeout",
          killed: false,
        };
      }
      return cluster.exec(bin, args, opts);
    };
    let f = await testService({ deps: { exec } });
    try {
      cluster.log(Date.now() - 1000, "ERROR checkout unavailable");
      await f.service.collect(watcher);
      broken = true;
      await f.service.collect(watcher);
      const state = () =>
        f.service.read((db) => db.prepare("select key,kind,streak,next_at,suspended_at from connections order by key").all());
      const before = await state();
      await f.service.stop();
      f = await testService({ dataDir: f.dataDir, deps: { exec } });
      expect(await state()).toEqual(before);
      await f.service.collect(watcher);
      if (kind === "unreachable") {
        const s = (await f.service.status()) as unknown as ServiceStatus;
        expect(environmentChips({ status: s, inbox: [] })[0]!.state).not.toBe("quiet");
      }
      for (let i = 0; i < 6 && !(await state()).some((c) => c.suspended_at !== null); i++) {
        await f.service.probeNow("simulated network change");
        await f.service.collect(watcher);
      }
      const n = attempts;
      if (kind === "signin") expect((await state()).find((c) => c.kind === "signin")?.streak).toBe(2);
      await f.service.collect(watcher);
      expect(attempts).toBe(n);
      const status = (await f.service.status()) as unknown as ServiceStatus;
      expect(status.causes).toHaveLength(1);
      expect(status.causes[0]!.id).not.toBe("offline");
      expect(environmentChips({ status, inbox: [] })[0]!.state).toBe("suspended");
      expect(await f.service.read((db) => db.prepare("select count(*) n from journal where type='SourceSuspended'").get()!.n)).toBe(1);
      broken = false;
      await f.service.probeNow("wake");
      await f.service.collect(watcher);
      expect((await f.service.status()).causes).toEqual([]);
      const events = await f.service.read((db) =>
        db
          .prepare("select type from journal where type in ('SourceResumed','IncidentDone','IncidentCameBack')")
          .all()
          .map((x) => x.type),
      );
      expect(events).toEqual(["SourceResumed"]);
    } finally {
      await f.service.stop();
    }
  });
}

test("a healthy Kubernetes source cannot mask missing telemetry from another watched source in the same environment", async () => {
  const { startService } = await import("../../src/service/service.ts");
  const { parseConfig } = await import("../../src/service/config.ts");
  const { tempDir } = await import("../fixtures/support.ts");
  const { offline } = await import("./support.ts");
  const a = fakeCluster(),
    b = fakeCluster();
  b.state.top = false;
  const source = (context: string) => ({ type: "kubernetes", context, namespace: "shop", selector: "app=shop" });
  const config = parseConfig({
    dataDir: tempDir("pending-two-sources"),
    notify: false,
    apps: {
      shop: { checkout: tempDir("pending-app"), environments: { production: { sources: { first: source("a"), second: source("b") } } } },
    },
    watchers: [{ app: "shop", environment: "production" }],
  });
  expect(config.errors).toEqual([]);
  const svc = await startService(config, {
    port: 0,
    background: false,
    opencode: offline,
    log: () => {},
    exec: (bin, args, opts) => (args.includes("b") ? b : a).exec(bin, args, opts),
  });
  try {
    await svc.collect("shop/production");
    const status = (await svc.status()) as unknown as ServiceStatus;
    expect(status.environments[0]!.checkedThrough).not.toBe(null);
    expect(allQuiet({ status, inbox: [] })).toBe(false);
    expect(environmentChips({ status, inbox: [] })[0]!.state).not.toBe("quiet");
  } finally {
    await svc.stop();
  }
});

test("an unmeasured command source backing off keeps its last failure visible during a skipped poll", async () => {
  const { startService } = await import("../../src/service/service.ts");
  const { parseConfig } = await import("../../src/service/config.ts");
  const { tempDir } = await import("../fixtures/support.ts");
  const { offline } = await import("./support.ts");
  const dataDir = tempDir("pending-backoff");
  const config = parseConfig({
    apps: {
      shop: { checkout: dataDir, environments: { production: { sources: { feed: { type: "command", command: ["fixture-feed"] } } } } },
    },
    watchers: [{ app: "shop", environment: "production" }],
    dataDir,
    notify: false,
  });
  expect(config.errors).toEqual([]);
  let down = false,
    calls = 0;
  const svc = await startService(config, {
    port: 0,
    background: false,
    opencode: offline,
    log: () => {},
    exec: async () => {
      calls++;
      return { code: down ? 1 : 0, stdout: "", stderr: down ? "i/o timeout" : "", killed: false };
    },
  });
  try {
    await svc.collect("shop/production");
    down = true;
    await svc.collect("shop/production");
    const atFailure = calls;
    await svc.collect("shop/production");
    expect(calls).toBe(atFailure);
    const status = (await svc.status()) as unknown as ServiceStatus;
    expect(allQuiet({ status, inbox: [] })).toBe(false);
    expect(environmentChips({ status, inbox: [] })[0]!.state).not.toBe("quiet");
  } finally {
    await svc.stop();
  }
});

test("the rendered all-clear expires when a sleeping tab wakes and status refresh fails", async () => {
  const { withPage } = await import("./page.ts");
  const { until } = await import("./support.ts");
  const f = await testService();
  try {
    await f.service.collect(watcher);
    await withPage(f.service.url, async (evaluate) => {
      const green = "document.querySelectorAll('[data-all-quiet=true]').length";
      await until(
        () => evaluate(green),
        (v) => Number(v) > 0,
      );
      await evaluate(`(()=>{
      const clock=Date.now;Date.now=()=>clock()+4*600_000;
      const original=window.fetch.bind(window);
      window.fixtureStatusFailures=0;
      window.fetch=(input,...rest)=>{
        if(new URL(input.url??input,location.href).pathname==='/status'){
          window.fixtureStatusFailures++;return Promise.resolve(new Response(null,{status:503}));
        }
        return original(input,...rest);
      };
   })()`);
      await until(
        () => evaluate("window.fixtureStatusFailures"),
        (v) => Number(v) >= 2,
        20_000,
      );
      expect(await evaluate(green)).toBe("0");
    });
  } finally {
    await f.service.stop();
  }
});
