/**
 * Builds the page into web/dist: one ES module bundle for the browser, the HTML shell and the stylesheet.
 * Uses rolldown, which the `alchemy` package already brings, so no other bundler is installed.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";

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
