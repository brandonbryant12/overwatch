/**
 * When something keeps failing (plan 4.1). A failed collection is classified by code, and the kind decides what
 * happens next: Overwatch does not hammer a thing that is broken, and it tells the owner once, with the command that
 * fixes it.
 *
 * - `signin`: the connection's sign-in or key was refused. One confirming attempt, then suspended: repeated bad
 *   sign-ins can lock an account.
 * - `permission`: the account may not do this read. Suspended (only this connection), since it will not pass alone.
 * - `config`: the source is configured wrongly (an unknown namespace or context, a query the API rejects).
 *   Suspended until its configuration changes.
 * - `rate_limit`: waits as long as asked, else a growing wait; never suspended.
 * - `unreachable`: timeouts, refused connections, gateway errors, the VPN down. A growing wait up to a ceiling, then
 *   suspended after a number of failures in a row.
 *
 * A suspended connection is probed at the ceiling's pace with one ordinary collection; it resumes by itself when that
 * works. Waking from sleep or a network change probes at once.
 */
import type { SourceConfig } from "./options.ts";

export type FailureKind = "signin" | "permission" | "config" | "rate_limit" | "unreachable";

export interface Classified {
  readonly kind: FailureKind;
  /** Rate limits: how long the response asked to wait, when it said. */
  readonly retryAfterMs?: number;
}

const SIGNIN = /\b(unauthori[sz]ed|401)\b|must be logged in|token (has )?expired|expired token|invalid_grant|re-?authenticat|login required|credentials? (are|is|were) (invalid|expired)|no valid credential|api key is invalid|invalid api key|forbidden.*\b(api|app(lication)?)[ _-]?key/i;
const RATE = /\b429\b|rate.?limit|too many requests/i;
const PERMISSION = /\bforbidden\b|\b403\b|cannot (list|get|watch)|permission denied|not authori[sz]ed to/i;
const UNREACHABLE = /timed? ?out|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|connection refused|no such host|unable to connect|could not resolve|\b50[234]\b|bad gateway|gateway|service unavailable|socket hang up|network is unreachable|fetch failed|i\/o timeout|dial tcp/i;
const CONFIG = /not found|NotFound|does not exist|no context|unknown (flag|source|context|namespace)|invalid (query|selector|label)|\b400\b|bad request|unprocessable|\b422\b/i;

/** What kind of failure an error is. Anything not recognised may pass by itself, like an unreachable host. */
export function classifyFailure(message: string): Classified {
  if (RATE.test(message)) {
    const seconds = /retry[- ]after[^0-9]{0,4}(\d+)/i.exec(message)?.[1];
    return { kind: "rate_limit", ...(seconds ? { retryAfterMs: Number(seconds) * 1000 } : {}) };
  }
  if (SIGNIN.test(message)) return { kind: "signin" };
  if (PERMISSION.test(message)) return { kind: "permission" };
  if (UNREACHABLE.test(message)) return { kind: "unreachable" };
  if (CONFIG.test(message)) return { kind: "config" };
  return { kind: "unreachable" };
}

/** What a connection is: a kubectl context, a Datadog site, or the source itself. A sign-in failure is per connection. */
export function connectionOf(source: SourceConfig, where: { readonly watcher: string; readonly source: string; readonly datadogSite?: string }): string {
  const s = source as SourceConfig & { context?: unknown };
  if (source.type === "kubernetes" && typeof s.context === "string") return `kubernetes:${s.context}`;
  if (source.type.startsWith("datadog")) return `datadog:${where.datadogSite ?? "datadoghq.com"}`;
  return `${source.type}:${where.watcher}/${where.source}`;
}

export interface Limits {
  readonly backoffMs: number;
  readonly ceilingMs: number;
  readonly attempts: number;
}

export interface ConnectionState {
  readonly kind: FailureKind;
  readonly streak: number;
  readonly nextAt: number;
  readonly suspendedAt: number | null;
}

/** After a failure: the next attempt and whether the connection is now suspended. Pure. */
export function afterFailure(previous: ConnectionState | undefined, failure: Classified, now: number, limits: Limits): ConnectionState {
  const streak = (previous?.kind === failure.kind ? previous.streak : 0) + 1;
  const growing = Math.min(limits.ceilingMs, limits.backoffMs * 2 ** (streak - 1));
  const alreadySuspended = previous?.suspendedAt ?? null;
  const suspend = (): ConnectionState => ({ kind: failure.kind, streak, nextAt: now + limits.ceilingMs, suspendedAt: alreadySuspended ?? now });
  switch (failure.kind) {
    case "signin":
      // One confirming attempt at the next poll; a second refusal suspends.
      return streak >= 2 ? suspend() : { kind: failure.kind, streak, nextAt: now, suspendedAt: alreadySuspended };
    case "permission":
    case "config":
      return suspend();
    case "rate_limit":
      return { kind: failure.kind, streak, nextAt: now + Math.min(limits.ceilingMs, failure.retryAfterMs ?? growing), suspendedAt: alreadySuspended };
    case "unreachable":
      return streak >= limits.attempts ? suspend() : { kind: failure.kind, streak, nextAt: now + growing, suspendedAt: alreadySuspended };
  }
}

const WHAT: Record<FailureKind, string> = {
  signin: "signed out",
  permission: "not allowed",
  config: "configured wrongly",
  rate_limit: "rate limited",
  unreachable: "unreachable",
};
export const failureWords = (kind: FailureKind) => WHAT[kind];

/** The exact thing to do about a failure, for the one inbox item it raises. */
export function fixFor(kind: FailureKind, source: SourceConfig, where: { readonly app: string; readonly environment: string; readonly source: string; readonly datadogKey?: string }): string {
  const s = source as SourceConfig & { context?: string; namespace?: string };
  const check = source.type === "kubernetes" && s.context ? `kubectl --context ${s.context}${s.namespace ? ` -n ${s.namespace}` : ""} get pods` : "bin/overwatch status";
  const path = `apps.${where.app}.environments.${where.environment}.sources.${where.source}`;
  switch (kind) {
    case "signin":
      if (source.type === "kubernetes") return `Sign in to ${s.context} again in a terminal (your cluster's login command), then check with: ${check}`;
      if (source.type.startsWith("datadog")) {
        const ref = where.datadogKey ?? "";
        const keychain = /^keychain:([^/]+)\/(.+)$/.exec(ref);
        return keychain
          ? `Datadog refused the key. Store a valid one: security add-generic-password -U -s ${keychain[1]} -a ${keychain[2]} -w`
          : `Datadog refused the key. Set a valid key in ${ref.replace(/^env:/, "the environment variable ") || "datadog.apiKey"} and restart the service.`;
      }
      return `Sign in again for ${path}, then check with: bin/overwatch status`;
    case "permission":
      return `The account may not read this. Ask for read access, or remove ${path}; check with: ${check}`;
    case "config":
      return `Fix ${path} in your config, then run: bin/overwatch check`;
    case "rate_limit":
      return "Nothing to do: Overwatch waits as asked and polls this source less often.";
    case "unreachable":
      return `Check the network or VPN; Overwatch tries again by itself. Check with: ${check}`;
  }
}
