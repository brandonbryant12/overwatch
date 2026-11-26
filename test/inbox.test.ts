import { scratch } from "./scratch.ts";
/** The kernel's ways out: deadlines on the stored-delay shape, return decisions, prompts by request key. */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { AppConfig, parseConfig } from "../src/config.ts";
import { Store, type Clean } from "../src/store.ts";
import { clock } from "../src/clock.ts";
import { act, afterChange, ask, deadlines, detail, inbox, keyed, search } from "../src/inbox.ts";
import { run, withConfig, withStore } from "./effect.ts";

/** A database with one production error, the configuration, and a clock under the test's control. */
function inRig<A, E>(body: (r: Rig) => Effect.Effect<A, E, Store | AppConfig>) {
  const dataDir = scratch("ow-inbox-test-");
  const config = parseConfig(
    { version: 2, dataDir, apps: { shop: { checkout: "/tmp", environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod", every: "1m" }] },
    join(dataDir, "c.json"),
  );
  return run(
    withStore(dataDir, (store) =>
      Effect.gen(function* () {
        let now = Date.UTC(2026, 10, 1), mono = 1e6;
        clock.set(now, mono);
        yield* store.tx((w) =>
          Effect.gen(function* () {
            const seq = yield* w.event("slice", "shop/prod/pods" as Clean, {});
            yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq, first_seq) VALUES ('inc_1', 'shop', 'prod', 'shop/prod/pods', 'ERROR payments', 'error', 1, 1, 0, 0, ?, ?)", seq, seq);
          }),
        );
        const rig: Rig = {
          /** One more occurrence, admitted now. */
          occur: store.tx((w) =>
            Effect.gen(function* () {
              const seq = yield* w.event("slice", "shop/prod/pods" as Clean, {});
              yield* w.run("UPDATE incidents SET count = count + 1 WHERE id = 'inc_1'");
              yield* afterChange(w, "inc_1", { severity: "error", active: 1 }, 1, seq);
            }),
          ).pipe(Effect.orDie),
          move(wall: number, mon: number) {
            now += wall;
            mono += mon;
            clock.set(now, mono);
          },
          way: Effect.map(detail("inc_1"), (d) => d.incident.way?.kind ?? null).pipe(Effect.orDie),
          back: Effect.map(detail("inc_1"), (d) => d.incident.returned?.code ?? null).pipe(Effect.orDie),
        };
        return yield* body(rig);
      }).pipe(withConfig(config)),
    ),
  );
}
interface Rig {
  readonly occur: Effect.Effect<void, never, Store | AppConfig>;
  readonly move: (wall: number, mono: number) => void;
  readonly way: Effect.Effect<string | null, never, Store | AppConfig>;
  readonly back: Effect.Effect<string | null, never, Store | AppConfig>;
}
/** A failure's message, for matching. */
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? String((exit.cause.reasons[0] as { error?: { message?: string } }).error?.message) : "succeeded"));

test("Done's grace is one interval on the service's own admission; a wall clock set back cannot extend it", () =>
  inRig((r) =>
    Effect.gen(function* () {
      yield* act("inc_1", { action: "done" }, null);
      r.move(-3_600_000, 30_000);
      yield* r.occur;
      assert.equal(yield* r.way, "done", "admitted inside the grace: counted, still put away");
      r.move(0, 30_001);
      yield* r.occur;
      assert.equal(yield* r.back, "again");
      assert.deepEqual((yield* inbox).groups.needsYou, ["inc_1"]);
    }),
  ));

test("Later with a time comes back at the delay the owner chose, even with the wall clock set back", () =>
  inRig((r) =>
    Effect.gen(function* () {
      yield* act("inc_1", { action: "later", untilMs: clock.now() + 120_000 }, null);
      r.move(-86_400_000, 119_999);
      yield* deadlines;
      assert.equal(yield* r.way, "later");
      r.move(0, 1);
      yield* deadlines;
      assert.equal(yield* r.back, "deadline");
      const kinds = (yield* detail("inc_1")).history.map((e) => e.kind);
      assert.deepEqual(kinds.slice(-2), ["deadline", "returned"], "a durable deadline event, then the return");
    }),
  ));

test("a request key answers the same way forever and refuses a different prompt; continue needs an open job", () =>
  inRig(() =>
    Effect.gen(function* () {
      const key = "rk_" + "a".repeat(24);
      assert.match(yield* refused(Effect.flatMap(ask({ subject: "inc_1", text: "why?", mode: "continue" }), (plan) => keyed("rk_" + "b".repeat(24), plan))), /no conversation/);
      const first = yield* keyed(key, yield* ask({ subject: "inc_1", text: "why?", mode: "auto" }));
      assert.deepEqual(yield* keyed(key, yield* ask({ subject: "inc_1", text: "why?", mode: "auto" })), first);
      assert.match(yield* refused(keyed(key, yield* ask({ subject: "inc_1", text: "other", mode: "auto" }))), /different request/);
      assert.deepEqual((yield* inbox).groups.working, ["inc_1"]);
      assert.deepEqual((yield* search("WHY?")).items.map((i) => i.id), ["inc_1"]);
      assert.match(yield* refused(ask({ subject: "env:shop/nowhere", text: "x", mode: "auto" })), /unknown subject/);
    }),
  ));

test("undo is fenced: only the current action can be undone, once", () =>
  inRig((r) =>
    Effect.gen(function* () {
      const { seq } = yield* act("inc_1", { action: "never", reason: "noise" }, null);
      yield* act("inc_1", { action: "undo", actionSeq: seq }, null);
      assert.equal(yield* r.way, null);
      assert.match(yield* refused(act("inc_1", { action: "undo", actionSeq: seq }, null)), /no longer/);
      assert.match(yield* refused(act("inc_1", { action: "later", untilMs: clock.now() + 1, when: "worse" }, null)), /not both/);
    }),
  ));

test("search folds Unicode case: ß matches SS, and an accented capital matches its small letter", () =>
  inRig(() =>
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.tx((w) => w.run("UPDATE incidents SET title = 'ERROR Straße ÉCHEC' WHERE id = 'inc_1'"));
      assert.deepEqual((yield* search("STRASSE")).items.map((i) => i.id), ["inc_1"]);
      assert.deepEqual((yield* search("échec")).items.map((i) => i.id), ["inc_1"]);
    }),
  ));
