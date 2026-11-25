/**
 * Stories: the model's behaviour on Alchemy's in-memory host. Every committed event, reply and rejection is
 * accounted for, and every order of concurrent policy work is replayed.
 */
import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ArchiveIncident,
  AskThread,
  CompleteRun,
  handlers,
  HandoffRecorded,
  Incident,
  IncidentArchived,
  IncidentOpened,
  incidentIdOf,
  INBOX,
  Inbox,
  FindingRecorded,
  MarkRunSent,
  messageIdOf,
  NotOpened,
  Overwatch,
  PromptAsked,
  ReportSignal,
  RequestRun,
  routePrompt,
  Run,
  RunClosed,
  RunCompleted,
  RunFailed,
  RunNotSent,
  WrongSession,
  RunRequested,
  RunSent,
  runIdOf,
  SearchStore,
  SessionStatusNoted,
  sessionIdOf,
  SignalRecurred,
  Thread,
  ThreadPage,
  threadIdOf,
  WatcherId,
  type Finding,
} from "../src/domain/index.ts";
import { describe, expect, test } from "./harness.ts";

const memorySearch = Layer.succeed(SearchStore, { search: () => Effect.succeed([]) });
const held = Story.make(Overwatch, { layer: handlers({ autoInvestigate: false }).pipe(Layer.provide(memorySearch)) });
const auto = Story.make(Overwatch, { layer: handlers({ autoInvestigate: true }).pipe(Layer.provide(memorySearch)) });
const run = (effect: Effect.Effect<void, unknown>) => Effect.runPromise(effect);

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const id = incidentIdOf("shop-api", "production", "pods:log:abc");
const incident = Incident.ref(id);
const threadId = threadIdOf(id);
const thread = Thread.ref(threadId);
const signal = {
  app: "shop-api",
  environment: "production",
  watcher: WatcherId.make("shop-api/production"),
  source: "pods",
  fingerprint: "pods:log:abc",
  title: "ERROR payment # timed out after #ms",
  severity: "error" as const,
  at: T0 - 60_000,
  count: 2,
  sample: "ERROR payment 42 timed out after 300ms",
};
const opened = new IncidentOpened({ ...signal, firstAt: signal.at });
const triage = (heldPrompt: boolean) =>
  new PromptAsked({
    subject: id,
    title: signal.title,
    promptId: "triage",
    text: "Investigate this incident.",
    mode: "investigate",
    origin: "system",
    runId: runIdOf(threadId, "triage"),
    sessionId: sessionIdOf(threadId, "triage"),
    messageId: messageIdOf(threadId, "triage"),
    newSession: true,
    reason: "a new session",
    held: heldPrompt,
    handoff: null,
    at: T0,
  });

const finding: Finding = {
  product: { impact: "Some card payments fail", affected: "card payers", since: "unknown", status: "ongoing" },
  engineering: {
    verdict: "real",
    confidence: "high",
    cause: "Payment calls time out after 300ms.",
    causeBasis: "observed",
    evidence: [{ source: "pods", quote: "ERROR payment 42 timed out after 300ms", verified: true }],
    notChecked: ["provider status"],
    nextCheck: "Check provider latency.",
  },
  ruledOut: ["a bad deploy of the database"],
};

describe("the model", () => {
  test("is well defined", () => {
    expect(Domain.verify(Overwatch)).toEqual([]);
  });
});

describe("incidents", () => {
  test("a signal opens one incident and records one triage intent; more of it counts quietly", () =>
    run(
      held(
        Story.when(incident, new ReportSignal(signal)),
        Story.then(incident, opened),
        Story.then(thread, triage(true)),
        Story.view(Inbox, INBOX, (v) => v?.items.length === 1 && v.items[0]!.occurrences === 2),
        Story.when(incident, new ReportSignal({ ...signal, at: T0 - 30_000, count: 3 })),
        Story.then(incident, new SignalRecurred({ at: T0 - 30_000, count: 3, occurrences: 5, sample: signal.sample })),
        Story.then(thread),
        Story.view(Inbox, INBOX, (v) => v?.items[0]?.occurrences === 5),
      ),
    ));

  test("archive removes it from the inbox for good: the same signal again updates it silently", () =>
    run(
      held(
        Story.given(incident, opened),
        Story.when(incident, new ArchiveIncident({})),
        Story.then(incident, new IncidentArchived({ reason: "archived by the owner", at: T0 })),
        Story.view(Inbox, INBOX, (v) => v?.items.length === 0),
        Story.when(incident, new ArchiveIncident({})),
        Story.then(incident),
        Story.when(incident, new ReportSignal({ ...signal, at: T0 + 1_000, count: 1 })),
        Story.then(incident, new SignalRecurred({ at: T0 + 1_000, count: 1, occurrences: 3, sample: signal.sample })),
        Story.view(Inbox, INBOX, (v) => v?.items.length === 0),
      ),
    ));

  test("archiving an incident that does not exist is refused", () =>
    run(held(Story.when(incident, new ArchiveIncident({})), Story.rejected(new NotOpened()))));
});

