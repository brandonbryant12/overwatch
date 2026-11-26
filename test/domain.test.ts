/**
 * Stories: the model's behaviour on Alchemy's in-memory host. Every committed event, reply and rejection is
 * accounted for, and every order of concurrent policy work is replayed.
 */
import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AskThread,
  Defer,
  FailRun,
  IncidentCameBack,
  IncidentDeferred,
  IncidentDone,
  IncidentMuted,
  IncidentRestored,
  MarkDone,
  Mute,
  NoteChange,
  Restore,
  WakeDeferred,
  CompleteRun,
  handlers,
  HandoffRecorded,
  Incident,
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
  RecordFinding,
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

  const item = (v: { items: ReadonlyArray<{ incidentId: string }> } | null) => v?.items.find((i) => i.incidentId === id) as any;

  test("Done comes back if it happens again; what was in flight within one polling interval does not count", () =>
    run(
      held(
        Story.given(incident, opened),
        Story.when(incident, new MarkDone({})),
        Story.then(incident, new IncidentDone({ at: T0, actor: "owner", reason: null })),
        Story.view(Inbox, INBOX, (v) => item(v)?.disposition === "done"),
        Story.when(incident, new MarkDone({})),
        Story.then(incident),
        Story.when(incident, new ReportSignal({ ...signal, at: T0 + 60_000, count: 3 })),
        Story.then(incident, new SignalRecurred({ at: T0 + 60_000, count: 3, occurrences: 5, sample: signal.sample })),
        Story.view(Inbox, INBOX, (v) => item(v)?.disposition === "done"),
        Story.when(incident, new ReportSignal({ ...signal, firstAt: T0 + 15 * 60_000, at: T0 + 20 * 60_000, count: 3 })),
        Story.then(
          incident,
          new SignalRecurred({ at: T0 + 20 * 60_000, count: 3, occurrences: 8, sample: signal.sample }),
          new IncidentCameBack({ at: T0, cause: "again", reason: "Back: happened again 3 times since you marked it done." }),
        ),
        Story.view(Inbox, INBOX, (v) => item(v)?.disposition === "inbox" && item(v)?.returns.length === 1 && item(v)?.back?.startsWith("Back: happened again")),
      ),
    ));

  test("Later until it gets worse stays out at the same level and comes back at twice the rate with five more", () =>
    run(
      held(
        Story.given(incident, opened),
        Story.when(incident, new Defer({ waitsFor: "worse" })),
        Story.then(incident, new IncidentDeferred({ at: T0, actor: "owner", waitsFor: "worse", until: null, label: "until it gets worse", severity: "error", perDay: 2 })),
        Story.when(incident, new NoteChange({ cause: "deploy", at: T0, reason: "a deploy" })),
        Story.then(incident),
        Story.when(incident, new ReportSignal({ ...signal, at: T0 + 1_000, count: 1 })),
        Story.then(incident, new SignalRecurred({ at: T0 + 1_000, count: 1, occurrences: 3, sample: signal.sample })),
        Story.when(incident, new ReportSignal({ ...signal, at: T0 + 2_000, count: 4 })),
        Story.then(
          incident,
          new SignalRecurred({ at: T0 + 2_000, count: 4, occurrences: 7, sample: signal.sample }),
          new IncidentCameBack({ at: T0, cause: "worse", reason: "Back: 3x the rate it had when you said later (7 in the last day, 2 in the day before)." }),
        ),
      ),
    ));

  test("any Later comes back at once when the severity rises", () =>
    run(
      held(
        Story.given(incident, new IncidentOpened({ ...signal, severity: "warn", firstAt: signal.at })),
        Story.when(incident, new Defer({ until: T0 + 3_600_000, label: "1h", actor: "owner (page)" })),
        Story.then(incident, new IncidentDeferred({ at: T0, actor: "owner (page)", waitsFor: "time", until: T0 + 3_600_000, label: "1h", severity: "warn", perDay: 2 })),
        Story.when(incident, new ReportSignal({ ...signal, severity: "error", at: T0 + 1_000, count: 1 })),
        Story.then(
          incident,
          new SignalRecurred({ at: T0 + 1_000, count: 1, occurrences: 3, sample: signal.sample, severity: "error" }),
          new IncidentCameBack({ at: T0, cause: "severity", reason: "Back: now error; it was warn when you said later." }),
        ),
      ),
    ));

  test("Never hides more of the same and counts it; it breaks through at ten times the rate", () =>
    run(
      held(
        Story.given(incident, new IncidentOpened({ ...signal, severity: "warn", firstAt: signal.at })),
        Story.when(incident, new Mute({ reason: "noise" })),
        Story.then(incident, new IncidentMuted({ at: T0, actor: "owner", reason: "noise", severity: "warn", perDay: 2 })),
        Story.when(incident, new ReportSignal({ ...signal, severity: "warn", at: T0 + 1_000, count: 15 })),
        Story.then(incident, new SignalRecurred({ at: T0 + 1_000, count: 15, occurrences: 17, sample: signal.sample })),
        Story.view(Inbox, INBOX, (v) => item(v)?.disposition === "never" && item(v)?.hidden[0]?.count === 15),
        Story.when(incident, new ReportSignal({ ...signal, severity: "warn", at: T0 + 2_000, count: 5 })),
        Story.then(
          incident,
          new SignalRecurred({ at: T0 + 2_000, count: 5, occurrences: 22, sample: signal.sample }),
          new IncidentCameBack({ at: T0, cause: "worse", reason: "Back through Never: 11x the rate it had when you muted it (22 in the last day, 2 in the day before)." }),
        ),
      ),
    ));

  test("Never breaks through when the severity rises above what it was when muted", () =>
    run(
      held(
        Story.given(incident, new IncidentOpened({ ...signal, severity: "warn", firstAt: signal.at }), new IncidentMuted({ at: T0, actor: "owner", reason: null, severity: "warn", perDay: 2 })),
        Story.when(incident, new ReportSignal({ ...signal, severity: "error", at: T0 + 2_000, count: 1 })),
        Story.then(
          incident,
          new SignalRecurred({ at: T0 + 2_000, count: 1, occurrences: 3, sample: signal.sample, severity: "error" }),
          new IncidentCameBack({ at: T0, cause: "severity", reason: "Back through Never: now error, above the warn it was when you muted it." }),
        ),
      ),
    ));

  test("Later until something changes comes back on a deploy or a new finding, saying which", () =>
    run(
      held(
        Story.given(incident, opened),
        Story.when(incident, new Defer({})),
        Story.then(incident, new IncidentDeferred({ at: T0, actor: "owner", waitsFor: "change", until: null, label: "until something changes", severity: "error", perDay: 2 })),
        // One more of the same is not a change.
        Story.when(incident, new ReportSignal({ ...signal, at: T0 + 1_000, count: 1 })),
        Story.then(incident, new SignalRecurred({ at: T0 + 1_000, count: 1, occurrences: 3, sample: signal.sample })),
        // A deploy that happened before the deferral, however late it is told, does not wake it.
        Story.when(incident, new NoteChange({ cause: "deploy", at: T0 - 1, reason: "an older deploy" })),
        Story.then(incident),
        Story.when(incident, new NoteChange({ cause: "deploy", at: T0, reason: "Back: a deploy in production (now running abc)." })),
        Story.then(incident, new IncidentCameBack({ at: T0, cause: "deploy", reason: "Back: a deploy in production (now running abc)." })),
        Story.when(incident, new NoteChange({ cause: "deploy", at: T0, reason: "again" })),
        Story.then(incident),
        Story.when(incident, new Defer({})),
        Story.then(incident, new IncidentDeferred({ at: T0, actor: "owner", waitsFor: "change", until: null, label: "until something changes", severity: "error", perDay: 3 })),
        Story.when(incident, new RecordFinding({ runId: runIdOf(threadId, "p-9"), threadId, sessionId: "ses_x", finding })),
        Story.then(
          incident,
          new FindingRecorded({ runId: runIdOf(threadId, "p-9"), threadId, sessionId: "ses_x", finding, at: T0 }),
          new IncidentCameBack({ at: T0, cause: "finding", reason: "Back: a new finding arrived (real: Payment calls time out after 300ms.)." }),
        ),
      ),
    ));

  test("Later until a time is woken then; a wake for an earlier deferral does nothing", () =>
    run(
      held(
        Story.given(incident, opened, new IncidentDeferred({ at: T0 - 5_000, actor: "owner", waitsFor: "time", until: T0 + 3_600_000, label: "1h", severity: "error", perDay: 2 })),
        Story.when(incident, new WakeDeferred({ deferredAt: T0 - 9_000 })),
        Story.then(incident),
        Story.when(incident, new NoteChange({ cause: "deploy", at: T0, reason: "a deploy" })),
        Story.then(incident),
        Story.when(incident, new WakeDeferred({ deferredAt: T0 - 5_000 })),
        Story.then(incident, new IncidentCameBack({ at: T0, cause: "time", reason: "Back: you said later (1h)." })),
      ),
    ));

  test("every way out is undone by Restore, which records who did it", () =>
    run(
      held(
        Story.given(incident, opened, new IncidentMuted({ at: T0 - 1, actor: "owner", reason: null, severity: "error", perDay: 0 })),
        Story.when(incident, new Restore({ actor: "owner (page)" })),
        Story.then(incident, new IncidentRestored({ at: T0, actor: "owner (page)", undid: "never" })),
        Story.when(incident, new Restore({})),
        Story.then(incident),
      ),
    ));

  test("a way out on an incident that does not exist is refused", () =>
    run(held(Story.when(incident, new MarkDone({})), Story.rejected(new NotOpened()))));
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
              concluded: "real (1 of 1 quotes matched): Payment calls time out after 300ms.",
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

  test("agent work that fails is retried once in a fresh session; a failed retry is parked with its reason", () => {
    const retryRef = Run.ref(runIdOf(threadId, "s-1:retry"));
    const retrySession = sessionIdOf(threadId, "s-1:retry");
    const retryText = "The previous attempt failed (no finding within 20 minutes). Investigate this incident again, from the start.";
    return run(
      held(
        Story.given(thread, triage(true)),
        Story.given(runRef, requested, sent),
        Story.when(runRef, new FailRun({ reason: "no finding within 20 minutes" })),
        Story.then(runRef, new RunFailed({ threadId, sessionId, reason: "no finding within 20 minutes", at: T0, retryAs: "s-1:retry" })),
        Story.then(
          thread,
          new SessionStatusNoted({ sessionId, status: "failed" }),
          new PromptAsked({
            subject: id,
            title: id,
            promptId: "s-1:retry",
            text: retryText,
            mode: "investigate",
            origin: "system",
            runId: runIdOf(threadId, "s-1:retry"),
            sessionId: retrySession,
            messageId: messageIdOf(threadId, "s-1:retry"),
            newSession: true,
            reason: "a new session, as asked",
            held: false,
            handoff: null,
            at: T0,
          }),
        ),
        Story.then(
          retryRef,
          new RunRequested({
            threadId,
            subject: id,
            promptId: "s-1:retry",
            mode: "investigate",
            sessionId: retrySession,
            messageId: messageIdOf(threadId, "s-1:retry"),
            newSession: true,
            text: retryText,
            origin: "system",
            handoff: null,
            at: T0,
          }),
        ),
        Story.when(retryRef, new MarkRunSent({})),
        Story.then(retryRef, new RunSent({ threadId, sessionId: retrySession, messageId: messageIdOf(threadId, "s-1:retry"), at: T0 })),
        Story.then(thread, new SessionStatusNoted({ sessionId: retrySession, status: "running" })),
        Story.when(retryRef, new FailRun({ reason: "the session failed: provider error" })),
        // No retryAs: this was the retry. The thread notes the failure and asks nothing more.
        Story.then(retryRef, new RunFailed({ threadId, sessionId: retrySession, reason: "the session failed: provider error", at: T0 })),
        Story.then(thread, new SessionStatusNoted({ sessionId: retrySession, status: "failed" })),
        Story.view(Inbox, INBOX, (v) => v === null || v.items.length === 0 || v.items[0]!.failure === "the session failed: provider error"),
      ),
    );
  });

  test("only the run's own session can complete it", () =>
    run(held(Story.given(runRef, requested, sent), Story.when(runRef, new CompleteRun({ sessionId: "ses_someone_else", finding })), Story.rejected(new WrongSession()))));
});
