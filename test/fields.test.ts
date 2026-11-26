import fc from "fast-check";
import { test, expect } from "./harness.ts";
import { fileFinding } from "../src/service/mcp.ts";
import { testService, seed, threadIdOf, offline, until, plainFinding, databaseText } from "./fixtures/scenario.ts";

const shapes = (n: number) => {
  const simple = "TrainingOnly" + n,
    multi = "two training words " + n;
  return [
    ["password=" + simple, simple],
    ['{"client_secret":"' + multi + '"}', multi],
    ["postgres://user:" + simple + "@fixture.test/app", simple],
    ["Set-Cookie: session=" + simple, simple],
    ["Authorization: Bearer " + simple, simple],
    ["X-Api-Key: " + simple, simple],
    ["-----BEGIN PRIVATE KEY-----\n" + simple + "\n-----END PRIVATE KEY-----", simple],
    ["ghp_" + simple.repeat(2), "ghp_" + simple.repeat(2)],
  ] as const;
};

test("each finding field can receive a supported secret shape without preserving it in a row or a later prompt", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 11111, max: 99999 }), fc.integer({ min: 0, max: 7 }), async (n, shift) => {
      const sent: Array<{ sessionID: string; text: string }> = [];
      const f = await testService({
        opencode: {
          ...offline,
          connect: async () => "http://fixture.test",
          createSession: async () => {},
          prompt: async (p) => {
            sent.push(p);
          },
          synthetic: async (p) => {
            sent.push(p);
          },
          promptState: async () => ({ kind: "running" }),
        },
      });
      try {
        const id = await seed(f);
        const thread = threadIdOf(id);
        const ask = (promptId: string) =>
          f.client((api) =>
            api.AskThread(thread, {
              subject: id,
              title: "Payment",
              text: "What happened?",
              promptId,
              mode: "investigate",
              origin: "page",
              override: "new",
            }),
          );
        await ask("first");
        await until(
          async () => {
            await f.service.work();
            return sent.length;
          },
          (v) => v > 0,
        );
        const msg = sent[0]!;
        const token = /run token is (owt_[\w-]+)/.exec(msg.text)?.[1];
        if (!token) throw Error("Missing investigator token");
        const sentinels: string[] = [];
        const field = (i: number) => {
          const [value, sentinel] = shapes(n + i)[(shift + i) % 8]!;
          sentinels.push(sentinel);
          return value;
        };
        const finding = plainFinding("x");
        const response = await fileFinding(f.service.mcpPorts, msg.sessionID, {
          token,
          finding: {
            product: { impact: field(0), affected: field(1), since: field(2), status: field(3) },
            engineering: {
              ...finding.engineering,
              verdict: "unsure",
              causeBasis: "inferred",
              cause: field(4),
              evidence: [{ source: "operator", quote: field(5) }],
              notChecked: [field(6)],
              nextCheck: field(7),
            },
            ruledOut: [field(8)],
          },
        });
        expect(response).toContain("Recorded");
        await ask("second");
        await until(
          async () => {
            await f.service.work();
            return sent.filter((m) => m.text.includes("run token is")).length;
          },
          (v) => v >= 2,
        );
        const data = await f.service.read(databaseText);
        for (const s of sentinels) {
          expect(data.includes(s)).toBe(false);
          expect(sent.some((m) => m.text.includes(s))).toBe(false);
        }
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 3, seed: 62188 },
  );
});

test("caller-supplied prompt metadata follows the same storage boundary as prompt text", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 10000, max: 99999 }), async (n) => {
      const f = await testService();
      try {
        const id = await seed(f),
          [value, sentinel] = shapes(n)[0];
        // Rejecting an invalid external ID or mapping it to an opaque ID both satisfy this contract.
        await f
          .client((api) =>
            api.AskThread(threadIdOf(id), {
              subject: id,
              title: "Subject",
              text: "What happened?",
              promptId: value,
              mode: "investigate",
              origin: "page",
              override: "new",
            }),
          )
          .catch(() => undefined);
        expect((await f.service.read(databaseText)).includes(sentinel)).toBe(false);
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 4, seed: 62188 },
  );
});
