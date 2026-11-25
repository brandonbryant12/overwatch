/**
 * Identifiers and small shared values. Pure: this package imports only `@alchemy.run/domain` and `effect`, so the
 * same model runs in the service, in tests and in the browser.
 */
import * as Schema from "effect/Schema";

/** Ids Overwatch derives (`inc_<hash>`, `thr_inc_<hash>`, `run_<hash>`): anything else from outside is refused. */
const derived = (prefix: string, what: string) =>
  Schema.String.check(Schema.makeFilter((value: string) => (new RegExp(`^${prefix}_[${prefix === "ses" ? "A-Za-z" : "a-z"}0-9_-]{1,80}$`).test(value) ? undefined : `${what} must look like ${prefix}_<letters and digits>`)));

export const IncidentId = derived("inc", "an incident id").pipe(Schema.brand("IncidentId"));
export type IncidentId = typeof IncidentId.Type;
export const ThreadId = derived("thr", "a thread id").pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;
/** A session id Overwatch chose (`ses_ow…`) or recorded from OpenCode for one of its own runs. */
export const SessionId = derived("ses", "a session id");
export const RunId = derived("run", "a run id").pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;
export const WatcherId = Schema.String.pipe(Schema.brand("WatcherId"));
export type WatcherId = typeof WatcherId.Type;

export const Severity = Schema.Literals(["info", "warn", "error"]);
export type Severity = typeof Severity.Type;

/** What a prompt asks for. Each mode has its own agent and permissions; phase 1A has only `investigate`. */
export const Mode = Schema.Literals(["investigate"]);
export type Mode = typeof Mode.Type;

/** Who asked: the owner on the page, the owner in OpenCode, or Overwatch itself (a new incident's triage). */
export const Origin = Schema.Literals(["page", "opencode", "system"]);
export type Origin = typeof Origin.Type;

/** The owner's override of session routing: let Overwatch decide, always a new session, or the latest one. */
export const Override = Schema.Literals(["auto", "new", "here"]);
export type Override = typeof Override.Type;

/** A stable short hash (FNV-1a, 32 bit, base 36). Pure and browser-safe; used to derive deterministic ids. */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** The incident one breach belongs to: one per app, environment and fingerprint, so overlapping polls agree. */
export const incidentIdOf = (app: string, environment: string, fingerprint: string): IncidentId =>
  IncidentId.make(`inc_${stableHash(`${app}/${environment}`)}${stableHash(fingerprint)}`);

/** Phase 1A keeps one thread per incident. */
export const threadIdOf = (incident: IncidentId): ThreadId => ThreadId.make(`thr_${incident}`);

/** Ids chosen by Overwatch before anything is sent to OpenCode, so a retry finds the same session and message. */
export const runIdOf = (thread: ThreadId, promptId: string): RunId => RunId.make(`run_${stableHash(thread)}${stableHash(promptId)}`);
export const sessionIdOf = (thread: ThreadId, promptId: string) => `ses_ow${stableHash(thread)}${stableHash(`session:${promptId}`)}`;
export const messageIdOf = (thread: ThreadId, promptId: string, attempt = 0) =>
  `msg_ow${stableHash(thread)}${stableHash(`prompt:${promptId}:${attempt}`)}`;
