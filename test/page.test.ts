/**
 * The page's logic, without a browser: the update function, routing preview, sorting/filtering, search hit
 * resolution, keyboard navigation, the grouped inbox and the ways out. What the page sends is the typed client's commands;
 * the commands themselves are exercised against the service in service.test.ts.
 */
import { IncidentId, ThreadId } from "../src/domain/ids.ts";
import { incidentIdFromHit, init, Message, preview, update, visibleInbox, type Model } from "../web/src/app.ts";
import { describe, expect, test } from "./harness.ts";

const inc1 = IncidentId.make("inc_1");
const inc2 = IncidentId.make("inc_2");
const inc3 = IncidentId.make("inc_3");
const base = init({ session: "s" }).model;
/** What the inbox view adds to every row: no way out taken, nothing running. */
const row = { disposition: "inbox" as const, way: null, back: null, changedAt: 0, running: 0, failure: null, recent: [], hidden: [], returns: [] };

const prodError = {
  incidentId: inc1,
  title: "ERROR payment timed out",
  app: "shop-api",
  environment: "production",
  severity: "error" as const,
  firstAt: 100,
  lastAt: 200,
  occurrences: 2,
  verdict: null,
  cause: null,
  ...row,
};
const stagingWarn = {
  incidentId: inc2,
  title: "WARN cache slow",
  app: "shop-api",
  environment: "staging",
  severity: "warn" as const,
  firstAt: 100,
  lastAt: 500,
  occurrences: 4,
  verdict: null,
  cause: null,
  ...row,
};
const qaInfo = {
  incidentId: inc3,
  title: "INFO batch slow",
  app: "billing-cron",
  environment: "qa",
  severity: "info" as const,
  firstAt: 100,
  lastAt: 900,
  occurrences: 1,
  verdict: "not_real",
  cause: "large batch",
  ...row,
};

const withThread = (status: string): Model => ({
  ...base,
  focus: inc1,
  thread: {
    threadId: ThreadId.make("thr_inc_1"),
    subject: inc1,
    title: "t",
    archived: false,
    prompts: [],
    sessions: [{ sessionId: "ses_a", mode: "investigate", status }],
    handoff: null,
  },
});

