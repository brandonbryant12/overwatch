// Reusable copy of the scripted investigator and response stream from scripts/e2e.ts.
// The original starts a whole test process on import. Keep one shared fixture when this suite graduates.
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
type Message = { role: string; content: unknown; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
const textOf = (m: { content: unknown }) =>
  typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("") : "";
function reply(res: ServerResponse, next: { call?: { name: string; arguments: string }; text?: string }) {
  const id = `e2e-${randomUUID()}`;
  const delta = next.call
    ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: next.call }] }
    : { role: "assistant", content: next.text ?? "ok" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "e2e", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "e2e", choices: [{ index: 0, delta: {}, finish_reason: next.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

export async function scriptedProvider() {
  const prompts: string[] = [];
  const requests: Array<{ model: string; findingCalls: number }> = [];
  const RULED_OUT = "a bad deploy of the payments database";
  const finding = (token: string, quote: string, extra: Record<string, unknown> = {}) => ({
    token,
    finding: {
      product: {
        impact: "Some card payments fail at checkout",
        affected: "customers paying by card",
        since: "the last hour",
        status: "ongoing",
      },
      engineering: {
        verdict: "real",
        confidence: "high",
        cause: "Payment calls time out after 300ms, set in payments.ts.",
        causeBasis: "observed",
        evidence: [
          { source: "pods", quote },
          { source: "payments.ts", quote: "export const TIMEOUT_MS = 300" },
        ],
        codeLocation: "payments.ts:1",
        notChecked: ["the payment provider's status"],
        nextCheck: "Check the provider's p95 latency for the last hour.",
      },
      ruledOut: [RULED_OUT],
      ...extra,
    },
  });

  /** What the investigator does next, from the conversation so far. */
  function script(messages: Message[], tools: string[]): { call?: { name: string; arguments: string }; text?: string } {
    const all = messages.map(textOf).join("\n");
    const tool = (suffix: string) => tools.find((t) => t.endsWith(suffix)) ?? suffix;
    const tokens = [...all.matchAll(/run token is (owt_[\w-]+)/g)].map((m) => m[1]!);
    const token = tokens.at(-1);
    if (!token) return { text: "No run token in my prompt." };
    // Only what happened since the prompt that carried this token counts.
    const at = messages.findLastIndex((m) => m.role === "user" && textOf(m).includes(token));
    const since = messages.slice(at + 1);
    const results = since.filter((m) => m.role === "tool").map(textOf);
    const prompt = textOf(messages[at]!);
    prompts.push(prompt);
    if (results.some((r) => r.includes("Recorded. Stop now")))
      return { text: prompt.includes("rule out") ? `We ruled out: ${RULED_OUT}.` : "Filed." };
    if (prompt.includes("recorded the owner's question")) {
      return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) } };
    }
    if (prompt.includes("what did we rule out")) {
      // A fresh session answers from the handoff in its context pack, and cites it.
      const line = prompt.split("\n").find((l) => l.includes(RULED_OUT));
      if (!line) return { text: "The handoff did not reach me." };
      return { call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) } };
    }
    switch (results.length) {
      case 0:
        return {
          call: {
            name: tool("query_telemetry"),
            arguments: JSON.stringify({ token, source: "pods", since: "2h", args: { operation: "logs", pod: "shop-api-1" } }),
          },
        };
      case 1:
        return {
          call: {
            name: tool("query_telemetry"),
            arguments: JSON.stringify({ token, source: "pods", args: { operation: "delete", pod: "shop-api-1" } }),
          },
        };
      case 2:
        return {
          call: {
            name: tool("file_finding"),
            arguments: JSON.stringify(finding(token, "ERROR payment 99 failed because the moon was full")),
          },
        };
      case 3:
        return {
          call: {
            name: tool("file_finding"),
            arguments: JSON.stringify(finding("owt_not_this_run", "ERROR payment 42 timed out after 300ms")),
          },
        };
      default:
        return {
          call: { name: tool("file_finding"), arguments: JSON.stringify(finding(token, "ERROR payment 42 timed out after 300ms")) },
        };
    }
  }

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const messages = body.messages as Message[];
    const tools = (body.tools ?? []).map((x: { function?: { name: string }; name?: string }) => x.function?.name ?? x.name);
    const next = messages.some((m) => m.role === "system" && textOf(m).includes("You are Overwatch's investigator"))
      ? script(messages, tools)
      : { text: "ok" };
    requests.push({ model: body.model, findingCalls: next.call?.name.endsWith("file_finding") ? 1 : 0 });
    reply(res, next);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + (server.address() as { port: number }).port + "/v1",
    requests,
    prompts,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