describe("threads and runs", () => {
  test("with automatic investigation on, the triage intent becomes one run, with its ids chosen up front", () =>
    run(
      auto(
        Story.when(incident, new ReportSignal(signal)),
        Story.then(incident, opened),
        Story.then(thread, triage(false)),
        Story.then(
          Run.ref(runIdOf(threadId, "triage")),
          new RunRequested({
            threadId,
            subject: id,
            promptId: "triage",
            mode: "investigate",
            sessionId: sessionIdOf(threadId, "triage"),
            messageId: messageIdOf(threadId, "triage"),
            newSession: true,
            text: "Investigate this incident.",
            origin: "system",
            handoff: null,
            at: T0,
          }),
        ),
        Story.view(ThreadPage, thread, (v) => v?.prompts[0]?.status === "queued"),
      ),
    ));

  test("a run that completes records the finding on the incident and a handoff on the thread", () => {
    const runRef = Run.ref(runIdOf(threadId, "p-1"));
    const sessionId = sessionIdOf(threadId, "p-1");
    return run(
      held(
        Story.given(incident, opened),
        Story.given(thread, triage(true)),
        Story.given(
          runRef,
          new RunRequested({
            threadId,
            subject: id,
            promptId: "p-1",
            mode: "investigate",
            sessionId,
            messageId: messageIdOf(threadId, "p-1"),
            newSession: true,
            text: "why?",
            origin: "page",
            handoff: null,
            at: T0,
          }),
        ),
        Story.when(runRef, new MarkRunSent({})),
        Story.then(runRef, new RunSent({ threadId, sessionId, messageId: messageIdOf(threadId, "p-1"), at: T0 })),
        Story.then(thread, new SessionStatusNoted({ sessionId, status: "running" })),
        Story.when(runRef, new CompleteRun({ sessionId, finding })),
        Story.then(runRef, new RunCompleted({ threadId, subject: id, sessionId, finding, at: T0 })),
        Story.then(incident, new FindingRecorded({ runId: runIdOf(threadId, "p-1"), threadId, sessionId, finding, at: T0 })),
        Story.then(
          thread,
          new HandoffRecorded({
            handoff: {
              runId: runIdOf(threadId, "p-1"),
              sessionId,
              concluded: "real (high confidence): Payment calls time out after 300ms.",
              verified: [{ source: "pods", quote: "ERROR payment 42 timed out after 300ms" }],
              ruledOut: ["a bad deploy of the database"],
              open: ["provider status"],
              at: T0,
            },
          }),
          new SessionStatusNoted({ sessionId, status: "idle" }),
        ),
        Story.view(ThreadPage, thread, (v) => v?.handoff?.ruledOut[0] === "a bad deploy of the database"),
        Story.view(Inbox, INBOX, (v) => v === null || v.items.length === 0 || v.items[0]!.verdict === "real"),
        // A completed run is closed: a second finding is refused (a retried command keeps its receipt instead).
        Story.when(runRef, new CompleteRun({ sessionId, finding })),
        Story.rejected(new RunClosed()),
      ),
    );
  });
});

describe("routing a prompt (plan 6.3)", () => {
  const s = (sessionId: string, status: "pending" | "running" | "idle" | "failed") => ({ sessionId, mode: "investigate" as const, status });

  test("no session: a new one", () => {
    expect(routePrompt([], "investigate", "auto")).toEqual({ kind: "new", reason: "a new session" });
  });
  test("an idle session in the same mode is continued", () => {
    expect(routePrompt([s("a", "idle")], "investigate", "auto")).toMatchObject({ kind: "continue", sessionId: "a" });
  });
  test("a running session gets the prompt queued behind its turn, never steered", () => {
    expect(routePrompt([s("a", "running")], "investigate", "auto")).toMatchObject({ kind: "continue", sessionId: "a", delivery: "queue" });
  });
  test("several sessions: the most recent idle one", () => {
    expect(routePrompt([s("a", "idle"), s("b", "running"), s("c", "idle")], "investigate", "auto")).toMatchObject({ sessionId: "c" });
  });
  test("the last session failed: a new one with the handoff", () => {
    expect(routePrompt([s("a", "failed")], "investigate", "auto")).toMatchObject({ kind: "new" });
  });
  test("the owner's override wins", () => {
    expect(routePrompt([s("a", "idle")], "investigate", "new")).toMatchObject({ kind: "new" });
    expect(routePrompt([s("a", "running")], "investigate", "here")).toMatchObject({ kind: "continue", sessionId: "a" });
  });
});

void [RequestRun, AskThread];

describe("a run's transitions are strict", () => {
  const runRef = Run.ref(runIdOf(threadId, "s-1"));
  const sessionId = sessionIdOf(threadId, "s-1");
  const requested = new RunRequested({
    threadId,
    subject: id,
    promptId: "s-1",
    mode: "investigate",
    sessionId,
    messageId: messageIdOf(threadId, "s-1"),
    newSession: true,
    text: "why?",
    origin: "page",
    handoff: null,
    at: T0,
  });
  const sent = new RunSent({ threadId, sessionId, messageId: messageIdOf(threadId, "s-1"), at: T0 });

  test("a finding cannot complete a run that was never sent", () =>
    run(held(Story.given(runRef, requested), Story.when(runRef, new CompleteRun({ sessionId, finding })), Story.rejected(new RunNotSent()))));

  test("a finding cannot complete a run that failed, and a failed run cannot be sent again", () =>
    run(
      held(
        Story.given(runRef, requested, sent, new RunFailed({ threadId, sessionId, reason: "timed out", at: T0 })),
        Story.when(runRef, new CompleteRun({ sessionId, finding })),
        Story.rejected(new RunClosed()),
        Story.when(runRef, new MarkRunSent({})),
        Story.rejected(new RunClosed()),
      ),
    ));

  test("only the run's own session can complete it", () =>
    run(held(Story.given(runRef, requested, sent), Story.when(runRef, new CompleteRun({ sessionId: "ses_someone_else", finding })), Story.rejected(new WrongSession()))));
});
