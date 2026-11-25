/**
 * OpenCode as an unreliable peer. The service finds it, creates sessions and sends prompts with ids it chose and
 * recorded first (both calls are idempotent by id), and learns how a prompt went by reading the session's stored
 * messages: the prompt's own message, and the idle marker OpenCode writes after it with an outcome. It never relies
 * on the event stream, which drops subscribers and has no replay.
 */
import { OpenCode } from "@opencode/client";
import { discover } from "@opencode/client/service";

export type PromptState =
  | { readonly kind: "session-missing" }
  /** Not delivered yet: in the session's inbox, or not received at all (then it is sent again). */
  | { readonly kind: "waiting"; readonly inInbox: boolean }
  | { readonly kind: "running" }
  | { readonly kind: "idle"; readonly outcome: "succeeded" | "failed" | "interrupted"; readonly error?: string };

export interface OpenCodePort {
  /** The server's URL, or undefined while OpenCode is not running. */
  readonly connect: () => Promise<string | undefined>;
  readonly createSession: (input: {
    readonly id: string;
    readonly title: string;
    readonly agent: string;
    readonly directory: string;
    readonly metadata: Record<string, string>;
  }) => Promise<void>;
  readonly prompt: (input: { readonly sessionID: string; readonly id: string; readonly text: string; readonly delivery?: "queue" | "steer" }) => Promise<void>;
  readonly promptState: (sessionID: string, messageId: string) => Promise<PromptState>;
  readonly interrupt: (sessionID: string) => Promise<void>;
  /** The last assistant text after a message, for showing an answer next to its subject. */
  readonly answer: (sessionID: string, afterMessageId: string) => Promise<string | undefined>;
}

export interface OpenCodeOptions {
  readonly url?: string;
  readonly username?: string;
  readonly password?: string;
}

type Client = ReturnType<typeof OpenCode.make>;

const status = (error: unknown) => (error as { status?: number; response?: { status?: number } })?.status ?? (error as { response?: { status?: number } })?.response?.status;
const isNotFound = (error: unknown) => status(error) === 404 || /not ?found|NotFound/i.test(String((error as Error)?.message ?? error));

export function openCodePort(options: OpenCodeOptions): OpenCodePort {
  let client: Client | undefined;
  let url: string | undefined;

  const connect = async () => {
    try {
      if (options.url) {
        if (!client) {
          const headers: Record<string, string> = options.password
            ? { Authorization: `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}` }
            : {};
          client = OpenCode.make({ baseUrl: options.url, headers });
          url = options.url;
        }
      } else {
        const found = await discover();
        if (!found) {
          client = undefined;
          url = undefined;
          return undefined;
        }
        if (found.url !== url) {
          const headers: Record<string, string> = found.auth
            ? { Authorization: `Basic ${Buffer.from(`${found.auth.username}:${found.auth.password}`).toString("base64")}` }
            : {};
          client = OpenCode.make({ baseUrl: found.url, headers });
          url = found.url;
        }
      }
      await client!.server.info({ signal: AbortSignal.timeout(2_000) });
      return url;
    } catch {
      return undefined;
    }
  };
  const need = () => {
    if (!client) throw new Error("OpenCode is not connected");
    return client;
  };

  return {
    connect,
    createSession: async (input) => {
      await need().session.create({
        id: input.id,
        title: input.title,
        agent: input.agent,
        location: { directory: input.directory },
        metadata: input.metadata,
      });
    },
    prompt: async (input) => {
      await need().session.prompt({ sessionID: input.sessionID, id: input.id, text: input.text, ...(input.delivery ? { delivery: input.delivery } : {}) });
    },
    promptState: async (sessionID, messageId) => {
      const c = need();
      try {
        await c.session.get({ sessionID });
      } catch (error) {
        if (isNotFound(error)) return { kind: "session-missing" };
        throw error;
      }
      const messages = (await c.message.list({ sessionID, order: "desc", limit: 200 })).data;
      const at = messages.findIndex((m) => m.id === messageId);
      if (at < 0) {
        const inbox = await c.session.inbox.list({ sessionID });
        return { kind: "waiting", inInbox: inbox.some((item) => (item as { id?: string }).id === messageId) };
      }
      // Newest first: an idle marker before index `at` came after the prompt.
      const idle = messages.slice(0, at).findLast((m) => m.type === "idle") as { outcome: "succeeded" | "failed" | "interrupted"; error?: unknown } | undefined;
      const active = await c.session.active();
      if (sessionID in active) return { kind: "running" };
      if (!idle) return { kind: "running" };
      return { kind: "idle", outcome: idle.outcome, ...(idle.error ? { error: JSON.stringify(idle.error).slice(0, 300) } : {}) };
    },
    interrupt: async (sessionID) => {
      await need().session.interrupt({ sessionID });
    },
    answer: async (sessionID, afterMessageId) => {
      const messages = (await need().message.list({ sessionID, order: "desc", limit: 100 })).data;
      const at = messages.findIndex((m) => m.id === afterMessageId);
      const newer = at < 0 ? [] : messages.slice(0, at);
      for (const m of newer) {
        if (m.type !== "assistant") continue;
        const text = (m as { content: Array<{ type: string; text?: string }> }).content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
          .trim();
        if (text) return text.slice(0, 4_000);
      }
      return undefined;
    },
  };
}
