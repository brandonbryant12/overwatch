/**
 * Builds the page into web/dist: one ES module bundle for the browser (web/src/entry.ts), the HTML shell, the
 * stylesheets and the logo. Bundled with rolldown under the `production` condition, so Effect UI's development-only
 * code (`#dev`, `#hot`) is left out.
 *
 * With `--optional` (how `pnpm install` runs it), a bundler that cannot load, such as a native binding a registry
 * proxy blocked, is reported and the install carries on; the service then answers 404 for the page until it is built.
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const optional = process.argv.includes("--optional");
let build: typeof import("rolldown").build;
try {
  ({ build } = await import("rolldown"));
} catch (error) {
  const message = `The page was not built: the bundler could not load (${String((error as Error).message).split("\n")[0]}). Run "pnpm run build:web" where rolldown loads, and copy web/dist here.`;
  if (optional) {
    console.warn(message);
    process.exit(0);
  }
  throw new Error(message);
}

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
const out = join(web, "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  input: join(web, "src", "entry.ts"),
  platform: "browser",
  resolve: { conditionNames: ["production", "import", "browser", "default"] },
  transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") } },
  output: { file: join(out, "app.js"), format: "esm", sourcemap: true, minify: true },
  logLevel: "warn",
});
for (const file of ["index.html", "tokens.css", "page.css", "logo.svg"]) copyFileSync(join(web, file), join(out, file));
console.log(`built ${out}`);
