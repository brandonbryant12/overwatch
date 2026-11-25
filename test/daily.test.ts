/**
 * The daily loop (plan 5.1 and 4.1): the inbox grouped by why, rows that stay put, the three ways out and their undo,
 * coming back with a reason, the all-quiet rule, and what happens when a connection keeps failing.
 */
import { IncidentId, threadIdOf } from "../src/domain/ids.ts";
import { afterFailure, classifyFailure } from "../src/collect/failures.ts";
import { parseOptions } from "../src/collect/options.ts";
import { causesOf } from "../src/service/causes.ts";
import type { ConnectionRow } from "../src/service/collector.ts";
import {
  allQuiet,
  arrangedInbox,
  bounceOffer,
  environmentChips,
  groupInbox,
  init,
  Message,
  notQuietBecause,
  parseLater,
  update,
  type Model,
} from "../web/src/app.ts";
import { describe, expect, test } from "./harness.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
const base = init({ session: "s" }).model;

const item = (id: string, over: Record<string, unknown> = {}) =>
  ({
    incidentId: IncidentId.make(id),
    title: id,
    app: "shop-api",
    environment: "production",
    severity: "error",
    firstAt: NOW - HOUR,
    lastAt: NOW - 60_000,
    occurrences: 3,
    verdict: null,
    cause: null,
    disposition: "inbox",
    way: null,
    back: null,
    changedAt: NOW - HOUR,
    running: 0,
    failure: null,
    recent: [],
    hidden: [],
    returns: [],
    ...over,
  }) as Model["inbox"][number];

const env = (over: Record<string, unknown> = {}): any => ({
  app: "shop-api",
  environment: "production",
  tier: "production" as const,
  everyMs: 600_000,
  checkedThrough: NOW - 60_000,
  lastError: null,
  expectsReadings: true,
  notReadyPods: { value: 0, limit: 0, state: "clear" as const, sampledAt: NOW - 60_000 },
  memoryPctOfLimit: { value: 40, limit: 90, state: "clear" as const, sampledAt: NOW - 60_000 },
  suspended: null,
  ...over,
});
const status = (environments: ReadonlyArray<ReturnType<typeof env>>, over: Record<string, unknown> = {}) =>
  ({
    name: "overwatch",
    version: "t",
    apiVersion: 2,
    configErrors: [],
    opencode: { connected: true, url: "x", checkedAt: NOW, waitingRuns: 0, runningRuns: 0 },
    watchers: [],
    checkpoints: [],
    environments,
    causes: [],
    offer: { after: 3, withinMs: 14 * 24 * HOUR },
    at: NOW,
    ...over,
  }) as unknown as NonNullable<Model["status"]>;

describe("B. the inbox grouped by why it needs you", () => {
  test("each row is in the first group that applies, with one line saying why", () => {
    const cause = { id: "kubernetes:prod", title: "prod is signed out", fix: "Sign in", since: NOW, updatedAt: NOW, environments: ["shop-api/production"] };
    const model = {
      ...base,
      status: status([env(), env({ environment: "staging", tier: "staging" })], { causes: [cause] }),
      seen: { inc_seen: NOW - HOUR },
      inbox: [
        item("inc_back", { back: "Back: happened again 3 times since you marked it done." }),
        item("inc_real", { verdict: "real", cause: "timeouts" }),
        item("inc_failed", { failure: "no finding within 20 minutes" }),
        item("inc_staging_real", { environment: "staging", verdict: "real" }),
        item("inc_working", { running: 1 }),
        item("inc_not_real", { verdict: "not_real" }),
        item("inc_new"),
        item("inc_seen"),
        item("inc_done", { disposition: "done" }),
      ],
    };
    const groups = groupInbox(model);
    const ids = (g: keyof typeof groups) => groups[g].map((row) => row.id);
    expect(ids("needs")).toEqual(["cause:kubernetes:prod", "inc_back", "inc_real", "inc_failed"]);
    expect(ids("working")).toEqual(["inc_working"]);
    expect(ids("new").sort()).toEqual(["inc_new", "inc_staging_real"]);
    expect(ids("quiet").sort()).toEqual(["inc_not_real", "inc_seen"]);
    expect(groups.needs[1]!.why).toBe("Back: happened again 3 times since you marked it done.");
    expect(groups.needs[0]!.why).toBe("Sign in");
    // A way out takes it out of every group.
    expect(Object.values(groups).flat().some((row) => row.id === "inc_done")).toBe(false);
  });
});

