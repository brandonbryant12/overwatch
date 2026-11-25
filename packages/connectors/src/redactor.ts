export interface RedactionOptions {
  readonly maxBytes?: number;
  readonly customPatterns?: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }>;
}

const DEFAULT_MAX_BYTES = 16_384;

const BUILTIN_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp }> = [
  // Authorization headers (Bearer, Basic, Token)
  { kind: "auth_header", pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]+=*\b/gi },
  // JWTs
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // AWS access key IDs & secret access keys
  { kind: "aws_key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub PATs
  { kind: "github_token", pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
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

/**
 * Pass 1: Deterministic regex scrubber + byte cap for raw text excerpts (logs, stack traces, console tails).
 */
export function redactText(input: string, options: RedactionOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let out = input;
  const patterns = [...BUILTIN_PATTERNS, ...(options.customPatterns ?? [])];

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
