import type { Exec } from "./exec.ts";

const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** macOS notification. Does nothing on other platforms or when disabled. */
export async function notify(exec: Exec, enabled: boolean, title: string, body: string): Promise<void> {
  if (!enabled || process.platform !== "darwin") return;
  const script = `display notification "${escape(body.slice(0, 240))}" with title "${escape(title.slice(0, 80))}"`;
  await exec("osascript", ["-e", script], { timeoutMs: 10_000 }).catch(() => undefined);
}
