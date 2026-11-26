import { fork } from "node:child_process";
import { once } from "node:events";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { test, expect } from "./harness.ts";
import { tempDir } from "./fixtures/support.ts";
import { acquireWriterLock } from "../src/host/lock.ts";

// Each client holds its handle until the parent either releases it or kills its process.
if (process.argv[2] === "--lock-client") {
  let lock: ReturnType<typeof acquireWriterLock> | undefined;
  process.on("message", (command: string) => {
    if (command === "release") {
      lock?.release();
      lock = undefined;
      process.send?.("released");
      return;
    }
    try {
      lock = acquireWriterLock(command);
      process.send?.("held");
    } catch (error) {
      process.send?.(/Another Overwatch/.test(String(error)) ? "busy" : String(error));
    }
  });
  process.send?.("ready");
} else
  for (const legacy of [false, true]) {
    test(
      "generated competing starts, stale holder notes, releases and process deaths leave exactly one writer" +
        (legacy ? " after a legacy crash" : " on a new database"),
      { timeout: 90_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 5 }), async (kills) => {
            const dir = tempDir("pending-lock");
            const path = join(dir, "store.sqlite");
            // A crashed installation of the previous version left JSON in .lock itself.
            if (legacy)
              writeFileSync(
                path + ".lock",
                JSON.stringify({ pid: 2147483000, purpose: "previous version", since: "2020-01-01T00:00:00Z" }),
              );
            const spawnClient = async () => {
              const child = fork(fileURLToPath(import.meta.url), ["--lock-client"], {
                execArgv: ["--experimental-strip-types", "--no-warnings"],
                stdio: ["ignore", "ignore", "inherit", "ipc"],
              });
              await once(child, "message");
              return child;
            };
            const children = await Promise.all([spawnClient(), spawnClient()]);
            const ask = async (index: number, command: string) => {
              const c = children[index]!;
              const reply = once(c, "message");
              c.send(command);
              return (await reply)[0];
            };
            try {
              for (const kill of kills) {
                writeFileSync(path + ".lock.holder", JSON.stringify({ pid: 2147483000, purpose: "old writer" }));
                const results = await Promise.all([ask(0, path), ask(1, path)]);
                expect([...results].sort()).toEqual(["busy", "held"]);
                const owner = results.indexOf("held");
                if (kill) {
                  const old = children[owner]!;
                  const exited = once(old, "exit");
                  old.kill("SIGKILL");
                  await exited;
                  children[owner] = await spawnClient();
                } else expect(await ask(owner, "release")).toBe("released");
              }
            } finally {
              await Promise.all(
                children.map(async (c) => {
                  const exited = once(c, "exit");
                  c.kill();
                  await exited;
                }),
              );
              rmSync(dir, { recursive: true, force: true });
            }
          }),
          { numRuns: 4, seed: 62188 },
        );
      },
    );
  }
