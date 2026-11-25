/**
 * The agent worker: drives every requested run into OpenCode and follows it to an outcome.
 *
 * - While OpenCode is not running, runs wait and the status says so.
 * - Sending is an outbox: the run's session and message ids were chosen when it was requested; its token is stored
 *   before the prompt carries it; session create and prompt are idempotent by id; only then is the run marked sent.
 *   A crash at any point repeats the same calls and finds the same session and message.
 * - A sent run is followed by reading the session's stored messages, never by waiting on the event stream. An idle
 *   marker after the run's prompt with no finding filed gets one follow-up prompt, then the run fails with the reason.
 *   An interruption because OpenCode shut down is not a failure: OpenCode resumes the turn when it restarts.
 * - A run is finished only when its finding was filed and its citations checked (`mcp.ts`).
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contextPack } from "../domain/brief.ts";
import { messageIdOf } from "../domain/ids.ts";
import type { IncidentPageState, PendingRun } from "../domain/views.ts";
import type { OpenCodePort } from "./opencode.ts";
import { recordShown } from "./tables.ts";

export const INVESTIGATOR_AGENT = "overwatch-investigator";

export interface WorkerPorts {
  readonly opencode: OpenCodePort;
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly pendingRuns: () => Promise<ReadonlyArray<PendingRun>>;
  readonly incidentPage: (id: string) => Promise<IncidentPageState | null>;
  readonly checkoutOf: (app: string) => string | undefined;
  readonly worktree: (threadId: string, checkout: string | undefined) => Promise<string>;
  readonly markSent: (runId: string) => Promise<void>;
  readonly nudge: (runId: string, messageId: string) => Promise<void>;
  readonly fail: (runId: string, reason: string) => Promise<void>;
  readonly now: () => number;
  readonly runTimeoutMs: number;
  readonly log: (message: string) => void;
}

export interface WorkerStatus {
  readonly opencode: string | undefined;
  readonly checkedAt: number;
  readonly waiting: number;
  readonly running: number;
}

/** The token a run's session passes to Overwatch's tools. Stored before the prompt that carries it is sent. */
function tokenFor(db: DatabaseSync, run: PendingRun, now: number): string {
  const known = db.prepare("SELECT token FROM run_tokens WHERE run_id = ?").get(run.runId) as { token: string } | undefined;
  if (known) return known.token;
  const token = `owt_${randomBytes(18).toString("base64url")}`;
  db.prepare("INSERT INTO run_tokens (token, run_id, session_id, thread_id, subject, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    token,
    run.runId,
    run.sessionId,
    run.threadId,
    run.subject,
    "investigator",
    now,
  );
  return token;
}

export function promptText(brief: string, token: string): string {
  return [
    brief,
    "",
    `Your Overwatch run token is ${token}. Pass it as "token" to the overwatch tools.`,
    "Read evidence with the overwatch query_telemetry tool and the code in your working directory. When you are done, file one finding with the overwatch file_finding tool. Quotes in the finding are checked against what you were shown here and by query_telemetry, and against the files.",
  ].join("\n");
}

export const NUDGE =
  "You have not filed a finding for this run yet. File it now with the overwatch file_finding tool, with your run token. If you found nothing, say so in the finding: unsure is a valid verdict.";

export function makeWorker(ports: WorkerPorts) {
  let status: WorkerStatus = { opencode: undefined, checkedAt: 0, waiting: 0, running: 0 };
  let busy = false;

  const dispatch = async (run: PendingRun) => {
    const page = await ports.incidentPage(run.subject);
    const directory = await ports.worktree(run.threadId, page ? ports.checkoutOf(page.app) : undefined);
    const brief = contextPack({ page, handoff: run.handoff, ask: run.text, origin: run.origin });
    const token = await ports.atomically((db) => {
      const t = tokenFor(db, run, ports.now());
      // What this session is shown is what its citations are checked against.
      recordShown(db, { sessionId: run.sessionId, threadId: run.threadId, runId: run.runId, source: "brief", text: brief, at: ports.now() });
      return t;
    });
    if (run.newSession) {
      await ports.opencode.createSession({
        id: run.sessionId,
        title: page ? `Overwatch: ${page.title}`.slice(0, 120) : "Overwatch investigation",
        agent: INVESTIGATOR_AGENT,
        directory,
        metadata: { overwatchThread: run.threadId, overwatchRun: run.runId },
      });
    }
    await ports.opencode.prompt({ sessionID: run.sessionId, id: run.messageId, text: promptText(brief, token), ...(run.delivery === "queue" ? { delivery: "queue" as const } : {}) });
    await ports.markSent(run.runId);
    ports.log(`run ${run.runId}: prompt ${run.messageId} sent to session ${run.sessionId}`);
  };

  const follow = async (run: PendingRun) => {
    const latest = run.nudges.at(-1) ?? run.messageId;
    const state = await ports.opencode.promptState(run.sessionId, latest);
    if (state.kind === "session-missing") {
      // OpenCode lost the session (its data was reset): send again, with the same ids.
      ports.log(`run ${run.runId}: session ${run.sessionId} is missing; sending again`);
      await dispatch(run);
      return;
    }
    if (state.kind === "waiting") {
      if (!state.inInbox) {
        // Accepted is not delivered: if OpenCode lost the prompt, the same id sends it once.
        const token = await ports.atomically((db) => tokenFor(db, run, ports.now()));
        const page = await ports.incidentPage(run.subject);
        const text = latest === run.messageId ? promptText(contextPack({ page, handoff: run.handoff, ask: run.text, origin: run.origin }), token) : NUDGE;
        await ports.opencode.prompt({ sessionID: run.sessionId, id: latest, text, delivery: "queue" });
      }
      return;
    }
    if (state.kind === "running") {
      if (ports.now() - run.at > ports.runTimeoutMs) {
        await ports.opencode.interrupt(run.sessionId).catch(() => undefined);
        await ports.fail(run.runId, `no finding within ${Math.round(ports.runTimeoutMs / 60_000)} minutes`);
      }
      return;
    }
    // Idle after the prompt and no finding filed (a filed finding completes the run, which leaves the pending list).
    if (state.outcome === "interrupted") return; // OpenCode resumes an interrupted turn when it restarts.
    if (run.nudges.length === 0) {
      const messageId = messageIdOf(run.threadId, run.promptId, 1);
      await ports.nudge(run.runId, messageId);
      await ports.opencode.prompt({ sessionID: run.sessionId, id: messageId, text: NUDGE, delivery: "queue" });
      ports.log(`run ${run.runId}: session went idle without a finding; asked once more`);
      return;
    }
    await ports.fail(run.runId, state.outcome === "failed" ? `the session failed: ${state.error ?? "no detail"}` : "the session finished twice without filing a finding");
  };

  const tick = async () => {
    if (busy) return status;
    busy = true;
    try {
      const url = await ports.opencode.connect();
      const runs = await ports.pendingRuns();
      status = {
        opencode: url,
        checkedAt: ports.now(),
        waiting: runs.filter((r) => r.status === "requested").length,
        running: runs.filter((r) => r.status === "sent").length,
      };
      if (!url) return status;
      for (const run of runs) {
        try {
          if (run.status === "requested") await dispatch(run);
          else if (run.status === "sent") await follow(run);
        } catch (error) {
          ports.log(`run ${run.runId}: ${(error as Error).message}`);
        }
      }
      return status;
    } finally {
      busy = false;
    }
  };

  return { tick, status: () => status };
}
