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
import { contextPack, contextParts, shownLabel } from "../domain/brief.ts";
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
  /** The run's state on its aggregate, which the pending-runs view may lag. */
  readonly runStatus: (runId: string) => Promise<string | undefined>;
  readonly markSent: (runId: string) => Promise<void>;
  /** Record a prompt the owner typed in an Overwatch session in OpenCode on that session's thread. */
  readonly adopt: (input: { readonly threadId: string; readonly subject: string; readonly sessionId: string; readonly messageId: string; readonly text: string }) => Promise<void>;
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

export const RESUME =
  "OpenCode restarted while you were working, and your turn was not resumed. Continue from where you left off without repeating completed work, and file your finding with the overwatch file_finding tool and your run token.";

/** How long a delivered prompt may be neither running nor finished before it is nudged. */
const STALL_MS = 15_000;

export function makeWorker(ports: WorkerPorts) {
  let status: WorkerStatus = { opencode: undefined, checkedAt: 0, waiting: 0, running: 0 };
  let busy = false;
  const stalledSince = new Map<string, number>();

  const dispatch = async (run: PendingRun) => {
    const page = await ports.incidentPage(run.subject);
    if (!page) ports.log(`run ${run.runId}: incident ${run.subject} has no page yet; sending without its context`);
    const directory = await ports.worktree(run.threadId, page ? ports.checkoutOf(page.app) : undefined);
    const briefInput = { page, handoff: run.handoff, ask: run.text, origin: run.origin };
    const brief = contextPack(briefInput);
    const token = await ports.atomically((db) => {
      const t = tokenFor(db, run, ports.now());
      // What this session is shown is what its citations are checked against.
      for (const part of contextParts(briefInput)) {
        if (part.text.trim()) recordShown(db, { sessionId: run.sessionId, threadId: run.threadId, runId: run.runId, source: shownLabel(part), text: part.text, at: ports.now() });
      }
      return t;
    });
    if (run.origin === "opencode") {
      // The owner typed the question in this session; it is already there. The session gets this run's token.
      await ports.opencode.synthetic({
        sessionID: run.sessionId,
        id: run.messageId,
        text: `Overwatch recorded the owner's question on thread ${run.threadId}: "${run.text.slice(0, 300)}"\n\n${promptText("", token).trim()}`,
        delivery: "queue",
      });
      await ports.markSent(run.runId);
      ports.log(`run ${run.runId}: token for the owner's question sent to session ${run.sessionId}`);
      return;
    }
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
    if (state.kind === "stalled") {
      // A managed OpenCode server resumes interrupted turns when it boots; one that does not leaves them here.
      const since = stalledSince.get(run.runId) ?? ports.now();
      stalledSince.set(run.runId, since);
      if (ports.now() - since < STALL_MS) return;
      stalledSince.delete(run.runId);
      if (run.nudges.length > 0) {
        await ports.fail(run.runId, "the session stopped twice without filing a finding");
        return;
      }
      const messageId = messageIdOf(run.threadId, run.promptId, 1);
      await ports.nudge(run.runId, messageId);
      await ports.opencode.prompt({ sessionID: run.sessionId, id: messageId, text: RESUME, delivery: "queue" });
      ports.log(`run ${run.runId}: the turn was interrupted and not resumed; asked the session to continue`);
      return;
    }
    stalledSince.delete(run.runId);
    if (state.kind === "running") {
      // Counted from when the prompt was sent: time spent waiting for OpenCode to open is not the run's.
      if (run.sentAt !== null && ports.now() - run.sentAt > ports.runTimeoutMs) {
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

  /**
   * Prompts the owner typed in OpenCode, in a session Overwatch started, land on that session's thread. Overwatch's
   * own messages have ids it chose (`msg_ow…`); anything else in the session is the owner's.
   */
  const adoptTyped = async () => {
    const sessions = await ports.atomically(
      (db) => db.prepare("SELECT session_id, thread_id, subject FROM run_tokens GROUP BY session_id").all() as Array<{ session_id: string; thread_id: string; subject: string }>,
    );
    for (const s of sessions) {
      const messages = await ports.opencode.userMessages(s.session_id).catch(() => []);
      for (const m of messages) {
        if (m.id.startsWith("msg_ow")) continue;
        await ports.adopt({ threadId: s.thread_id, subject: s.subject, sessionId: s.session_id, messageId: m.id, text: m.text });
      }
    }
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
      await adoptTyped().catch((error) => ports.log(`reading sessions for the owner's prompts: ${(error as Error).message}`));
      for (const run of runs) {
        try {
          // The view lists the work; the aggregate decides what state it is in.
          const current = await ports.runStatus(run.runId);
          if (current === "requested") await dispatch(run);
          else if (current === "sent") await follow(run);
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
