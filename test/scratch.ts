/**
 * Every test's scratch lives in one private root per test process, which is also that process's TMPDIR (so the
 * product's own scratch and any subprocess land inside it), removed when the process exits, passed or failed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ow-test-"));
process.env.TMPDIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
export const scratch = (prefix: string) => mkdtempSync(join(root, prefix));