describe("C. rows never move while the owner looks", () => {
  test("a change updates a row in place; an arrival waits behind its group's line; showing them sorts", () => {
    const first = update({ ...base, status: status([env()]) }, Message.ReceivedInbox({ items: [item("inc_a", { severity: "warn" }), item("inc_b")] })).model;
    const order = (m: Model) => arrangedInbox(m).rows.new.map((row) => row.id);
    expect(order(first)).toEqual(["inc_b", "inc_a"]);
    // inc_a becomes an error (it would now sort first) and inc_c arrives: nothing moves, inc_c waits.
    const later = update(first, Message.ReceivedInbox({ items: [item("inc_a", { severity: "error", lastAt: NOW }), item("inc_b"), item("inc_c")] })).model;
    expect(order(later)).toEqual(["inc_b", "inc_a"]);
    expect(arrangedInbox(later).rows.new[1]!.kind === "incident" && (arrangedInbox(later).rows.new[1] as any).item.severity).toBe("error");
    expect(arrangedInbox(later).pending.new).toBe(1);
    // A row that came back moves group only when shown: it stays where it is until then.
    const back = update(later, Message.ReceivedInbox({ items: [item("inc_a", { severity: "error", lastAt: NOW }), item("inc_b", { back: "Back: now error." }), item("inc_c")] })).model;
    expect(order(back)).toEqual(["inc_b", "inc_a"]);
    expect(arrangedInbox(back).pending.needs).toBe(1);
    const shown = update(back, Message.PressedShowNew()).model;
    expect(arrangedInbox(shown).rows.needs.map((row) => row.id)).toEqual(["inc_b"]);
    expect(order(shown)).toEqual(["inc_a", "inc_c"]);
    expect(arrangedInbox(shown).pending).toEqual({ needs: 0, new: 0, working: 0, quiet: 0 });
  });
});

describe("A. the three ways out on the page", () => {
  test("Later parses a time, a change, or worse; anything else says exactly what to type", () => {
    const now = new Date(2026, 10, 25, 15, 30).getTime(); // a Wednesday, local time
    expect(parseLater("2h", now)).toEqual({ until: now + 2 * HOUR, label: "2h" });
    expect(parseLater(" 2 d ", now)).toEqual({ until: now + 48 * HOUR, label: "2d" });
    expect(parseLater("tomorrow", now)).toEqual({ until: new Date(2026, 10, 26, 9, 0).getTime(), label: "tomorrow" });
    expect(parseLater("monday", now)).toEqual({ until: new Date(2026, 10, 30, 9, 0).getTime(), label: "monday" });
    expect(parseLater("wed", now)).toEqual({ until: new Date(2026, 11, 2, 9, 0).getTime(), label: "wednesday" });
    expect(parseLater("", now)).toEqual({ until: null, waitsFor: "change", label: "until something changes" });
    expect(parseLater("worse", now)).toEqual({ until: null, waitsFor: "worse", label: "until it gets worse" });
    expect((parseLater("soonish", now) as { error: string }).error).toContain("Type 2h, 2d, tomorrow or monday");
  });

  test("Never shows what it would hide before it is sent; Later asks when; each says so with undo", () => {
    const model = update({ ...base, status: status([env()]), focus: IncidentId.make("inc_a") }, Message.ReceivedInbox({ items: [item("inc_a", { recent: [{ at: NOW - 3 * 24 * HOUR, count: 40 }, { at: NOW - 20 * 24 * HOUR, count: 99 }] })] })).model;
    const never = update(model, Message.PressedWayOut({ kind: "never" }));
    expect(never.commands ?? []).toHaveLength(0);
    expect(never.model.sheet).toEqual({ _tag: "Never", incidentId: "inc_a", reason: null });
    const reason = update(never.model, Message.ChoseMuteReason({ reason: "expected" })).model;
    const sent = update(reason, Message.ConfirmedSheet());
    expect(sent.commands).toHaveLength(1);
    expect((sent.commands![0] as any).args.input).toEqual({ actor: "owner (page)", reason: "expected" });
    expect(sent.model.notice).toBe("Never (expected). Press u to undo.");
    const later = update(model, Message.PressedWayOut({ kind: "later" }));
    const typed = update(later.model, Message.ChangedLaterText({ text: "nope" })).model;
    expect((update(typed, Message.ConfirmedSheet()).model.sheet as any).error).toContain("Type 2h");
    const worse = update(update(later.model, Message.ChangedLaterText({ text: "worse" })).model, Message.ConfirmedSheet());
    expect((worse.commands![0] as any).args.input).toEqual({ actor: "owner (page)", waitsFor: "worse", label: "until it gets worse" });
    const undo = update(worse.model, Message.PressedUndo());
    expect((undo.commands![0] as any).name).toBe("Restore");
  });

  test("a Done that came back three times in two weeks offers Later until it gets worse, or Never; it applies neither", () => {
    const model = { ...base, status: status([env()]) };
    const twice = item("inc_a", { back: "Back: happened again.", returns: [NOW - 2 * HOUR, NOW - HOUR] });
    const thrice = item("inc_a", { back: "Back: happened again.", returns: [NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR] });
    const stale = item("inc_a", { back: "Back: happened again.", returns: [NOW - 20 * 24 * HOUR, NOW - 2 * HOUR, NOW - HOUR] });
    expect(bounceOffer(model, twice)).toBe(null);
    expect(bounceOffer(model, thrice)).toBe(3);
    expect(bounceOffer(model, stale)).toBe(null);
    expect(bounceOffer({ ...model, status: status([env()], { offer: { after: 2, withinMs: 14 * 24 * HOUR } }) }, twice)).toBe(2);
  });
});

