import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Account, Bank, BankApi, BigDepositsLive, FlagAccount } from "./model.mjs";
import { layerSqlite } from "./sqlite-host.mjs";
const [file, mode] = process.argv.slice(2);
const Live = Bank.layer(BigDepositsLive).pipe(Layer.provide(layerSqlite(file)));
const program = Effect.gen(function* () {
  const accounts = yield* Account;
  if (mode === "arm") {
    const receipt = yield* accounts.schedule("s-1", new FlagAccount({ amount: 1 }), { after: "2 seconds" });
    console.log("armed:", JSON.stringify(receipt), "state:", JSON.stringify(yield* accounts.get("s-1")));
    return; // exit before it is due
  }
  console.log("after restart, before due:", JSON.stringify(yield* accounts.get("s-1")));
  yield* Effect.sleep("3 seconds");
  console.log("after due:", JSON.stringify(yield* accounts.get("s-1")));
}).pipe(Effect.scoped, Effect.provide(Live));
await Effect.runPromise(program).catch((e) => { console.error("ERR", e); process.exitCode = 1; });
process.exit();
