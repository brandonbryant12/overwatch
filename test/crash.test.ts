/**
 * Crash tests for the SQLite host: kill the process at a commit, between two writes, after an alarm is claimed and
 * after it fired; restart; the client retries with the same command ids. Nothing may be lost or done twice.
 *
 * By default a representative set of kill points runs. `OVERWATCH_CRASH_SWEEP=full` kills at every commit and
 * every write of the scenario (several hundred runs; `pnpm run test:crash`).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const CHILD = fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url));

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output?: { result: Outcome; counts: Record<string, number> };
  readonly stderr: string;
}
interface Outcome {
  readonly summary1: unknown;
  readonly summary2: unknown;
  readonly audit1: unknown;
  readonly audit2: unknown;
  readonly journal: ReadonlyArray<string>;
}

function child(file: string, crash?: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, OVERWATCH_CRASH: crash ?? "" };
    const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, file], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("close", (code, signal) => {
      const line = stdout.split("\n").find((l) => l.startsWith("{"));
      resolve({ code, signal, stderr, ...(line ? { output: JSON.parse(line) } : {}) });
    });
  });
}

/** What a run must end with, however often it was killed on the way. */
function check(outcome: Outcome) {
  expect(outcome.summary1).toEqual({ deposits: 2, total: 710, reminders: 1 });
  expect(outcome.summary2).toEqual({ deposits: 1, total: 600, reminders: 1 });
  expect(outcome.audit1).toEqual({ flags: 1, amounts: [700] });
  expect(outcome.audit2).toEqual({ flags: 1, amounts: [600] });
  const byStream: Record<string, string[]> = {};
  for (const entry of outcome.journal) {
    const [stream, rest] = entry.split("#") as [string, string];
    (byStream[stream] ??= []).push(rest);
  }
  const types = (stream: string) => (byStream[stream] ?? []).map((r) => r.split(":")[1]).sort();
  const versions = (stream: string) => (byStream[stream] ?? []).map((r) => Number(r.split(":")[0]));
  expect(types("Account/a-1")).toEqual(["Deposited", "Deposited", "Reminded"]);
  expect(versions("Account/a-1")).toEqual([1, 2, 3]);
  expect(types("Account/a-2")).toEqual(["Deposited", "Reminded"]);
  expect(types("Audit/a-1")).toEqual(["Flagged"]);
  expect(types("Audit/a-2")).toEqual(["Flagged"]);
  expect(outcome.journal).toHaveLength(7);
}

async function pool<T>(items: ReadonlyArray<T>, size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

describe("crash recovery on the SQLite host", () => {
  test("killed at each point, restarted, retried: nothing lost or duplicated", { timeout: 30 * 60_000 }, async () => {
    const clean = await child(join(tempDir("crash-clean"), "db.sqlite"));
    expect(clean.output).toBeDefined();
    check(clean.output!.result);
    const counts = clean.output!.counts;
    const full = process.env.OVERWATCH_CRASH_SWEEP === "full";
    const range = (point: string, every: number) =>
      Array.from({ length: counts[point] ?? 0 }, (_, i) => i + 1)
        .filter((n) => full || n <= 12 || n % every === 0)
        .map((n) => `${point}@${n}`);
    const points = [
      ...range("commit", full ? 1 : 25),
      ...range("write", full ? 1 : 60),
      ...range("alarm:claimed", 1),
      ...range("alarm:fired", 1),
    ];
    const failures: string[] = [];
    let killed = 0;
    await pool(points, 8, async (point) => {
      const file = join(tempDir("crash"), "db.sqlite");
      const first = await child(file, point);
      if (first.signal === "SIGKILL") killed += 1;
      const second = await child(file);
      if (!second.output) {
        const reason = second.stderr.split("\n").find((line) => line.startsWith("Error")) ?? second.stderr.slice(-300);
        failures.push(`${point}: restart did not finish (${second.code ?? second.signal}): ${reason}`);
        return;
      }
      try {
        check(second.output.result);
      } catch (error) {
        failures.push(`${point}: ${(error as Error).message.slice(0, 400)}`);
      }
    });
    expect(failures).toEqual([]);
    // Each point was really a kill, not a run that finished before reaching it.
    expect(killed).toBe(points.length);
  });
});
