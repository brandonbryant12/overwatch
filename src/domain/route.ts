/**
 * Same session or a new one (plan 6.3). A pure function of what code can see: the thread's sessions and their
 * state, the mode the owner picked, and the owner's override. It never reads the prompt's wording. The page runs the
 * same function to show the decision before sending; the Thread aggregate runs it again when the prompt arrives.
 */
import type { Mode, Override } from "./ids.ts";

export type SessionStatus = "pending" | "running" | "idle" | "failed";

export interface KnownSession {
  readonly sessionId: string;
  readonly mode: Mode;
  readonly status: SessionStatus;
}

export type Route =
  | { readonly kind: "new"; readonly reason: string }
  | { readonly kind: "continue"; readonly sessionId: string; readonly delivery: "queue"; readonly reason: string };

/**
 * Sessions are listed oldest first. A running or pending session gets the prompt queued behind its current turn;
 * interrupting mid-turn ("steer") is never chosen here.
 */
export function routePrompt(sessions: ReadonlyArray<KnownSession>, mode: Mode, override: Override): Route {
  if (override === "new") return { kind: "new", reason: "a new session, as asked" };
  const usable = sessions.filter((s) => s.mode === mode && s.status !== "failed");
  if (override === "here") {
    const latest = sessions.filter((s) => s.status !== "failed").at(-1);
    return latest
      ? { kind: "continue", sessionId: latest.sessionId, delivery: "queue", reason: "the latest session, as asked" }
      : { kind: "new", reason: "no session on this thread can take it, so a new one" };
  }
  if (usable.length === 0) {
    return {
      kind: "new",
      reason: sessions.some((s) => s.mode === mode) ? "the last session failed, so a new one with the handoff" : "a new session",
    };
  }
  const idle = usable.filter((s) => s.status === "idle").at(-1);
  if (idle) return { kind: "continue", sessionId: idle.sessionId, delivery: "queue", reason: "continues the idle session" };
  const latest = usable.at(-1)!;
  return { kind: "continue", sessionId: latest.sessionId, delivery: "queue", reason: "queued behind the session's current turn" };
}
