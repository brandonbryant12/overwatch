/**
 * When a source fails: what kind of failure, and when to try again. Pure.
 *
 * - Sign-in: confirmed at the next interval; a second refusal suspends until a five-minute probe or a wake.
 * - Everything else: the first failure waits one interval, the second two, then the third suspends with five-minute
 *   probes. A rate limit that asked for longer than Overwatch waits counts as an ordinary failure.
 * A permission failure on one reading (one kind of read refused) is not a source failure at all.
 */
import { LIMITS } from "./config.ts";

export type FailureKind = "signin" | "permission" | "rate" | "unreachable" | "config";

const SIGNIN = /\b(unauthori[sz]ed|401)\b|must be logged in|token (has )?expired|expired token|invalid_grant|re-?authenticat|credentials? (are|is|were) (invalid|expired)|api key is invalid/i;
const RATE = /\b429\b|rate.?limit|too many requests/i;
const PERMISSION = /\bforbidden\b|\b403\b|cannot (list|get|watch)|permission denied/i;
const UNREACHABLE = /timed? ?out|timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|connection refused|no such host|unable to connect|could not resolve|\b50[0-9]\b|gateway|service unavailable|unreachable|fetch failed|dial tcp/i;

/** What kind of failure a message describes. Anything unrecognised is treated as something that may pass. */
export function classify(message: string, status?: number): FailureKind {
  if (status !== undefined && status > 0) {
    if (status === 401 || status === 403) return "signin";
    if (status === 429) return "rate";
    if (status >= 500) return "unreachable";
    return "config";
  }
  if (RATE.test(message)) return "rate";
  if (SIGNIN.test(message)) return "signin";
  if (PERMISSION.test(message)) return "permission";
  if (UNREACHABLE.test(message)) return "unreachable";
  if (/not found|does not exist|invalid|unknown|bad request/i.test(message)) return "config";
  return "unreachable";
}

export interface Backoff {
  readonly streak: number;
  readonly suspended: boolean;
  /** Delay from now to the next attempt. */
  readonly delayMs: number;
}

/** The next attempt after a failure, given the previous streak. */
export function backoff(kind: FailureKind, previousStreak: number, everyMs: number): Backoff {
  const streak = previousStreak + 1;
  if (kind === "signin") return streak >= 2 ? { streak, suspended: true, delayMs: LIMITS.probeMs } : { streak, suspended: false, delayMs: everyMs };
  if (streak >= 3) return { streak, suspended: true, delayMs: LIMITS.probeMs };
  return { streak, suspended: false, delayMs: Math.min(LIMITS.probeMs, everyMs * 2 ** (streak - 1)) };
}

/** The exact thing to do about a failure. */
export function fixFor(kind: FailureKind, source: { kind: string; context?: string; namespace?: string; apiKey?: string; appKey?: string; id: string }): string {
  if (source.kind === "kubernetes") {
    const check = `kubectl --context ${source.context} -n ${source.namespace} get pods`;
    if (kind === "signin") return `Sign in to ${source.context} again (your cluster's login command), then check with: ${check}`;
    if (kind === "permission") return `Ask for read access in ${source.context}/${source.namespace}, then check with: ${check}`;
    if (kind === "config") return `Check the context, namespace and selector of ${source.id} in the configuration`;
    return `Check the network or VPN; Overwatch tries again by itself. Check with: ${check}`;
  }
  if (kind === "signin") return `Datadog refused the keys: set valid keys in ${source.apiKey} and ${source.appKey}`;
  if (kind === "rate") return "Nothing to do: Overwatch waits and tries again later";
  if (kind === "config") return `Check the query and baseUrl of ${source.id} in the configuration`;
  return "Check the network or VPN; Overwatch tries again by itself";
}
