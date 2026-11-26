import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { tempDir } from "./support.ts";
import { until } from "./scenario.ts";

// Use the same browser protocol as browser.test.ts, keeping one tab alive across the decision.
type Evaluate = (js: string) => Promise<string>;
export async function withPage(url: string, inspect: (evaluate: Evaluate, openSibling: () => Promise<Evaluate>) => Promise<void>) {
  const chrome = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].find((p) => p && existsSync(p));
  if (!chrome) throw Error("Set CHROME_BIN to run the rendered page contract");
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--use-mock-keychain",
      "--no-proxy-server",
      "--no-first-run",
      "--remote-debugging-port=0",
      "--user-data-dir=" + tempDir("pending-chrome"),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let socket: WebSocket | undefined;
  try {
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    const ws = await until(async () => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], Boolean, 10_000);
    socket = new WebSocket(ws!);
    await new Promise<void>((ok, fail) => {
      socket!.onopen = () => ok();
      socket!.onerror = fail;
    });
    let seq = 0;
    const call = (method: string, params: object = {}, sessionId?: string) =>
      new Promise<Record<string, any>>((ok, fail) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          socket!.removeEventListener("message", listener);
          fail(Error("CDP timeout: " + method));
        }, 12_000);
        const listener = (event: MessageEvent) => {
          const m = JSON.parse(String(event.data));
          if (m.id !== id) return;
          clearTimeout(timer);
          socket!.removeEventListener("message", listener);
          if (m.error) fail(Error(m.error.message));
          else ok(m.result);
        };
        socket!.addEventListener("message", listener);
        socket!.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const openPage = async (): Promise<Evaluate> => {
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      await call("Page.navigate", { url }, sessionId);
      return async (js) => {
        const r = await call("Runtime.evaluate", { expression: js, returnByValue: true, userGesture: true }, sessionId);
        if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
        return String(r.result.value ?? "");
      };
    };
    await inspect(await openPage(), openPage);
  } finally {
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
  }
}
