/**
 * One contender for the writer lock, for the race test: waits until a shared start instant, tries to take the lock,
 * reports whether it got it, holds it until every other contender has given up (well past their retries), then exits.
 *   node lock-contender.ts <database file> <start at, epoch ms>
 */
import { acquireWriterLock } from "../../src/host/lock.ts";

const [file, startAt] = [process.argv[2]!, Number(process.argv[3])];
while (Date.now() < startAt) {
  // Spin, so every contender starts within the same millisecond or so.
}
let won = false;
try {
  const lock = acquireWriterLock(file);
  won = true;
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, 2_500);
} catch (error) {
  process.stdout.write(`lost: ${(error as Error).message.slice(0, 120)}\n`);
}
if (won) process.stdout.write("won\n");
