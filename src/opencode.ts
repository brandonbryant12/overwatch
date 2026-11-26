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

/**
 * Where OpenCode answers and the password it requires. OpenCode always requires Basic `opencode:<password>`; its
 * service mode registers both in `$XDG_STATE_HOME/opencode/service.json` (mode 0600). A configured URL and password
 * reference win; under plain `opencode serve` set `opencode.password` to the OPENCODE_PASSWORD it runs with.
 */
export function registration(): { url: string; password: string | null } | null {
  try {
    const file = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");
    const value = JSON.parse(readFileSync(file, "utf8")) as { url?: string; password?: string };
    return typeof value.url === "string" ? { url: value.url.replace(/\/+$/, ""), password: typeof value.password === "string" ? value.password : null } : null;
  } catch {
    return null;
  }
}

/** OpenCode did not answer (down, unreachable, or a server error): work waits; nothing is failed for it. */
export class Unavailable extends Error {}

export class OpenCode {
  readonly url: string;
  private readonly password: string | null;
  private readonly registered: string | null;
  /** `password` is a secret reference; `registered` a password read from OpenCode's own registration. */
  constructor(url: string, password: string | null = null, registered: string | null = null) {
    this.url = url;
    this.password = password;
    this.registered = registered;
  }

  private async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const value = this.password ? await secret(this.password) : this.registered;
    if (value) headers.authorization = "Basic " + Buffer.from(`opencode:${value}`).toString("base64");
    const response = await fetch(this.url + path, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => {
      throw new Unavailable(`OpenCode is not answering at ${this.url} (${(e as Error).message})`);
    });
    if (response.status >= 500) {
      await response.body?.cancel();
      throw new Unavailable(`OpenCode answered ${response.status}`);
    }
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
  /** Catalogs are per location: ask about the folder Overwatch's sessions work in. */
  private at = (path: string, directory: string) => this.data(`${path}?location[directory]=${encodeURIComponent(directory)}`);
  agents = (directory: string) => this.at("/api/agent", directory);
  mcp = (directory: string) => this.at("/api/mcp", directory);
  skills = (directory: string) => this.at("/api/skill", directory);

  createSession(input: { id: string; title: string; agent: string | null; model: string | null; directory: string }) {
    const slash = input.model?.indexOf("/") ?? -1;
    const model = input.model && slash > 0 ? { providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1) } : null;
    return this.call("/api/session", {
      method: "POST",
      body: { id: input.id, title: input.title, location: { directory: input.directory }, ...(input.agent ? { agent: input.agent } : {}), ...(model ? { model } : {}) },
    });
  }

  prompt(session: string, input: { id: string; text: string }) {
    return this.call(`/api/session/${encodeURIComponent(session)}/prompt`, { method: "POST", body: { id: input.id, text: input.text } });
  }

  /** The session's history, oldest first. */
  async messages(session: string): Promise<Message[]> {
    const rows = await this.data(`/api/session/${encodeURIComponent(session)}/message?order=desc&limit=200`);
    return rows
      .map((m) => ({
        id: String(m.id ?? ""),
        type: String(m.type ?? ""),
        text: Array.isArray(m.content) ? m.content.map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : "")).join("") : "",
        outcome: typeof m.outcome === "string" ? m.outcome : null,
      }))
      .reverse();
  }

  /** Whether the peer knows this session. */
  exists = (session: string) => this.call(`/api/session/${encodeURIComponent(session)}`).then(() => true, () => false);

  interrupt = (session: string) => this.call(`/api/session/${encodeURIComponent(session)}/interrupt`, { method: "POST", body: {} }).catch(() => undefined);

  /** After our message `id`: whether the session has gone idle, and what the model said. */
  static after(history: ReadonlyArray<Message>, id: string): { idle: boolean; outcome: string | null; said: string } {
    const i = history.findIndex((m) => m.id === id);
    const later = i < 0 ? [] : history.slice(i + 1);
    const idle = later.find((m) => m.type === "idle");
    return { idle: Boolean(idle), outcome: idle?.outcome ?? null, said: later.filter((m) => m.type === "assistant").map((m) => m.text).join("\n") };
  }
}

/** The OpenCode to use: the configured one, or the one that registered itself. */
export function connect(config: { url: string | null; password: string | null }): OpenCode | null {
  const found = registration();
  if (config.url) return new OpenCode(config.url, config.password, config.password ? null : found?.url === config.url ? found.password : null);
  return found ? new OpenCode(found.url, config.password, found.password) : null;
}