describe("the page", () => {
  test("a live inbox update replaces the list, clears stale stream errors, and clicking the same item keeps its loaded page", () => {
    const failed = update(base, Message.FailedRead({ reason: "dropped" })).model;
    expect(failed.connection).toBe("offline");
    expect(failed.notice).toContain("Live updates stopped");

    const received = update(failed, Message.ReceivedInbox({ items: [qaInfo, prodError] })).model;
    expect(received.inbox).toHaveLength(2);
    expect(received.live).toBe(true);
    expect(received.connection).toBe("live");
    expect(received.notice).toBe(null);

    const focused = update(received, Message.ClickedItem({ incidentId: inc1 })).model;
    expect(focused.focus).toBe(inc1);
    expect(focused.page).toBe(null);

    const loadedPage = {
      ...focused,
      page: {
        incidentId: inc1,
        threadId: ThreadId.make("thr_inc_1"),
        title: prodError.title,
        app: prodError.app,
        environment: prodError.environment,
        source: "pods",
        fingerprint: "fp",
        severity: "error" as const,
        firstAt: 100,
        lastAt: 200,
        occurrences: 2,
        disposition: "inbox" as const,
        back: null,
        sample: null,
        query: null,
        timeline: [],
        findings: [],
      },
    };
    const clickedAgain = update(loadedPage, Message.ClickedItem({ incidentId: inc1 })).model;
    expect(clickedAgain.page).not.toBe(null);
  });

  test("priority ordering ranks production errors above newer info items, and tier filters work", () => {
    const env = (app: string, environment: string, tier: "production" | "staging" | "development") => ({
      app, environment, tier, everyMs: 60_000, checkedThrough: null, lastError: null, expectsReadings: false, notReadyPods: null, memoryPctOfLimit: null,
    });
    const status = { environments: [env("shop-api", "production", "production"), env("shop-api", "staging", "staging"), env("billing-cron", "qa", "development")] } as never;
    const withAll = { ...base, status, inbox: [qaInfo, stagingWarn, prodError] };
    expect(visibleInbox(withAll).map((i) => i.incidentId)).toEqual([inc1, inc2, inc3]);
    expect(visibleInbox({ ...withAll, sortOrder: "recent" }).map((i) => i.incidentId)).toEqual([inc3, inc2, inc1]);
    expect(visibleInbox({ ...withAll, envFilter: "prod" }).map((i) => i.incidentId)).toEqual([inc1]);
    expect(visibleInbox({ ...withAll, envFilter: "preprod" }).map((i) => i.incidentId)).toEqual([inc2, inc3]);
  });

  test("Done sends the command with a fresh command id, says so with undo, and advances focus (or clears when last)", () => {
    const single = update({ ...base, focus: inc1 }, Message.ReceivedInbox({ items: [prodError] })).model;
    const doneLast = update(single, Message.ChoseWayOut({ incidentId: inc1, kind: "done" }));
    expect(doneLast.model.focus).toBe(null);
    expect(doneLast.model.commandIds.sent).toBe(1);
    expect(doneLast.commands).toHaveLength(1);
    expect(doneLast.model.notice).toBe("Done. Press u to undo.");
    expect(doneLast.model.undo).toEqual({ incidentId: inc1, kind: "done" });
    expect(update(doneLast.model, Message.PressedUndo()).commands).toHaveLength(1);

    const multi = update({ ...base, focus: inc1 }, Message.ReceivedInbox({ items: [prodError, stagingWarn] })).model;
    const doneFirst = update(multi, Message.ChoseWayOut({ incidentId: inc1, kind: "done" }));
    expect(doneFirst.model.focus).toBe(inc2);
    expect(doneFirst.commands).toHaveLength(1);
  });

  test("keyboard focus navigation steps through the rows as shown", () => {
    // inc1 is new; inc3's finding says not real, so it is Quiet, collapsed to a count until opened.
    const populated = update(base, Message.ReceivedInbox({ items: [qaInfo, prodError] })).model;
    const first = update(populated, Message.MovedFocus({ delta: 1 })).model;
    expect(first.focus).toBe(inc1);
    expect(update(first, Message.MovedFocus({ delta: 1 })).model.focus).toBe(inc1);
    const opened = update(first, Message.ToggledGroup({ group: "quiet" })).model;
    const second = update(opened, Message.MovedFocus({ delta: 1 })).model;
    expect(second.focus).toBe(inc3);
    const back = update(second, Message.MovedFocus({ delta: -1 })).model;
    expect(back.focus).toBe(inc1);
  });

  test("the prompt bar sends nothing without focus or text, works on an incident marked Done, and previews routing", () => {
    expect(update({ ...base, drafts: { none: "why?" } }, Message.SubmittedPrompt({})).commands ?? []).toHaveLength(0);
    expect(preview(base)).toContain("Put an incident in focus");
    expect(preview({ ...base, focus: inc1 })).toBe("new session: a new session");
    expect(preview(withThread("idle"))).toBe("continues ses_a: continues the idle session");
    expect(preview(withThread("running"))).toBe("continues ses_a: queued behind the session's current turn");
    // No session picker: Enter sends where the preview says; Shift+Enter sends in a new session.
    const ask = (newSession?: boolean) =>
      ((update({ ...withThread("idle"), drafts: { [inc1]: "why?" } }, Message.SubmittedPrompt(newSession ? { newSession } : {})).commands ?? [])[0] as unknown as { args: { input: { override: string } } }).args.input.override;
    expect(ask()).toBe("auto");
    expect(ask(true)).toBe("new");
    const sent = update({ ...withThread("idle"), drafts: { [inc1]: " why? " } }, Message.SubmittedPrompt({}));
    expect(sent.commands).toHaveLength(1);
    // Kept until the send is acknowledged.
    expect(sent.model.drafts[inc1]).toBe(" why? ");

    // An incident marked Done can still be asked about: its thread stays open.
    const doneModel: Model = {
      ...withThread("idle"),
      drafts: { [inc1]: "retry?" },
      page: {
        incidentId: inc1,
        threadId: ThreadId.make("thr_inc_1"),
        title: prodError.title,
        app: prodError.app,
        environment: prodError.environment,
        source: "pods",
        fingerprint: "fp",
        severity: "error",
        firstAt: 100,
        lastAt: 200,
        occurrences: 2,
        disposition: "done",
        back: null,
        sample: null,
        query: null,
        timeline: [],
        findings: [],
      },
    };
    expect(preview(doneModel)).toBe("continues ses_a: continues the idle session");
    expect(update(doneModel, Message.SubmittedPrompt({})).commands ?? []).toHaveLength(1);
  });

  test("search resolves incident, finding, and thread hits to an IncidentId", () => {
    expect(
      incidentIdFromHit({ kind: "incident", id: "inc_abc", title: "", snippet: "", app: null, environment: null, state: "done", at: 0 }),
    ).toBe(IncidentId.make("inc_abc"));
    expect(
      incidentIdFromHit({ kind: "prompt", id: "thr_inc_abc", title: "", snippet: "", app: null, environment: null, state: null, at: 0 }),
    ).toBe(IncidentId.make("inc_abc"));

    const searching = update(base, Message.ChangedSearchQuery({ query: "stripe" }));
    expect(searching.model.searchLoading).toBe(true);
    expect(searching.commands).toHaveLength(1);
  });

  test("theme toggle switches between dark and light and dispatches DOM sync", () => {
    const toggled = update(base, Message.ToggledTheme());
    expect(toggled.model.theme).toBe("light");
    expect(toggled.commands).toHaveLength(1);
  });
});
