/**
 * The page's logic, without a browser: the update function and the routing preview. What the page sends is the
 * typed client's commands; the commands themselves are exercised against the service in service.test.ts.
 */
import { IncidentId, ThreadId } from "../src/domain/ids.ts";
import { init, Message, preview, update, type Model } from "../web/src/app.ts";
import { describe, expect, test } from "./harness.ts";

const incident = IncidentId.make("inc_1");
const base = init({ session: "s" }).model;
const item = { incidentId: incident, title: "ERROR payment timed out", app: "shop-api", environment: "production", severity: "error" as const, firstAt: 0, lastAt: 0, occurrences: 2, verdict: null, cause: null };
const withThread = (status: string): Model => ({
  ...base,
  focus: incident,
  thread: { threadId: ThreadId.make("thr_inc_1"), subject: incident, title: "t", archived: false, prompts: [], sessions: [{ sessionId: "ses_a", mode: "investigate", status }], handoff: null },
});

describe("the page", () => {
  test("a live inbox update replaces the list; focusing an item clears the old focus", () => {
    const received = update(base, Message.ReceivedInbox({ items: [item] })).model;
    expect(received.inbox).toHaveLength(1);
    expect(received.live).toBe(true);
    const focused = update(received, Message.ClickedItem({ incidentId: incident })).model;
    expect(focused.focus).toBe(incident);
    expect(focused.page).toBe(null);
  });

  test("archive sends the command with a fresh command id and drops the focus", () => {
    const focused = { ...base, inbox: [item], focus: incident };
    const result = update(focused, Message.ClickedArchive({ incidentId: incident }));
    expect(result.model.focus).toBe(null);
    expect(result.model.commandIds.sent).toBe(1);
    expect(result.commands).toHaveLength(1);
  });

  test("the prompt bar sends nothing without focus or text, and says before sending where a prompt will go", () => {
    expect(update({ ...base, draft: "why?" }, Message.SubmittedPrompt()).commands ?? []).toHaveLength(0);
    expect(preview(base)).toContain("Put something in focus");
    expect(preview({ ...base, focus: incident })).toBe("new session: a new session");
    expect(preview(withThread("idle"))).toBe("continues ses_a: continues the idle session");
    expect(preview(withThread("running"))).toBe("continues ses_a: queued behind the session's current turn");
    expect(preview({ ...withThread("idle"), override: "new" })).toBe("new session: a new session, as asked");
    const sent = update({ ...withThread("idle"), draft: " why? " }, Message.SubmittedPrompt());
    expect(sent.commands).toHaveLength(1);
    expect(sent.model.draft).toBe("");
  });
});
