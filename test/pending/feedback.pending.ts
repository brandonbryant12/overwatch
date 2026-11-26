import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../harness.ts";
import { seed, testService, threadIdOf, offline, plainFinding, until } from "../fixtures/scenario.ts";
import { fileFinding } from "../../src/service/mcp.ts";
import { withPage } from "../fixtures/page.ts";

test("one corrected finding appends one dated lesson, appears in the next investigation and is acknowledged on its page", async () => {
  const sent: Array<{ sessionID: string; text: string }> = [];
  const f = await testService({
    opencode: {
      ...offline,
      connect: async () => "http://opencode.test",
      createSession: async () => {},
      prompt: async (p) => {
        sent.push(p);
      },
      promptState: async () => ({ kind: "running" }),
    },
  });
  try {
    const local = join(f.dataDir, "local");
    const dir = join(local, "playbooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "shop-api.md");
    writeFileSync(file, "# Prior lessons\n");
    const other = "Other app only: keep the annual report.";
    writeFileSync(join(dir, "billing.md"), other);
    const id = await seed(f);
    const ask = (promptId: string) =>
      f.client((api) =>
        api.AskThread(threadIdOf(id), {
          subject: id,
          title: "Why?",
          text: "Investigate again",
          promptId,
          mode: "investigate",
          origin: "page",
          override: "new",
        }),
      );
    await ask("before-lesson");
    await until(
      async () => {
        await f.service.work();
        return sent.length;
      },
      (n) => n === 1,
    );
    const first = sent[0]!;
    const token = /run token is (owt_[\w-]+)/.exec(first.text)?.[1];
    if (!token) throw Error("Missing initial run token");
    const finding = plainFinding("processor delay", "ERROR payment timed out");
    const answer = await fileFinding(f.service.mcpPorts, first.sessionID, {
      token,
      finding: { ...finding, engineering: { ...finding.engineering, verdict: "unsure" } },
    });
    expect(answer).toContain("Recorded");
    const lesson = "Card authorizations timed out in the gateway.";
    await withPage(f.service.url, async (evaluate) => {
      await until(() => evaluate("document.querySelector('.inbox-item')?.textContent"), Boolean);
      await evaluate("document.querySelector('.inbox-item').click()");
      await until(
        () => evaluate("document.body.innerText"),
        (s) => s.includes("processor delay"),
      );
      const correction = 'button[aria-label="Correct this finding"]';
      await until(
        () => evaluate("!!document.querySelector(" + JSON.stringify(correction) + ")"),
        (x) => x === "true",
      );
      await evaluate("document.querySelector(" + JSON.stringify(correction) + ").click()");
      const input = 'textarea[aria-label="What actually happened?"]';
      await until(
        () => evaluate("!!document.querySelector(" + JSON.stringify(input) + ")"),
        (x) => x === "true",
      );
      await evaluate(
        "(()=>{const e=document.querySelector(" +
          JSON.stringify(input) +
          ");e.value=" +
          JSON.stringify(lesson) +
          ";e.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      const save = 'button[aria-label="Save correction"]';
      await evaluate("(()=>{const b=document.querySelector(" + JSON.stringify(save) + ");b.click();b.click();})()");
      await until(
        async () => readFileSync(file, "utf8"),
        (s) => s.includes(lesson),
      );
    });
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("# Prior lessons");
    expect(lines[1]).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(lines[1]).toContain(lesson);
    await ask("check-lesson");
    await until(
      async () => {
        await f.service.work();
        return sent.length;
      },
      (n) => n === 2,
    );
    expect(sent.at(-1)?.text).toContain(lesson);
    expect(sent.at(-1)?.text).not.toContain(other);
    await withPage(f.service.url, async (evaluate) => {
      await until(
        () => evaluate("document.querySelector('.inbox-item')?.click() ?? document.querySelector('.inbox-item.focused')?.textContent"),
        Boolean,
      );
      await until(
        () => evaluate("document.querySelector(" + JSON.stringify('[data-playbook-session="' + sent[1]!.sessionID + '"]') + ")?.innerText"),
        (s) => /playbook/i.test(s) && s.includes(lesson),
      );
    });
  } finally {
    await f.service.stop();
  }
});
