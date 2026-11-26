/** One keypress in its own process, for the crash probes in publish.test.ts: the fake host may kill it mid-step. */
import { Effect } from "effect";
import { loadConfig } from "../src/config.ts";
import { Fixes } from "../src/fixes.ts";
import { keyed } from "../src/inbox.ts";
import { run, withConfig, withStore } from "./effect.ts";

const [file, id] = process.argv.slice(2) as [string, string];
process.env.OW_PUBLISHER_PID = String(process.pid);
const config = await run(loadConfig(file));
const result = await run(
  withStore(config.dataDir, (store) =>
    Effect.gen(function* () {
      const fixes = yield* Fixes;
      const basis = (yield* store.get<{ decided_seq: number }>("SELECT decided_seq FROM incidents WHERE id = 'inc_p'"))!.decided_seq;
      return yield* keyed("rk_c41d00000000000000000001", yield* fixes.publication(id, basis));
    }).pipe(Effect.provide(Fixes.layer), withConfig(config)),
  ),
);
console.log(JSON.stringify(result));
