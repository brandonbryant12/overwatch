/** The agent worker against a fake OpenCode: the outbox, following a run, and when it gives up. */
import { DatabaseSync } from "node:sqlite";
import { messageIdOf, RunId, ThreadId, IncidentId } from "../src/domain/ids.ts";
import type { PendingRun } from "../src/domain/views.ts";
import type { OpenCodePort, PromptState } from "../src/service/opencode.ts";
import { createServiceTables } from "../src/service/tables.ts";
import { makeWorker, NUDGE, RESUME } from "../src/service/worker.ts";
import { describe, expect, test } from "./harness.ts";

const thread = ThreadId.make("thr_x");
const run: PendingRun = {
  runId: RunId.make("run_x"),
  threadId: thread,
  subject: IncidentId.make("inc_x"),
  promptId: "p-1",
  mode: "investigate",
  sessionId: "ses_owx",
  messageId: messageIdOf(thread, "p-1"),
  newSession: true,
  delivery: null,
  text: "why?",
  origin: "page",
  handoff: null,
  status: "requested",
  nudges: [],
  at: 0,
  sentAt: null,
};

function harness() {
  const db = new DatabaseSync(":memory:");
  createServiceTables(db);
  const calls: string[] = [];
  let state: PromptState = { kind: "running" };
  let failPrompt = 0;
  let status = "requested";
  let pending: PendingRun = run;
  let now = 1_000;
  const opencode: OpenCodePort = {
    connect: async () => "http://opencode.test",
    createSession: async (i) => void calls.push(`create ${i.id} ${i.agent}`),
    prompt: async (i) => {
      if (failPrompt-- > 0) throw new Error("connection reset");
      calls.push(`prompt ${i.id}${i.text === NUDGE ? " nudge" : i.text === RESUME ? " resume" : ""}`);
    },
    synthetic: async (i) => void calls.push(`synthetic ${i.id}`),
    userMessages: async () => [],
    promptState: async () => state,
    interrupt: async () => void calls.push("interrupt"),
    answer: async () => undefined,
  };
  const worker = makeWorker({
    opencode,
    atomically: async (work) => work(db),
    pendingRuns: async () => [pending],
    incidentPage: async () => null,
    checkoutOf: () => undefined,
    worktree: async () => "/tmp/worktree",
    runStatus: async () => status,
    markSent: async () => {
      calls.push("sent");
      status = "sent";
      pending = { ...pending, status: "sent", sentAt: now };
    },
    adopt: async () => undefined,
    nudge: async (_, id) => void (pending = { ...pending, nudges: [...pending.nudges, id] }),
    fail: async (_, reason) => {
      calls.push(`fail: ${reason}`);
      status = "failed";
    },
    now: () => now,
    runTimeoutMs: 60_000,
    log: () => undefined,
  });
  return { worker, calls, db, set: (s: PromptState) => (state = s), failPromptOnce: () => (failPrompt = 1), advance: (ms: number) => (now += ms) };
}

describe("the worker", () => {
  test("a prompt that fails in transit is sent again with the same ids, and the token is stored before it", async () => {
    const h = harness();
    h.failPromptOnce();
    await h.worker.tick();
    const token = (h.db.prepare("SELECT token FROM run_tokens WHERE run_id = 'run_x'").get() as { token: string }).token;
    await h.worker.tick();
    expect(h.calls).toEqual(["create ses_owx overwatch-investigator", "create ses_owx overwatch-investigator", `prompt ${run.messageId}`, "sent"]);
    expect((h.db.prepare("SELECT token FROM run_tokens WHERE run_id = 'run_x'").get() as { token: string }).token).toBe(token);
    expect(h.db.prepare("SELECT source FROM shown WHERE session_id = 'ses_owx'").all().map((r) => r.source)).toEqual(["brief:question"]);
  });

  test("idle without a finding: asked once more, then the run fails with the reason", async () => {
    const h = harness();
    await h.worker.tick();
    h.set({ kind: "idle", outcome: "succeeded" });
    await h.worker.tick();
    await h.worker.tick();
    expect(h.calls.slice(-2)).toEqual([`prompt ${messageIdOf(thread, "p-1", 1)} nudge`, "fail: the session finished twice without filing a finding"]);
  });

  test("an interrupted turn is left to OpenCode; one that was not resumed is asked to continue after a grace period", async () => {
    const h = harness();
    await h.worker.tick();
    h.set({ kind: "idle", outcome: "interrupted" });
    await h.worker.tick();
    expect(h.calls.at(-1)).toBe("sent");
    h.set({ kind: "stalled" });
    await h.worker.tick();
    expect(h.calls.at(-1)).toBe("sent");
    h.advance(20_000);
    await h.worker.tick();
    expect(h.calls.at(-1)).toBe(`prompt ${messageIdOf(thread, "p-1", 1)} resume`);
  });

  test("a run past its time limit is interrupted and fails", async () => {
    const h = harness();
    await h.worker.tick();
    h.advance(120_000);
    await h.worker.tick();
    expect(h.calls.slice(-2)).toEqual(["interrupt", "fail: no finding within 1 minutes"]);
  });

});
