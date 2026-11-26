/**
 * OpenCode 2.4.1 over its HTTP API, with `fetch`: the whole of Overwatch's dependence on OpenCode is this file.
 * Sessions and messages are created with identifiers Overwatch chose and recorded first, so repeating a request
 * repeats the same idempotent action.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { secret } from "./exec.ts";

export interface Message {
  readonly id: string;
  readonly type: string;
  readonly text: string;
  readonly outcome: string | null;
}

/** The server's address: configured, or the registration file OpenCode writes when it serves. */
export function discover(configured: string | null): string | null {
  if (configured) return configured;
  for (const dir of [process.env.XDG_STATE_HOME && join(process.env.XDG_STATE_HOME, "opencode"), join(homedir(), ".local", "state", "opencode")]) {
    if (!dir) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, "server.json"), "utf8")) as { url?: string };
      if (typeof value.url === "string") return value.url.replace(/\/+$/, "");
    } catch {
      // Not registered there.
    }
  }
  return null;
}

export class OpenCode {
  readonly url: string;
  private readonly password: string | null;
  constructor(url: string, password: string | null = null) {
    this.url = url;
    this.password = password;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.password) {
      const value = await secret(this.password);
      if (value) headers.authorization = "Basic " + Buffer.from(`opencode:${value}`).toString("base64");
    }
    const response = await fetch(this.url + path, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode answered ${response.status} for ${path.replace(/\/session\/[^/]+/, "/session/…")}`);
    }
    return response.json();
  }

  info = () => this.call("/api/info") as Promise<{ version?: string }>;
  private data = async (path: string) => {
    const v = (await this.call(path)) as { data?: unknown };
    return Array.isArray(v.data) ? (v.data as Array<Record<string, unknown>>) : [];
  };
  agents = () => this.data("/api/agent");
  mcp = () => this.data("/api/mcp");
  skills = () => this.data("/api/skill");

  createSession(input: { id: string; title: string; agent: string | null; model: string | null; directory: string }) {
    return this.call("/api/session", {
      method: "POST",
      body: { id: input.id, title: input.title, location: { directory: input.directory }, ...(input.agent ? { agent: input.agent } : {}), ...(input.model ? { model: input.model } : {}) },
    });
  }

  prompt(session: string, input: { id: string; text: string; agent: string | null; model: string | null }) {
    return this.call(`/api/session/${encodeURIComponent(session)}/prompt`, {
      method: "POST",
      body: { id: input.id, text: input.text, ...(input.agent ? { agent: input.agent } : {}), ...(input.model ? { model: input.model } : {}) },
    });
  }

  /** The session's history, oldest first. */
  async messages(session: string): Promise<Message[]> {
    const rows = await this.data(`/api/session/${encodeURIComponent(session)}/message`);
    return rows
      .map((m) => ({
        id: String(m.id ?? ""),
        type: String(m.type ?? ""),
        text: Array.isArray(m.content) ? m.content.map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "")).join("") : "",
        outcome: typeof m.outcome === "string" ? m.outcome : null,
      }))
      .reverse();
  }

  interrupt = (session: string) => this.call(`/api/session/${encodeURIComponent(session)}/interrupt`, { method: "POST", body: {} }).catch(() => undefined);

  /** After our message `id`: whether the session has gone idle, and what the model said. */
  static after(history: ReadonlyArray<Message>, id: string): { idle: boolean; outcome: string | null; said: string } {
    const i = history.findIndex((m) => m.id === id);
    const later = i < 0 ? [] : history.slice(i + 1);
    const idle = later.find((m) => m.type === "idle");
    return { idle: Boolean(idle), outcome: idle?.outcome ?? null, said: later.filter((m) => m.type === "assistant").map((m) => m.text).join("\n") };
  }
}

export async function connect(config: { url: string | null; password: string | null }): Promise<OpenCode | null> {
  const url = discover(config.url);
  return url ? new OpenCode(url, config.password) : null;
}
