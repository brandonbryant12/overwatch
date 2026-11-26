import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Busy, Incompatible, Store, type Clean } from "../src/store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ow-store-test-"));
const rows = (store: Store) => ["events", "incidents"].map((t) => store.all(`SELECT * FROM ${t} ORDER BY 1`));

test("a second process cannot own the database while the first does", () => {
  const d = dir();
  const store = Store.own(d);
  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `import {DatabaseSync} from 'node:sqlite'; const d = new DatabaseSync(process.argv[1]); try { d.exec('pragma busy_timeout=0; begin immediate; commit'); console.log('owned') } catch (e) { console.log('busy') }`, join(d, "overwatch.db")], { encoding: "utf8" });
  assert.equal(contender.stdout.trim(), "busy");
  store.close();
  assert.doesNotThrow(() => Store.own(d).close());
});

test("events are append-only and the writer cleans every string it is given", () => {
  const store = Store.own(dir());
  store.tx((w) => w.event("slice", "shop/prod/pods" as Clean, { note: "password=hunter22secret" }));
  assert.ok(!JSON.stringify(store.all("SELECT * FROM events")).includes("hunter22secret"));
  assert.throws(() => store.tx((w) => w.run("UPDATE events SET kind = 'x'")), /append-only/);
  assert.throws(() => store.tx((w) => w.run("DELETE FROM events")), /append-only/);
  // A raw string fabricated past the type is cleaned at run time all the same.
  store.tx((w) => w.run("INSERT INTO meta (key, value) VALUES ('k', ?)", "token=abc123secretvalue" as Clean));
  assert.ok(!store.meta("k")!.includes("abc123secretvalue"));
  store.close();
});

test("a backup restores to the same rows and sequence; a rejected one leaves the rows as they were", () => {
  const d = dir();
  const store = Store.own(d);
  store.tx((w) => {
    const seq = w.event("slice", "s" as Clean, {});
    w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'a', 'e', 's', 'ERROR x', 'error', 3, 1, 0, 0, ?)", seq);
  });
  const file = join(d, "backup.sqlite");
  const { seq } = store.backup(file);
  const before = rows(store);
  store.tx((w) => w.event("slice", "s" as Clean, { later: true }));
  store.restore(file);
  assert.deepEqual(rows(store), before);
  assert.equal(store.seq(), seq);
  // Bad inputs: a text file, a foreign database, a negative count, a future version.
  const text = join(d, "text");
  writeFileSync(text, "not a database");
  const foreign = join(d, "foreign.sqlite");
  new DatabaseSync(foreign).exec("create table ordinary(x)");
  const negative = join(d, "negative.sqlite");
  store.backup(negative);
  const n = new DatabaseSync(negative);
  n.exec("pragma ignore_check_constraints = on");
  n.prepare("update incidents set count = -1").run();
  n.close();
  // Intact but impossible: an incident that names a sequence number the backup never issued.
  const impossible = join(d, "impossible.sqlite");
  store.backup(impossible);
  const i = new DatabaseSync(impossible);
  i.prepare("update incidents set seq = seq + 100").run();
  i.close();
  for (const bad of [text, foreign, negative, impossible]) {
    assert.throws(() => store.restore(bad), Incompatible);
    assert.deepEqual(rows(store), before);
  }
  store.close();
});

test("a file from an earlier build of version 1 gains the columns added since, with their defaults", () => {
  const d = dir();
  Store.own(d).close();
  const raw = new DatabaseSync(join(d, "overwatch.db"));
  raw.exec("ALTER TABLE incidents DROP COLUMN active; ALTER TABLE occurrences DROP COLUMN incident; ALTER TABLE sources DROP COLUMN delay_ms");
  raw.close();
  const store = Store.own(d);
  store.tx((w) => w.run("INSERT INTO incidents (id, app, environment, source, title, severity, count, exact, first_ms, last_ms, seq) VALUES ('inc_1', 'a', 'e', 's', 'ERROR x', 'error', 1, 1, 0, 0, 0)"));
  assert.equal(store.get<{ active: number }>("SELECT active FROM incidents")!.active, 1);
  assert.ok(store.get("SELECT incident FROM occurrences LIMIT 0") === undefined);
  store.close();
});

test("retention drops old history in its declared order but keeps counts and the next sequence", () => {
  const store = Store.own(dir());
  for (let i = 0; i < 30; i++) store.tx((w) => w.event("slice", "s" as Clean, { i }));
  const before = store.seq();
  let checks = 0;
  store.retain(Date.now(), () => ++checks <= 1, 10);
  assert.equal(store.seq(), before + 1, "it stopped as soon as the database fitted");
  assert.equal(store.get<{ n: number }>("SELECT min(seq) AS n FROM events")!.n, before - 10 + 1);
  assert.deepEqual(JSON.parse(store.get<{ data: string }>("SELECT data FROM events WHERE kind = 'compacted'")!.data), { step: "events", removed: before - 10, throughSeq: before - 10 });
  store.close();
});

test("after compaction the file shrinks, a bounded number of bytes at a time", () => {
  const d = dir();
  const store = Store.own(d);
  const size = () => ["", "-wal"].reduce((n, x) => n + (statSync(join(d, "overwatch.db") + x, { throwIfNoEntry: false })?.size ?? 0), 0);
  assert.equal(store.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")!.auto_vacuum, 2);
  const words = "lorem ipsum dolor sit amet ".repeat(300);
  for (let i = 0; i < 40; i++) store.tx((w) => { for (let j = 0; j < 50; j++) w.event("slice", "s" as Clean, { words, i, j }); });
  assert.equal(store.reclaim(), 0);
  store.retain(Date.now(), () => true, 10);
  store.checkpoint();
  const full = size();
  assert.ok(full > 10 * 1024 ** 2, `wrote ${full} bytes`);
  const sizes = [full];
  let left = Infinity, steps = 0;
  while (left > 0 && steps++ < 1000) {
    left = store.reclaim(1024 ** 2);
    sizes.push(size());
  }
  assert.equal(left, 0);
  assert.ok(steps > 3, "the work was split into bounded steps");
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i - 1]! - sizes[i]! <= 1024 ** 2 && sizes[i]! <= sizes[i - 1]!, `step ${i} freed ${sizes[i - 1]! - sizes[i]!} bytes`);
  assert.ok(sizes.at(-1)! < 1024 ** 2, `shrank to ${sizes.at(-1)} bytes`);
  store.close();
});

test("a busy owner is reported as Busy, not as damage", () => {
  const d = dir();
  const store = Store.own(d);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", `import { Store } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)}; try { Store.own(process.argv[1]); console.log("owned") } catch (e) { console.log(e.constructor.name) }`, d], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), Busy.name);
  store.close();
});