/** A tiny seeded generator, so a failing case can be replayed. */
function random(seed: number) {
  let x = seed;
  const next = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  return { next, pick: <T>(list: ReadonlyArray<T>): T => list[Math.floor(next() * list.length)]! };
}

describe("the all-quiet rule", () => {
  test("over generated states: nothing is called quiet while anything is stale, failing, suspended, unchecked, over a limit or missing a reading", () => {
    const reading = (r: ReturnType<typeof random>) =>
      r.pick([null, { value: null, limit: null, state: "unknown" }, { value: 0, limit: 0, state: "clear" }, { value: 3, limit: 0, state: "breach" }, { value: 50, limit: 90, state: "measured" }, { value: null, limit: 90, state: "no_data" }]);
    for (let seed = 1; seed <= 2000; seed++) {
      const r = random(seed);
      const environments = Array.from({ length: 1 + Math.floor(r.next() * 4) }, (_, i) =>
        env({
          environment: `env${i}`,
          everyMs: r.pick([60_000, 600_000]),
          checkedThrough: r.pick([null, NOW - 30_000, NOW - 2 * HOUR, NOW - 25 * 60_000]),
          lastError: r.pick([null, null, "failed: pods"]),
          expectsReadings: r.pick([true, false]),
          notReadyPods: reading(r),
          memoryPctOfLimit: reading(r),
          suspended: r.pick([null, null, null, { since: NOW - HOUR, words: "signed out" }]),
        }),
      );
      const inbox = r.next() < 0.3 ? [item("inc_x", { environment: r.pick(environments).environment, disposition: r.pick(["inbox", "done"]) })] : [];
      const model = { status: status(environments, { causes: r.next() < 0.1 ? [{ id: "c", title: "t", fix: "f", since: 0, updatedAt: 0, environments: [] }] : [] }), inbox };
      const chips = environmentChips(model);
      for (const e of environments) {
        const chip = chips.find((c) => c.environment === e.environment)!;
        const missing = e.expectsReadings && [e.notReadyPods, e.memoryPctOfLimit].some((m) => m === null || m.state === "unknown" || m.value === null);
        const breach = [e.notReadyPods, e.memoryPctOfLimit].some((m) => m?.state === "breach");
        const stale = e.checkedThrough !== null && NOW - e.checkedThrough > 3 * e.everyMs;
        const open = inbox.some((i) => i.environment === e.environment && i.disposition === "inbox");
        const bad = e.suspended !== null || e.lastError !== null || e.checkedThrough === null || stale || missing || breach || open;
        if (bad && chip.state === "quiet") throw new Error(`seed ${seed}: ${e.environment} shown quiet: ${JSON.stringify(e)}`);
        if (!bad && chip.state !== "quiet") throw new Error(`seed ${seed}: ${e.environment} not shown quiet though nothing is wrong: ${chip.label}`);
        expect(notQuietBecause(e, NOW, open ? 1 : 0) === null).toBe(!bad);
      }
      const anyBad = chips.some((c) => c.state !== "quiet") || model.status.causes.length > 0 || inbox.some((i) => i.disposition === "inbox");
      if (allQuiet(model) === anyBad) throw new Error(`seed ${seed}: allQuiet is ${allQuiet(model)} with ${JSON.stringify(chips.map((c) => c.label))}`);
    }
    // No status at all is not quiet either.
    expect(allQuiet({ status: null, inbox: [] })).toBe(false);
  });
});

