/**
 * Builds the page into web/dist: one ES module bundle for the browser, the HTML shell and the stylesheet.
 * Uses rolldown, which the `alchemy` package already brings, so no other bundler is installed.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * With `--optional` (how `pnpm install` runs it), a missing bundler, such as the native rolldown binding blocked by a
 * registry proxy, is reported and the install carries on. The service then serves a page saying how to build it.
 */
const optional = process.argv.includes("--optional");
let build: typeof import("rolldown").build;
try {
  ({ build } = await import("rolldown"));
} catch (error) {
  const message = `The page was not built: the bundler could not load (${(error as Error).message.split("\n")[0]}). Build web/dist on another machine with "pnpm run build:web" and copy it here; see docs/setup.md.`;
  if (optional) {
    console.warn(message);
    process.exit(0);
  }
  throw new Error(message);
}

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const out = join(web, "dist");
mkdirSync(out, { recursive: true });
await build({
  input: join(web, "src", "entry.ts"),
  platform: "browser",
  output: { file: join(out, "app.js"), format: "esm", sourcemap: true, minify: true },
  logLevel: "warn",
});
copyFileSync(join(web, "index.html"), join(out, "index.html"));
copyFileSync(join(web, "src", "style.css"), join(out, "style.css"));
copyFileSync(join(web, "src", "favicon.svg"), join(out, "favicon.svg"));
console.log(`built ${out}`);
