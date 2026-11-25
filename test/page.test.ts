/**
 * The page's logic, without a browser: the update function, routing preview, sorting/filtering, search hit
 * resolution, keyboard navigation, and offline/archived guards. What the page sends is the typed client's commands;
 * the commands themselves are exercised against the service in service.test.ts.
 */
import { IncidentId, ThreadId } from "../src/domain/ids.ts";
import { incidentIdFromHit, init, Message, preview, update, visibleInbox, type Model } from "../web/src/app.ts";
import { describe, expect, test } from "./harness.ts";

const inc1 = IncidentId.make("inc_1");
const inc2 = IncidentId.make("inc_2");
const inc3 = IncidentId.make("inc_3");
const base = init({ session: "s" }).model;

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

  test("archive sends the command with a fresh command id and advances focus (or clears when last)", () => {
    const single = { ...base, inbox: [prodError], focus: inc1 };
    const archivedLast = update(single, Message.ClickedArchive({ incidentId: inc1 }));
    expect(archivedLast.model.focus).toBe(null);
    expect(archivedLast.model.commandIds.sent).toBe(1);
    expect(archivedLast.commands).toHaveLength(1);

    const multi = { ...base, inbox: [prodError, stagingWarn], focus: inc1 };
    const archivedFirst = update(multi, Message.ClickedArchive({ incidentId: inc1 }));
    expect(archivedFirst.model.focus).toBe(inc2);
    expect(archivedFirst.commands).toHaveLength(1);
  });

  test("keyboard focus navigation steps through the visible inbox", () => {
    const populated = { ...base, inbox: [qaInfo, prodError] };
    const first = update(populated, Message.MovedFocus({ delta: 1 })).model;
    expect(first.focus).toBe(inc1);
    const second = update(first, Message.MovedFocus({ delta: 1 })).model;
    expect(second.focus).toBe(inc3);
    const back = update(second, Message.MovedFocus({ delta: -1 })).model;
    expect(back.focus).toBe(inc1);
  });

  test("the prompt bar sends nothing without focus, text, or on archived incidents, and previews routing", () => {
    expect(update({ ...base, drafts: { none: "why?" } }, Message.SubmittedPrompt()).commands ?? []).toHaveLength(0);
    expect(preview(base)).toContain("Put an incident in focus");
    expect(preview({ ...base, focus: inc1 })).toBe("new session: a new session");
    expect(preview(withThread("idle"))).toBe("continues ses_a: continues the idle session");
    expect(preview(withThread("running"))).toBe("continues ses_a: queued behind the session's current turn");
    expect(preview({ ...withThread("idle"), override: "new" })).toBe("new session: a new session, as asked");
    const sent = update({ ...withThread("idle"), drafts: { [inc1]: " why? " } }, Message.SubmittedPrompt());
    expect(sent.commands).toHaveLength(1);
    // Kept until the send is acknowledged.
    expect(sent.model.drafts[inc1]).toBe(" why? ");

    const archivedModel: Model = {
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
        disposition: "archived",
        sample: null,
        query: null,
        timeline: [],
        findings: [],
      },
    };
    expect(preview(archivedModel)).toContain("archived");
    expect(update(archivedModel, Message.SubmittedPrompt()).commands ?? []).toHaveLength(0);
  });

  test("search resolves incident, finding, and thread hits to an IncidentId", () => {
    expect(
      incidentIdFromHit({ kind: "incident", id: "inc_abc", title: "", snippet: "", app: null, environment: null, state: "archived", at: 0 }),
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
