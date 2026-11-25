/**
 * Request guard for the local daemon.
 *
 * The daemon acts with the operator's authority: its intents can approve a pull request, answer an
 * agent's permission prompt, or start a run. A browser will happily send requests to 127.0.0.1 on
 * behalf of any page the operator has open, so "bound to loopback" is not an access control.
 * Two checks close that hole without adding a login step:
 *
 * 1. Host allowlist. A DNS-rebinding page reaches the daemon under its own hostname, which is
 *    never on the list.
 * 2. Same-origin writes. A state-changing request that carries an `Origin` must carry this
 *    daemon's own origin. Native clients (the desktop app, curl, tests) send no `Origin` and pass.
 *
 * No `Access-Control-Allow-Origin` header is ever sent, so other origins cannot read responses.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface RequestGuardOptions {
  readonly port: number;
  /** Extra hostnames the operator serves the daemon under (for example a tailnet name). */
  readonly allowedHosts?: ReadonlyArray<string>;
}

export type GuardVerdict = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly reason: string };

function splitHostHeader(host: string): { hostname: string; port: string | undefined } {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const rest = trimmed.slice(end + 1);
    return { hostname: trimmed.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : undefined };
  }
  const idx = trimmed.lastIndexOf(":");
  return idx === -1
    ? { hostname: trimmed, port: undefined }
    : { hostname: trimmed.slice(0, idx), port: trimmed.slice(idx + 1) };
}

export function makeRequestGuard(options: RequestGuardOptions) {
  const allowedHostnames = new Set([
    ...LOOPBACK_HOSTNAMES,
    ...(options.allowedHosts ?? []).map((h) => h.toLowerCase()),
  ]);
  const port = String(options.port);

  const hostAllowed = (hostHeader: string | null): boolean => {
    if (!hostHeader) return false;
    const { hostname, port: hostPort } = splitHostHeader(hostHeader);
    if (!allowedHostnames.has(hostname)) return false;
    // A missing port means the default for the scheme, which only matches when serving on 80.
    return (hostPort ?? "80") === port;
  };

  const originAllowed = (origin: string): boolean => {
    try {
      const url = new URL(origin);
      if (url.protocol !== "http:") return false;
      return hostAllowed(url.host);
    } catch {
      return false;
    }
  };

  return (req: Request): GuardVerdict => {
    if (!hostAllowed(req.headers.get("host"))) {
      return { ok: false, status: 421, reason: "Host is not served by this daemon" };
    }

    const origin = req.headers.get("origin");
    const isRead = req.method === "GET" || req.method === "HEAD";

    if (origin !== null && !originAllowed(origin)) {
      return { ok: false, status: 403, reason: "Cross-origin requests are not allowed" };
    }
    if (!isRead) {
      // Browsers attach Sec-Fetch-Site to every request. A cross-site form post has no CORS
      // preflight and may omit Origin in old engines, so check this header as well.
      const fetchSite = req.headers.get("sec-fetch-site");
      if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
        return { ok: false, status: 403, reason: "Cross-site requests are not allowed" };
      }
      if (req.method !== "POST") {
        return { ok: false, status: 405, reason: "Method not allowed" };
      }
      const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return { ok: false, status: 415, reason: "Intents must be sent as application/json" };
      }
    }
    return { ok: true };
  };
}

/** Resolves a request path inside `root`, or undefined if it would escape it. */
export function resolveStaticPath(root: string, pathname: string, sep = "/"): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const segments: string[] = [];
  for (const segment of decoded.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return segments.length === 0 ? `${normalizedRoot}${sep}index.html` : `${normalizedRoot}${sep}${segments.join(sep)}`;
}
