/**
 * Defects reproduced by the third grading. Each test fails on the code before its fix, including by the routes the
 * reviewer used to get around the previous fixes.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const CONTENDER = fileURLToPath(new URL("./fixtures/lock-contender.ts", import.meta.url));

describe("1. the writer lock is atomic", () => {
  test("separate processes started at the same instant: exactly one takes the lock, every round", { timeout: 180_000 }, async () => {
    const rounds = 25;
    const contenders = 8;
    const doubles: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const file = join(tempDir("lockrace"), "overwatch.sqlite");
      const startAt = Date.now() + 600;
      const results = await Promise.all(
        Array.from(
          { length: contenders },
          () =>
            new Promise<string>((resolve) => {
              const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CONTENDER, file, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
              let out = "";
              proc.stdout.on("data", (c) => (out += c));
              proc.on("close", () => resolve(out));
            }),
        ),
      );
      const winners = results.filter((r) => r.includes("won")).length;
      if (winners !== 1) doubles.push(winners);
    }
    expect(doubles).toEqual([]);
  });
});
