/**
 * Screenshots of `overwatch demo` in a headless system Chrome (not part of `pnpm run check`):
 *
 *   node --experimental-strip-types --no-warnings test/real/screenshots.ts [outDir]
 *
 * Starts the demo on a free loopback port in a temporary home, drives the page with the keyboard over the DevTools
 * protocol, and writes PNGs (default docs/design/screenshots/v2/). Nothing outside temporary folders is touched.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const out = process.argv[2] ?? fileURLToPath(new URL("../../docs/design/screenshots/v2/", import.meta.url));
mkdirSync(out, { recursive: true });
const chrome = [process.env.CHROME_BIN, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
if (!chrome) throw new Error("no Chrome found; set CHROME_BIN");
const root = mkdtempSync(join(tmpdir(), "ow-shots-"));
const config = join(root, "config.json");
writeFileSync(config, JSON.stringify({ version: 2, dataDir: join(root, "data"), port: 0, apps: { shop: { checkout: root, environments: { prod: { sources: { pods: { type: "kubernetes", context: "lab", namespace: "shop", selector: "app=shop" } } } } } }, watchers: [{ app: "shop", environment: "prod" }] }));
const bin = fileURLToPath(new URL("../../bin/overwatch", import.meta.url));
const demo = spawn(bin, ["demo", "--config", config, "--json"], { env: { ...process.env, HOME: root, TMPDIR: root }, stdio: ["ignore", "pipe", "inherit"] });
const url = (JSON.parse(String((await once(demo.stdout!, "data"))[0]).split("\n")[0]!) as { url: string }).url;

const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--no-proxy-server", "--disable-features=HttpsUpgrades", "--host-resolver-rules=EXCLUDE 127.0.0.1, EXCLUDE localhost, MAP * ~NOTFOUND", "--remote-debugging-pipe", `--user-data-dir=${join(root, "profile")}`, "about:blank"], {
  env: { HOME: root, TMPDIR: root, PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
});
let id = 0, incoming = "", session: string | undefined;
const pending = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
(browser.stdio[4] as NodeJS.ReadableStream).setEncoding("utf8");
(browser.stdio[4] as NodeJS.ReadableStream).on("data", (d: string) => {
  incoming += d;
  let nul;
  while ((nul = incoming.indexOf("\0")) >= 0) {
    const msg = JSON.parse(incoming.slice(0, nul));
    incoming = incoming.slice(nul + 1);
    if (msg.id) pending.get(msg.id)?.(msg);
  }
});
const cmd = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
    pending.set(key, (m) => (clearTimeout(timer), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    (browser.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ id: key, method, params, sessionId: session }) + "\0");
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression: string) => (await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
const key = async (k: string, shift = false) => {
  const named: Record<string, [number, string]> = { Enter: [13, "Enter"], Escape: [27, "Escape"], "/": [191, "Slash"] };
  const [code, name] = named[k] ?? [k.toUpperCase().charCodeAt(0), "Key" + k.toUpperCase()];
  const text = k === "Enter" ? "\r" : k.length === 1 ? k : "";
  await cmd("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code: name, windowsVirtualKeyCode: code, text, modifiers: shift ? 8 : 0 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: name, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
};
const shot = async (name: string) => {
  if (process.env.OW_SHOTS_TRACE) console.log("shot", name);
  await sleep(450);
  const { data } = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  console.log(join(out, `${name}.png`));
};

try {
  const { targetId } = await cmd("Target.createTarget", { url: "about:blank" });
  session = (await cmd("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await cmd("Page.enable");
  const view = async (width: number, height: number, theme: "dark" | "light") => {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 600 });
    await cmd("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await cmd("Page.navigate", { url: url + "/" });
    await sleep(300);
    await evaluate(`localStorage.setItem("ow-theme", ${JSON.stringify(theme)}); document.documentElement.dataset.theme = ${JSON.stringify(theme)}; true`);
    for (let i = 0; i < 50 && (await evaluate("document.querySelector('[data-connection]')?.dataset.connection")) !== "live"; i++) await sleep(100);
  };
  for (const theme of ["dark", "light"] as const) {
    await view(1440, 900, theme);
    await shot(`desktop-${theme}-overview`);
    await key("j");
    await shot(`desktop-${theme}-focused`);
    if (theme === "dark") {
      await key("y");
      await shot("desktop-dark-was-this-right");
      await key("Escape");
      await key("b");
      await sleep(400);
      await shot("desktop-dark-brief");
      await key("Escape");
      await key("j");
      await shot("desktop-dark-returned");
      await evaluate("document.querySelector('[data-toggle=working]').click(); document.querySelector('[data-toggle=quiet]').click(); true");
      await shot("desktop-dark-all-groups");
      await evaluate("document.querySelector('[data-env=qa]').click(); true");
      await shot("desktop-dark-signed-out");
      await key("p");
      await cmd("Input.insertText", { text: "Why did QA sign out and is anything else affected?" });
      await shot("desktop-dark-prompt");
      await key("Escape");
      await key("/");
      await cmd("Input.insertText", { text: "search index" });
      await sleep(400);
      await shot("desktop-dark-search");
      await key("Escape");
      await evaluate("document.querySelector('[data-item-id]').click(); true");
      await key("l");
      await shot("desktop-dark-later");
      await key("Escape");
      await key("?", true);
      await shot("desktop-dark-keys");
      await key("Escape");
    }
  }
  await view(390, 844, "dark");
  await shot("mobile-dark-overview");
  // Stale and down: the page's own clock, with the service silent.
  await view(1440, 900, "dark");
  await key("j");
  demo.kill("SIGSTOP");
  await cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 16000 });
  await sleep(1500);
  await shot("desktop-dark-stale");
  await cmd("Emulation.setVirtualTimePolicy", { policy: "advance", budget: 15000 });
  await sleep(1500);
  await shot("desktop-dark-down");
  demo.kill("SIGCONT");
} finally {
  browser.kill("SIGKILL");
  demo.kill("SIGKILL");
  await sleep(200);
  rmSync(root, { recursive: true, force: true });
}
