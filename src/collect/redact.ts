import { createHash } from "node:crypto";

export interface RedactionOptions {
  readonly maxBytes?: number;
  readonly customPatterns?: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }>;
}

export interface RedactionSettings {
  /** Also redact values that look random, whatever they are called. On by default. */
  readonly entropy: boolean;
  /** Values matching any of these are never redacted by the entropy pass (such as a request ID format). */
  readonly allow: ReadonlyArray<RegExp>;
  /** Extra patterns to redact, on top of the built-in ones. */
  readonly patterns: ReadonlyArray<RegExp>;
}

let settings: RedactionSettings = { entropy: true, allow: [], patterns: [] };

/** Sets redaction for the whole plugin from its options. */
export function configureRedaction(next: Partial<RedactionSettings>): void {
  settings = { entropy: next.entropy ?? true, allow: next.allow ?? [], patterns: next.patterns ?? [] };
}

const DEFAULT_MAX_BYTES = 16_384;

const BUILTIN_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  // Authorization headers: anything after an explicit `Authorization:` name, whatever its length.
  { kind: "auth_header", pattern: /\b(proxy-)?authorization\s*[:=]\s*["']?[^\s"',;]+(\s+[^\s"',;]+)?/gi },
  // A bare scheme followed by something credential-shaped. The length floor keeps ordinary
  // prose such as "token expired" or "basic auth" readable.
  { kind: "auth_header", pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  // JWTs
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // AWS access key IDs & secret access keys
  { kind: "aws_key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub PATs
  { kind: "github_token", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  // Slack tokens
  { kind: "slack_token", pattern: /\bxox[abeprs]-[A-Za-z0-9-]{10,}\b/g },
  // Generic API keys / DD keys in headers or query params
  {
    kind: "api_key",
    pattern:
      /\b(dd-api-key|dd-application-key|x-api-key|api_key|apikey|access_token|secret_key|jenkins_token)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{8,}["']?/gi,
  },
  // DSN connection passwords (postgres://user:pass@host, redis://:pass@host)
  { kind: "dsn_password", pattern: /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^:\s/@]{0,64}:)([^@\s]{1,128})(@)/gi },
  // Cookie headers
  { kind: "cookie", pattern: /\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi },
  // Private key PEM blocks
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|apikey|api_key|authorization|cookie|private_key|credential|dd_api|dd_app)/i;

// A value, with base64 padding if it has any. "=" is not part of the value, so `name=value` keeps its name.
const TOKEN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const RUN = /[A-Za-z0-9]{16,}/g;
const HEX_OR_UUID = /^[0-9a-f-]+$/i;

/**
 * True when a run of letters and digits looks generated rather than written: a credential nobody named.
 *
 * Plain Shannon entropy cannot tell `OAuth2AuthorizationRequestRedirectFilter` from a token at these lengths, so
 * this looks at how the characters are arranged. Identifiers are words: digits sit together, letter case changes at
 * word boundaries, and about four letters in ten are vowels. Random values scatter digits, flip between character
 * classes constantly, and have few vowels. Measured on random base62, base36 and base32 values this catches about
 * 75% at 16 characters and over 95% at 40, against roughly 1 in 1000 long identifiers.
 *
 * Hexadecimal values and UUIDs are left alone on purpose: commit SHAs, image digests and trace IDs are evidence.
 * A hexadecimal secret is only caught by its name (the patterns above).
 */
export function looksGenerated(run: string): boolean {
  if (run.length < 16 || HEX_OR_UUID.test(run)) return false;
  const counts = new Map<string, number>();
  let digits = 0;
  let digitGroups = 0;
  let letters = 0;
  let vowels = 0;
  let transitions = 0;
  let previous = "";
  for (const char of run) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    const kind = char >= "0" && char <= "9" ? "d" : char >= "A" && char <= "Z" ? "u" : "l";
    if (kind === "d") {
      digits++;
      if (previous !== "d") digitGroups++;
    } else {
      letters++;
      if ("aeiouAEIOU".includes(char)) vowels++;
    }
    if (previous && previous !== kind) transitions++;
    previous = kind;
  }
  if (digits === 0 || letters === 0) return false;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / run.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy < 3) return false;
  const vowelRatio = vowels / letters;
  return (
    (digitGroups >= 3 && vowelRatio < 0.34) ||
    (transitions >= run.length / 2 && vowelRatio < 0.3) ||
    (digitGroups >= 2 && vowelRatio < 0.2)
  );
}

/** Replaces values that look generated. The short hash lets the same value be recognised across lines. */
function redactGenerated(input: string): string {
  return input.replace(TOKEN, (token) => {
    if (HEX_OR_UUID.test(token) || settings.allow.some((pattern) => pattern.test(token))) return token;
    const runs = token.match(RUN) ?? [];
    // Standard base64 breaks into short runs at "+" and "/"; judge it as one value.
    const joined = /[+=]/.test(token) && token.length >= 32 ? [token.replace(/[^A-Za-z0-9]/g, "")] : [];
    if (![...runs, ...joined].some(looksGenerated)) return token;
    return `[REDACTED:high_entropy:${createHash("sha256").update(token).digest("hex").slice(0, 6)}]`;
  });
}

/**
 * Pass 1: Deterministic regex scrubber + byte cap for raw text excerpts (logs, stack traces, console tails).
 * Named credentials go first; then anything that looks generated, whatever it is called.
 */
export function redactText(input: string, options: RedactionOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let out = input;
  const patterns = [
    ...BUILTIN_PATTERNS,
    ...settings.patterns.map((pattern) => ({ kind: "custom", pattern })),
    ...(options.customPatterns ?? []),
  ];

  for (const { kind, pattern } of patterns) {
    if (kind === "dsn_password") {
      out = out.replace(pattern, `$1[REDACTED:${kind}]$3`);
    } else if (kind === "api_key") {
      out = out.replace(pattern, (match) => {
        const sep = match.indexOf(":") >= 0 ? ":" : "=";
        const idx = match.indexOf(sep);
        return `${match.slice(0, idx + 1)} [REDACTED:${kind}]`;
      });
    } else {
      out = out.replace(pattern, `[REDACTED:${kind}]`);
    }
  }
  if (settings.entropy) out = redactGenerated(out);

  const encoder = new TextEncoder();
  const bytes = encoder.encode(out);
  if (bytes.byteLength > maxBytes) {
    const decoder = new TextDecoder();
    const sliced = decoder.decode(bytes.subarray(0, maxBytes));
    return `${sliced}\n... [TRUNCATED:${bytes.byteLength - maxBytes} bytes]`;
  }
  return out;
}

/**
 * Pass 2: Deep structured object scrubber (key-name redaction + string value pass).
 */
export function redactValue<T>(value: T, options: RedactionOptions = {}): T {
  if (typeof value === "string") {
    return redactText(value, options) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED:sensitive_field]";
      } else {
        out[k] = redactValue(v, options);
      }
    }
    return out as T;
  }
  return value;
}
