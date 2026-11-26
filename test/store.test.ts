import { scratch } from "./scratch.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit } from "effect";
import { Store, type Clean, type StoreShape } from "../src/store.ts";
import { run, withStore } from "./effect.ts";

const dir = () => scratch("ow-store-test-");
const rows = (store: StoreShape) => Effect.forEach(["events", "incidents"], (t) => store.all(`SELECT * FROM ${t} ORDER BY 1`));
/** The tag of the failure, or "Success". */
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.exit(effect), (exit) => (Exit.isSuccess(exit) ? "Success" : String((exit.cause.reasons[0] as { error?: { _tag?: string }; defect?: unknown }).error?._tag ?? (exit.cause.reasons[0] as { defect?: unknown }).defect)));

test("a second process cannot own the database while the first does", async () => {
  const d = dir();
  await run(
    withStore(d, () =>
      Effect.sync(() => {
        const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const d = new DatabaseSync(process.argv[1]); try { d.exec('pragma busy_timeout=0; begin immediate; commit'); console.log('owned') } catch (e) { console.log('busy') }`, join(d, "overwatch.db")], { encoding: "utf8" });
        assert.equal(contender.stdout.trim(), "busy");
      }),
    ),
  );
  await run(withStore(d, () => Effect.void));
});

test("events are append-only and the writer cleans every string it is given", async () => {
  await run(
    withStore(dir(), (store) =>
      Effect.gen(function* () {
        yield* store.tx((w) => w.event("slice", "shop/prod/pods" as Clean, { note: "password=hunter22secret" }));
        assert.ok(!JSON.stringify(yield* store.all("SELECT * FROM events")).includes("hunter22secret"));
        assert.match(yield* outcome(store.tx((w) => w.run("UPDATE events SET kind = 'x'"))), /append-only/);
        assert.match(yield* outcome(store.tx((w) => w.run("DELETE FROM events"))), /append-only/);
        // A raw string fabricated past the type is cleaned at run time all the same.
        yield* store.tx((w) => w.run("INSERT INTO meta (key, value) VALUES ('k', ?)", "token=abc123secretvalue" as Clean));
        assert.ok(!(yield* store.meta("k"))!.includes("abc123secretvalue"));
      }),
    ),
  );
});

test("a failed change is undone whole, and a writer kept past its transaction cannot write", async () => {
  await run(
    withStore(dir(), (store) =>
      Effect.gen(function* () {
        let kept: Parameters<Parameters<StoreShape["tx"]>[0]>[0] | undefined;
        const failed = yield* outcome(
          store.tx((w) =>
            Effect.gen(function* () {
              kept = w;
              yield* w.event("slice", null, {});
              return yield* Effect.fail({ _tag: "Stop" });
            }),
          ),
        );
        assert.equal(failed, "Stop");
        assert.equal(yield* store.seq, 0, "the event was rolled back with the change");
        assert.match(yield* outcome(kept!.event("late", null, {})), /transaction has ended/);
      }),
    ),
  );
});

test("a backup restores to the same rows and sequence; a rejected one leaves the rows as they were", async () => {
  const d = dir();
  await run(
    withStore(d, (store) =>
      Effect.gen(function* () {
        yield* store.tx((w) =>
          Effect.gen(function* () {
            const seq = yield* w.event("slice", "s" as Clean, {});
            yield* w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'a', 'e', 's', 'ERROR x', 'error', 3, 1, 0, 0, ?)", seq);
          }),
        );
        const file = join(d, "backup.sqlite");
        const { seq } = yield* store.backup(file);
        const before = yield* rows(store);
        yield* store.tx((w) => w.event("slice", "s" as Clean, { later: true }));
        yield* store.restore(file);
        assert.deepEqual(yield* rows(store), before);
        assert.equal(yield* store.seq, seq);
        // Bad inputs: a text file, a foreign database, a negative count, a future version.
        const text = join(d, "text");
        writeFileSync(text, "not a database");
        const foreign = join(d, "foreign.sqlite");
        new DatabaseSync(foreign).exec("create table ordinary(x)");
        const negative = join(d, "negative.sqlite");
        yield* store.backup(negative);
        const n = new DatabaseSync(negative);
        n.exec("pragma ignore_check_constraints = on");
        n.prepare("update incidents set count = -1").run();
        n.close();
        // Intact but impossible: an incident that names a sequence number the backup never issued.
        const impossible = join(d, "impossible.sqlite");
        yield* store.backup(impossible);
        const i = new DatabaseSync(impossible);
        i.prepare("update incidents set seq = seq + 100").run();
        i.close();
        for (const bad of [text, foreign, negative, impossible]) {
          assert.equal(yield* outcome(store.restore(bad)), "Incompatible", bad);
          assert.deepEqual(yield* rows(store), before);
        }
      }),
    ),
  );
});

test("a file from an earlier build of version 1 gains the columns added since, with their defaults", async () => {
  const d = dir();
  await run(withStore(d, () => Effect.void));
  const raw = new DatabaseSync(join(d, "overwatch.db"));
  raw.exec("ALTER TABLE incidents DROP COLUMN active; ALTER TABLE occurrences DROP COLUMN incident; ALTER TABLE sources DROP COLUMN delay_ms");
  raw.close();
  await run(
    withStore(d, (store) =>
      Effect.gen(function* () {
        yield* store.tx((w) => w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'a', 'e', 's', 'ERROR x', 'error', 1, 1, 0, 0, 0)"));
        assert.equal((yield* store.get<{ active: number }>("SELECT active FROM incidents"))!.active, 1);
        assert.ok((yield* store.get("SELECT incident FROM occurrences LIMIT 0")) === undefined);
      }),
    ),
  );
});

test("retention drops old history in its declared order but keeps counts and the next sequence", async () => {
  await run(
    withStore(dir(), (store) =>
      Effect.gen(function* () {
        for (let i = 0; i < 30; i++) yield* store.tx((w) => w.event("slice", "s" as Clean, { i }));
        const before = yield* store.seq;
        let checks = 0;
        yield* store.retain(Date.now(), Effect.sync(() => ++checks <= 1), 10);
        assert.equal(yield* store.seq, before + 1, "it stopped as soon as the database fitted");
        assert.equal((yield* store.get<{ n: number }>("SELECT min(seq) AS n FROM events"))!.n, before - 10 + 1);
        assert.deepEqual(JSON.parse((yield* store.get<{ data: string }>("SELECT data FROM events WHERE kind = 'compacted'"))!.data), { step: "events", removed: before - 10, throughSeq: before - 10 });
      }),
    ),
  );
});

test("after compaction the file shrinks, a bounded number of bytes at a time", async () => {
  const d = dir();
  const size = () => ["", "-wal"].reduce((n, x) => n + (statSync(join(d, "overwatch.db") + x, { throwIfNoEntry: false })?.size ?? 0), 0);
  await run(
    withStore(d, (store) =>
      Effect.gen(function* () {
        assert.equal((yield* store.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum"))!.auto_vacuum, 2);
        const words = "lorem ipsum dolor sit amet ".repeat(300);
        for (let i = 0; i < 40; i++)
          yield* store.tx((w) =>
            Effect.gen(function* () {
              for (let j = 0; j < 50; j++) yield* w.event("slice", "s" as Clean, { words, i, j });
            }),
          );
        assert.equal(yield* store.reclaim(), 0);
        yield* store.retain(Date.now(), Effect.succeed(true), 10);
        yield* store.checkpoint;
        const full = size();
        assert.ok(full > 10 * 1024 ** 2, `wrote ${full} bytes`);
        const sizes = [full];
        let left = Infinity, steps = 0;
        while (left > 0 && steps++ < 1000) {
          left = yield* store.reclaim(1024 ** 2);
          sizes.push(size());
        }
        assert.equal(left, 0);
        assert.ok(steps > 3, "the work was split into bounded steps");
        for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i - 1]! - sizes[i]! <= 1024 ** 2 && sizes[i]! <= sizes[i - 1]!, `step ${i} freed ${sizes[i - 1]! - sizes[i]!} bytes`);
        assert.ok(sizes.at(-1)! < 1024 ** 2, `shrank to ${sizes.at(-1)} bytes`);
      }),
    ),
  );
});

test("a busy owner is reported as Busy, not as damage", async () => {
  const d = dir();
  const script = `import { NodeServices } from "@effect/platform-node"; import { Effect, Exit } from "effect"; import { Store } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Store.own(process.argv[1]))).pipe(Effect.provide(NodeServices.layer)));
    console.log(Exit.isSuccess(exit) ? "owned" : exit.cause.reasons[0].error._tag)`;
  await run(
    withStore(d, () =>
      Effect.sync(() => {
        const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, d], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
        assert.equal(child.stdout.trim(), "Busy", child.stderr);
      }),
    ),
  );
  void Store;
});
