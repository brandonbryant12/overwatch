/** One keypress in its own process, for the crash probes in publish.test.ts: the fake host may kill it mid-step. */
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { Tools } from "../src/tools.ts";
import { Fixes } from "../src/fixes.ts";
import { keyed } from "../src/inbox.ts";

const [file, id] = process.argv.slice(2) as [string, string];
const config = loadConfig(file), store = Store.own(config.dataDir);
process.env.OW_PUBLISHER_PID = String(process.pid);
const fixes = new Fixes(store, new Tools(store), config, config.dataDir, () => undefined);
const basis = store.get<{ decided_seq: number }>("SELECT decided_seq FROM incidents WHERE id = 'inc_p'")!.decided_seq;
console.log(JSON.stringify(await keyed(store, "rk_c41d00000000000000000001", fixes.publication(id, basis))));
store.close();
