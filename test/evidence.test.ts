import fc from "fast-check";
import { test, expect } from "./harness.ts";
import { verifyCitations } from "../src/collect/citations.ts";
import { plainFinding, databaseText, seed, testService, offline, recordFinding, watcher, until, threadIdOf } from "./fixtures/scenario.ts";
import { queryTelemetry } from "../src/service/mcp.ts";
import { shownFor } from "../src/service/tables.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tempDir } from "./fixtures/support.ts";

const word = fc.stringOf(fc.constantFrom(..."abcdefhijkmnpqrstuvwxyz"), { minLength: 9, maxLength: 15 });
for (const scenario of ["literal fragments", "source and file sharing a name"] as const)
  test("source provenance: " + scenario, async () => {
    const dir = tempDir("pending-quotes");
    await fc.assert(
      fc.asyncProperty(word, word, word, async (label, left, right) => {
        const text = "Observed " + left;
        const other = "Elsewhere " + right;
        writeFileSync(join(dir, label), other);
        const matches = async (source: string, quote: string, directory?: string) => {
          const f = plainFinding("check", quote);
          f.engineering.evidence[0]!.source = source;
          const checked = await verifyCitations(f, {
            sources: [label],
            shown: [
              { source: label, text },
              { source: "brief:question", text: other },
            ],
            directory,
          });
          return checked.finding.engineering.evidence[0]!.verified;
        };
        expect(await matches(label, text)).toBe(true);
        expect(await matches("unknown-" + label, other)).toBe(false);
        if (scenario === "literal fragments") expect(await matches(label, text + " ... NO")).toBe(false);
        else expect(await matches(label, other, dir)).toBe(false);
      }),
      { numRuns: 30, seed: 62188 },
    );
  });

test("query arguments stay outside source output recorded by the live telemetry tool", async () => {
  const f = await testService();
  try {
    const id = await seed(f);
    await f.service.atomically((db) =>
      db
        .prepare(
          "INSERT INTO run_tokens(token,run_id,session_id,thread_id,subject,role,created_at) VALUES('t','r','s','th',?,'investigator',0)",
        )
        .run(id),
    );
    const ports = { ...f.service.mcpPorts, runStatus: async () => "sent" as const };
    await fc.assert(
      fc.asyncProperty(word, async (value) => {
        const selector = "app=" + value;
        const result = await queryTelemetry(ports, "s", {
          token: "t",
          source: "pods",
          args: { operation: "get", resource: "events", selector },
        });
        expect(JSON.parse(result)).toEqual({ items: [] });
        const shown = await f.service.read((db) => shownFor(db, "s"));
        expect(shown.filter((x) => x.source === "pods").some((x) => x.text.includes(selector))).toBe(false);
        expect(shown.some((x) => x.source === "pods" && x.text.includes(result))).toBe(true);
      }),
      { numRuns: 12 },
    );
  } finally {
    await f.service.stop();
  }
});

test("synthetic credential values in logs, page and OpenCode prompts, findings and decisions never persist or leave in a prompt", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 10000, max: 99999 }), async (n) => {
      const sent: string[] = [];
      let incoming: Array<{ id: string; text: string }> = [];
      const port = {
        ...offline,
        connect: async () => "http://opencode.test",
        createSession: async () => {},
        prompt: async (i: { text: string }) => {
          sent.push(i.text);
        },
        synthetic: async (i: { text: string }) => {
          sent.push(i.text);
        },
        newUserMessages: async () => incoming.splice(0),
        promptState: async () => ({ kind: "running" as const }),
      };
      const f = await testService({ opencode: port });
      try {
        const values = ["trainingPass" + n, "TrainingKey" + n + "xk5Q7m92", "trainingCookie" + n, "SqlTraining" + n];
        const content = [
          'password="' + values[0] + '"',
          "Authorization: Bearer " + values[1],
          "Cookie: session=" + values[2],
          "postgres://user:" + values[3] + "@db.test/app",
        ].join("\n");
        const id = await seed(f, "ERROR upstream reported password=" + values[0]);
        const tid = threadIdOf(id);
        await f.client((api) =>
          api.AskThread(tid, {
            subject: id,
            title: content,
            text: content,
            promptId: "review-page",
            mode: "investigate",
            origin: "page",
            override: "new",
          }),
        );
        await until(
          async () => {
            await f.service.work();
            return sent.length;
          },
          (v) => v > 0,
        );
        incoming = [{ id: "msg_review_" + n, text: content }];
        await until(
          async () => {
            await f.service.work();
            return f.service.read(
              (db) =>
                db.prepare("SELECT count(*) n FROM journal WHERE type='PromptAsked' AND json_extract(data,'$.origin')='opencode'").get()!.n,
            );
          },
          (v) => Number(v) > 0,
        );
        await recordFinding(f, id, content);
        await f.client((api) => api.MarkDone(id, { reason: content, actor: content }));
        await f.client((api) => api.Restore(id, { actor: content }));
        await f.client((api) => api.Defer(id, { label: content, actor: content }));
        await f.service.collect(watcher);
        const stored = await f.service.read(databaseText);
        expect(stored).toContain("REDACTED");
        for (const sentinel of values) {
          expect(stored.includes(sentinel)).toBe(false);
          expect(sent.some((text) => text.includes(sentinel))).toBe(false);
        }
      } finally {
        await f.service.stop();
      }
    }),
    { numRuns: 3, seed: 62188 },
  );
});
