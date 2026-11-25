/**
 * Reactions. Each runs at least once; the commands they send get deterministic ids from the platform, and every
 * target command is idempotent, so a redelivery changes nothing.
 */
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { threadIdOf } from "./ids.ts";
import { Incident, IncidentOpened, RecordFinding } from "./incident.ts";
import { RequestRun, Run, RunCompleted, RunFailed, RunSent } from "./run.ts";
import { AskThread, NoteSession, PromptAsked, RecordHandoff, Thread } from "./thread.ts";

/** A new incident gets one triage intent: a prompt on its thread, asked by Overwatch. */
export class Triage extends Domain.Policy("Triage", { from: Incident, on: [IncidentOpened] }) {}

export interface TriageOptions {
  /** Start an investigation for every new incident. Off, the intent is recorded and waits for the owner. */
  readonly autoInvestigate: boolean;
}

export const triageLive = (options: TriageOptions) =>
  Triage.toLayer(
    Effect.gen(function* () {
      const threads = yield* Thread;
      return Effect.fn(function* ({ source, event }) {
        yield* threads
          .send(
            Thread.ref(threadIdOf(source.id)),
            new AskThread({
              subject: source.id,
              title: event.title,
              promptId: "triage",
              text: "Investigate this incident.",
              mode: "investigate",
              origin: "system",
              override: "auto",
              hold: !options.autoInvestigate,
            }),
          )
          .pipe(Effect.catchTag("ThreadClosed", () => Effect.void));
      });
    }),
  );

/** A prompt that is not held becomes a run. The service builds its context pack from the log when it sends it. */
export class Dispatch extends Domain.Policy("Dispatch", { from: Thread, on: [PromptAsked] }) {}

export const DispatchLive = Dispatch.toLayer(
  Effect.gen(function* () {
    const runs = yield* Run;
    return Effect.fn(function* ({ source, event }) {
      if (event.held) return;
      yield* runs.send(
        Run.ref(event.runId),
        new RequestRun({
          threadId: source.id,
          subject: event.subject,
          promptId: event.promptId,
          mode: event.mode,
          sessionId: event.sessionId,
          messageId: event.messageId,
          newSession: event.newSession,
          ...(event.delivery === undefined ? {} : { delivery: event.delivery }),
          text: event.text,
          origin: event.origin,
          handoff: event.handoff,
        }),
      );
    });
  }),
);

/** A run's progress and outcome reach its thread and its incident. */
export class Outcome extends Domain.Policy("Outcome", { from: Run, on: [RunSent, RunCompleted, RunFailed] }) {}

export const OutcomeLive = Outcome.toLayer(
  Effect.gen(function* () {
    const threads = yield* Thread;
    const incidents = yield* Incident;
    return Effect.fn(function* ({ source, event }) {
      const thread = Thread.ref(event.threadId);
      switch (event._tag) {
        case "RunSent":
          yield* threads.send(thread, new NoteSession({ sessionId: event.sessionId, status: "running" }));
          return;
        case "RunFailed":
          yield* threads.send(thread, new NoteSession({ sessionId: event.sessionId, status: "failed" }));
          return;
        case "RunCompleted": {
          const e = event.finding.engineering;
          yield* incidents
            .send(Incident.ref(event.subject), new RecordFinding({ runId: source.id, threadId: event.threadId, sessionId: event.sessionId, finding: event.finding }))
            .pipe(Effect.catchTag("NotOpened", () => Effect.void));
          yield* threads.send(
            thread,
            new RecordHandoff({
              handoff: {
                runId: source.id,
                sessionId: event.sessionId,
                concluded: `${e.verdict} (${e.confidence} confidence): ${e.cause}`,
                verified: e.evidence.filter((x) => x.verified).map((x) => ({ source: x.source, quote: x.quote })),
                ruledOut: event.finding.ruledOut,
                open: e.notChecked,
                at: event.at,
              },
            }),
          );
          yield* threads.send(thread, new NoteSession({ sessionId: event.sessionId, status: "idle" }));
          return;
        }
      }
    });
  }),
);
