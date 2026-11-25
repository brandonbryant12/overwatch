/**
 * The real page in a headless browser: it shows a new incident without a reload, takes focus, keeps a prompt when
 * the send fails, sends it on retry, and archives.
 *
 * Uses an installed Chrome or Chromium through the DevTools protocol over Node's built-in WebSocket, with a
 * throwaway profile; no browser package is added. Set CHROME_BIN to choose the binary. Where none is found the test
 * is skipped and says so.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testService } from "./fixtures/service.ts";
import { tempDir } from "./fixtures/support.ts";
import { describe, expect, test } from "./harness.ts";

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));
const chrome = CANDIDATES.find((p) => existsSync(p));
const WEB = fileURLToPath(new URL("../web/dist", import.meta.url));

/** A minimal DevTools protocol client: one page, commands by session, events by name. */
async function launch(url: string) {
  const proc: ChildProcess = spawn(
    chrome!,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${tempDir("chrome")}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise<string>((resolve, reject) => {
    let err = "";
    proc.stderr!.on("data", (chunk) => {
      err += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (match) resolve(match[1]!);
    });
    proc.on("exit", () => reject(new Error(`chrome exited: ${err.slice(-500)}`)));
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 1;
  const waiting = new Map<number, (result: any) => void>();
  const listeners = new Map<string, (params: any) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)!(message.error ? Promise.reject(new Error(message.error.message)) : message.result);
      waiting.delete(message.id);
    } else if (message.method) listeners.get(message.method)?.(message.params);
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method: string, params: object = {}) => send(method, params, sessionId);
  const evaluate = async (expression: string) => (await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
  const until = async (what: string, expression: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await evaluate(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${expression}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  return {
    page,
    evaluate,
    until,
    on: (method: string, listener: (params: any) => void) => listeners.set(method, listener),
    close: () => {
      socket.close();
      proc.kill();
    },
  };
}

describe("the page in a headless browser", () => {
  if (!chrome) {
    test("skipped: no Chrome or Chromium found (set CHROME_BIN to run it)", () => undefined);
    return;
  }
  test("focus, a failed send keeps the prompt, a retry sends it, archive removes the incident", { timeout: 120_000 }, async () => {
    if (!existsSync(join(WEB, "app.js"))) spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(new URL("../scripts/build-web.ts", import.meta.url))]);
    const { service, cluster } = await testService({ deps: { webDir: WEB } });
    const browser = await launch(service.url);
    try {
      await browser.until("the page to load", "document.querySelector('.inbox-item, .empty-focus-title') !== null");
      cluster.log(Date.now() - 60_000, "ERROR payment 42 timed out after 300ms");
      await service.collect("shop-api/production");
      await browser.until("the new incident to appear without a reload", "document.querySelectorAll('.inbox-item').length === 1");
      await browser.until(
        "the fleet strip to show the environment checked, with its open incident",
        "(document.querySelector('.fleet-strip .env-chip')?.textContent ?? '').includes('1 open') && document.querySelector('.env-chip.state-attention') !== null",
        20_000,
      );

      await browser.evaluate("document.querySelector('.inbox-item').click()");
      await browser.until("focus", "document.querySelector('.inbox-item.focused') !== null && document.querySelector('#prompt-input') !== null");

      const type = (text: string) =>
        browser.evaluate(`(() => {
          const input = document.querySelector('#prompt-input');
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
          setter.call(input, ${JSON.stringify(text)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return input.value;
        })()`);
      await type("why are payments timing out?");
      await browser.until("the send button to enable", "!document.querySelector('.send-btn').disabled");

      // The network refuses the prompt's request once.
      let failed = 0;
      browser.on("Fetch.requestPaused", (event) => {
        if (String(event.request.postData ?? "").includes("AskThread") && failed === 0) {
          failed += 1;
          void browser.page("Fetch.failRequest", { requestId: event.requestId, errorReason: "ConnectionFailed" });
        } else void browser.page("Fetch.continueRequest", { requestId: event.requestId });
      });
      await browser.page("Fetch.enable", { patterns: [{ urlPattern: "*/api*", requestStage: "Request" }] });
      await browser.evaluate("document.querySelector('.send-btn').click()");
      await browser.until("a notice that the prompt was not confirmed", "(document.querySelector('.notice-text')?.textContent ?? '').includes('Prompt')");
      expect(failed).toBe(1);
      expect(await browser.evaluate("document.querySelector('#prompt-input').value")).toBe("why are payments timing out?");

      await browser.page("Fetch.disable");
      await browser.until("the send button to enable again", "!document.querySelector('.send-btn').disabled");
      await browser.evaluate("document.querySelector('.send-btn').click()");
      await browser.until("the draft to clear once acknowledged", "document.querySelector('#prompt-input').value === ''");
      await browser.until("the prompt on the thread", "document.body.textContent.includes('why are payments timing out?')");

      await browser.evaluate("document.querySelector('.archive-action').click()");
      await browser.until("the incident to leave the inbox", "document.querySelectorAll('.inbox-item').length === 0");
    } finally {
      browser.close();
      await service.stop();
    }
  });
});