describe("D. when something keeps failing", () => {
  test("failures are classified by what they say", () => {
    const cases: Array<[string, string]> = [
      ["error: You must be logged in to the server (Unauthorized)", "signin"],
      ["Datadog answered 403 Forbidden: API key is invalid", "signin"],
      ['pods is forbidden: User "me" cannot list resource "pods" in namespace "shop"', "permission"],
      ["HTTP 429 Too Many Requests; Retry-After: 30", "rate_limit"],
      ["Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout", "unreachable"],
      ["fetch failed (ENOTFOUND api.datadoghq.com)", "unreachable"],
      ['Error from server (NotFound): namespaces "shopp" not found', "config"],
      ["error: context \"prod\" does not exist", "config"],
      ["something nobody has seen before", "unreachable"],
    ];
    for (const [message, kind] of cases) expect(`${message} -> ${classifyFailure(message).kind}`).toBe(`${message} -> ${kind}`);
    expect(classifyFailure("429 rate limited, retry after 30 seconds").retryAfterMs).toBe(30_000);
  });

  test("sign-in stops after one confirming attempt; unreachable backs off to a ceiling, then suspends; rate limits wait as asked", () => {
    const limits = parseOptions({}).options.failures;
    const signin = { kind: "signin" as const };
    const once = afterFailure(undefined, signin, NOW, limits);
    expect(once).toEqual({ kind: "signin", streak: 1, nextAt: NOW, suspendedAt: null });
    expect(afterFailure(once, signin, NOW + 1, limits)).toEqual({ kind: "signin", streak: 2, nextAt: NOW + 1 + limits.ceilingMs, suspendedAt: NOW + 1 });
    let state: ReturnType<typeof afterFailure> | undefined;
    const waits: number[] = [];
    for (let i = 0; i < limits.attempts; i++) {
      state = afterFailure(state, { kind: "unreachable" }, NOW, limits);
      waits.push(state.nextAt - NOW);
    }
    expect(waits.slice(0, -1)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(state!.suspendedAt).toBe(NOW);
    expect(afterFailure(undefined, { kind: "rate_limit", retryAfterMs: 30_000 }, NOW, limits)).toEqual({ kind: "rate_limit", streak: 1, nextAt: NOW + 30_000, suspendedAt: null });
    expect(afterFailure(undefined, { kind: "config" }, NOW, limits).suspendedAt).toBe(NOW);
  });

  test("one item per cause: everything unreachable at once is one cause; OpenCode down with work waiting is one", () => {
    const options = parseOptions({
      apps: {
        a: { checkout: "/x", environments: { production: { sources: { pods: { type: "kubernetes", context: "prod", namespace: "a", selector: "app=a" } } } } },
        b: { checkout: "/x", environments: { staging: { sources: { pods: { type: "kubernetes", context: "stg", namespace: "b", selector: "app=b" } } } } },
      },
      watchers: [{ app: "a", environment: "production" }, { app: "b", environment: "staging" }],
    }).options;
    const row = (key: string, kind: string, suspended: number | null): ConnectionRow => ({ key, kind, streak: 5, next_at: NOW, suspended_at: suspended, first_failed_at: NOW - HOUR, last_error: "i/o timeout", fix: `fix ${key}`, config: "{}", updated_at: NOW });
    const offline = causesOf(options, [row("kubernetes:prod", "unreachable", NOW), row("kubernetes:stg", "unreachable", null)], { connected: true, waiting: 0, checkedAt: NOW });
    expect(offline.map((c) => c.id)).toEqual(["offline"]);
    expect(offline[0]!.title).toContain("Offline or off the VPN");
    const one = causesOf(options, [row("kubernetes:prod", "signin", NOW)], { connected: false, waiting: 2, checkedAt: NOW });
    expect(one.map((c) => c.id)).toEqual(["kubernetes:prod", "opencode"]);
    expect(one[0]!.title).toContain("a/production");
    expect(one[0]!.fix).toBe("fix kubernetes:prod");
    expect(one[1]!.title).toBe("OpenCode is not running: 2 investigations wait");
    // Backing off is not yet a cause: only a suspended connection is.
    expect(causesOf(options, [row("kubernetes:prod", "unreachable", null)], { connected: true, waiting: 0, checkedAt: NOW })).toEqual([]);
  });
});

describe("end to end through the service", () => {
  test("a signed-out connection: one confirming attempt, then suspended with one cause and its fix, not quiet; probed and resumed", { timeout: 60_000 }, async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { fakeCluster } = await import("./fixtures/cluster.ts");
    const cluster = fakeCluster();
    let signedOut = true;
    let kubectlCalls = 0;
    const exec = Object.assign(
      async (command: string, args: ReadonlyArray<string>, options: any) => {
        if (command === "kubectl") {
          kubectlCalls += 1;
          if (signedOut) return { code: 1, stdout: "", stderr: "error: You must be logged in to the server (Unauthorized)", killed: false };
        }
        return cluster.exec(command, args, options);
      },
      { calls: [] },
    );
    const { service } = await testService({ deps: { exec } as never });
    try {
      await service.collect("shop-api/production");
      const confirming = kubectlCalls;
      expect(confirming).toBeGreaterThan(0);
      expect(((await service.status()) as any).causes).toEqual([]);
      await service.collect("shop-api/production");
      const status = (await service.status()) as any;
      expect(status.causes).toHaveLength(1);
      expect(status.causes[0].fix).toContain("kubectl --context prod-cluster -n shop get pods");
      expect(status.environments[0].suspended.words).toBe("signed out");
      const chip = environmentChips({ status, inbox: [] })[0]!;
      expect(chip.state).toBe("suspended");
      expect(chip.label).toContain("Not checked since");
      // Suspended: it is not hammered.
      const before = kubectlCalls;
      await service.collect("shop-api/production");
      expect(kubectlCalls).toBe(before);
      // Signed in again; waking from sleep probes at once; the source resumes and the cause closes by itself.
      signedOut = false;
      await service.probeNow("woke from sleep");
      await service.collect("shop-api/production");
      expect(((await service.status()) as any).causes).toEqual([]);
      const events = await service.read((db) => (db.prepare("SELECT type FROM journal WHERE stream LIKE 'Watcher/%' ORDER BY position").all() as Array<{ type: string }>).map((r) => r.type));
      expect(events.filter((t) => t === "SourceSuspended" || t === "SourceResumed")).toEqual(["SourceSuspended", "SourceResumed"]);
    } finally {
      await service.stop();
    }
  });

  test("Later until a time is woken by the service's alarm; Later until something changes comes back on a deploy; Never and its undo record who did them", { timeout: 60_000 }, async () => {
    const { testService } = await import("./fixtures/service.ts");
    const { service, cluster, client } = await testService();
    const inbox = async () => ((await client((api) => api.Inbox.get("inbox"))) as any).items as any[];
    const until = async (what: string, ok: () => Promise<boolean>, ms = 15_000) => {
      const deadline = Date.now() + ms;
      while (!(await ok())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    try {
      cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      cluster.log(Date.now() - 50_000, "ERROR cache miss storm on key prices");
      await service.collect("shop-api/production");
      await until("two incidents", async () => (await inbox()).length === 2);
      const [a, b] = (await inbox()).map((i) => IncidentId.make(i.incidentId));
      // Later until a time: the alarm wakes it, and it says why.
      await client((api) => api.Defer(a!, { until: Date.now() + 1_500, label: "2s", actor: "owner (page)" }));
      await until("the deferral", async () => (await inbox()).find((i) => i.incidentId === a)?.disposition === "later");
      await until("the wake", async () => (await inbox()).find((i) => i.incidentId === a)?.back === "Back: you said later (2s).");
      // Later until something changes: a deploy in its environment brings it back, saying which.
      await client((api) => api.Defer(b!, { actor: "owner (page)" }));
      await until("the second deferral", async () => (await inbox()).find((i) => i.incidentId === b)?.disposition === "later");
      cluster.state.image = "registry.example/shop-api:0a1b2c3d4e5f";
      await service.collect("shop-api/production");
      await until("the deploy to bring it back", async () => ((await inbox()).find((i) => i.incidentId === b)?.back ?? "").startsWith("Back: a deploy in production"));
      // Never, then undo: each is an event naming who issued it.
      await client((api) => api.Mute(a!, { reason: "noise", actor: "owner (page)" }));
      await until("muted", async () => (await inbox()).find((i) => i.incidentId === a)?.disposition === "never");
      await client((api) => api.Restore(a!, { actor: "owner (page)" }));
      await until("restored", async () => (await inbox()).find((i) => i.incidentId === a)?.disposition === "inbox");
      const actors = await service.read(
        (db) => db.prepare("SELECT type, json_extract(data, '$.actor') AS actor FROM journal WHERE type IN ('IncidentDeferred', 'IncidentMuted', 'IncidentRestored') ORDER BY position").all() as Array<{ type: string; actor: string }>,
      );
      expect(actors.map((r) => `${r.type}:${r.actor}`)).toEqual(["IncidentDeferred:owner (page)", "IncidentDeferred:owner (page)", "IncidentMuted:owner (page)", "IncidentRestored:owner (page)"]);
      void threadIdOf;
    } finally {
      await service.stop();
    }
  });
});
