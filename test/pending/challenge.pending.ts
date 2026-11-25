import { test, expect } from "../harness.ts";
import { fileFinding } from "../../src/service/mcp.ts";
import { testService, seed, until, plainFinding, offline, threadIdOf } from "./support.ts";
import { withPage } from "./page.ts";

test("a real finding stays provisional until a distinct session challenges it; a disproof remains visible", async () => {
  const sent: Array<{ sessionID: string; text: string }> = [];
  const port = {
    ...offline,
    connect: async () => "http://opencode.test",
    createSession: async () => {},
    prompt: async (p: { sessionID: string; text: string }) => {
      sent.push(p);
    },
    promptState: async () => ({ kind: "running" as const }),
  };
  const f = await testService({ opencode: port });
  try {
    const sample = "ERROR payment timed out";
    const id = await seed(f, sample);
    await f.client((api) =>
      api.AskThread(threadIdOf(id), {
        subject: id,
        title: "payment",
        text: "Investigate",
        promptId: "first",
        mode: "investigate",
        origin: "page",
        override: "new",
      }),
    );
    const next = async (n: number) => {
      await until(
        async () => {
          await f.service.work();
          return sent.length;
        },
        (len) => len >= n,
      );
      const msg = sent[n - 1]!;
      const token = /run token is (owt_[\w-]+)/.exec(msg.text)?.[1];
      if (!token) throw Error("Missing run token");
      return { ...msg, token };
    };
    const first = await next(1);
    expect(
      await fileFinding(f.service.mcpPorts, first.sessionID, { token: first.token, finding: plainFinding("Processor outage", sample) }),
    ).toContain("Recorded");
    await withPage(f.service.url, async (evaluate) => {
      await until(() => evaluate("document.querySelector('.inbox-item')?.textContent"), Boolean);
      await evaluate("document.querySelector('.inbox-item').click()");
      const body = () => evaluate("document.body.innerText");
      await until(body, (s) => /awaiting independent check/i.test(s));
      expect(await body()).not.toMatch(/settled[: ]+real/i);
      const second = await next(2);
      expect(second.sessionID).not.toBe(first.sessionID);
      expect(second.text).toMatch(/disprove|falsify|counterevidence/i);
      expect(second.text).toContain("Processor outage");
      const cause = "The provider remained available; the client timed out.";
      const finding = plainFinding(cause, sample);
      const result = await fileFinding(f.service.mcpPorts, second.sessionID, {
        token: second.token,
        finding: { ...finding, engineering: { ...finding.engineering, verdict: "not_real" } },
      });
      expect(result).toContain("Recorded");
      await until(body, (s) => /disproved/i.test(s) && s.includes(cause));
      const history = await f.service.read((db) =>
        db
          .prepare("SELECT data FROM journal ORDER BY position")
          .all()
          .map((x) => String(x.data))
          .join("\n"),
      );
      expect(history).toContain(first.sessionID);
      expect(history).toContain(second.sessionID);
      expect(history).toContain(cause);
    });
  } finally {
    await f.service.stop();
  }
});
