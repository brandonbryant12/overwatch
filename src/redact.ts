/**
 * Redaction: the one boundary text from outside passes before it is stored, printed or given to a model.
 *
 * `clean` is the only way to make a `Clean` string, and the writer accepts text only as `Clean` (or re-cleans whatever
 * reaches it at run time, since a type is erased when Node strips it). The rules are a documented family: named
 * credentials, authorization headers and bearer tokens, cookies, connection-string passwords, private keys, JWTs,
 * AWS, GitHub, Slack and `sk-` keys, and values that look generated (by how their characters are arranged). It does
 * not recognise every possible secret.
 */
import { createHash } from "node:crypto";

declare const brand: unique symbol;
/** Text that has passed redaction. */
export type Clean = string & { readonly [brand]: "clean" };

const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["auth_header", /\b(proxy-)?authorization\s*[:=]\s*["']?[^\s"',;]+(\s+[^\s"',;]+)?/gi],
  ["auth_header", /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["aws_key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github_token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g],
  ["slack_token", /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g],
  ["api_key", /\bsk-[A-Za-z0-9_-]{16,}/g],
  ["dsn_password", /\b([a-z][a-z0-9+.-]{1,15}:\/\/[^:\s/@]{0,64}:)[^@\s]{1,128}(?=@)/gi],
  ["cookie", /\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi],
  [
    "named_secret",
    /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*)(?!\[REDACTED)("[^"\n]*"|'[^'\n]*'|[^\s"',;&})\]]+)/gi]];

const TOKEN = /[A-Za-z0-9+/_-]{20,}={0,2}/g;
const RUN = /[A-Za-z0-9]{16,}/g;
const HEX_OR_UUID = /^[0-9a-f-]+$/i;
let customPatterns: RegExp[] = [];
/** Configures extra corporate redaction regexes (from config `redactPatterns`), applied in `clean()` and `outbound()`. */
export function setRedactPatterns(patterns: ReadonlyArray<string>): void {
  customPatterns = patterns.map((p) => new RegExp(p, "g"));
}

/**
 * True when a run of letters and digits looks generated rather than written: digits scattered, constant changes of
 * character class, few vowels. Hexadecimal values and UUIDs are left alone on purpose: commits, digests and the
 * identifiers Overwatch generates are evidence, not secrets.
 */
export function looksGenerated(run: string): boolean {
  if (run.length < 16 || HEX_OR_UUID.test(run)) return false;
  const counts = new Map<string, number>();
  let digits = 0, digitGroups = 0, letters = 0, vowels = 0, transitions = 0, previous = "";
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
  for (const count of counts.values()) entropy -= (count / run.length) * Math.log2(count / run.length);
  if (entropy < 3) return false;
  const ratio = vowels / letters;
  return (digitGroups >= 3 && ratio < 0.34) || (transitions >= run.length / 2 && ratio < 0.3) || (digitGroups >= 2 && ratio < 0.2);
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);

/** Redacts text and bounds it to `maxBytes` of UTF-8. Idempotent: cleaning clean text changes nothing. */
export function clean(input: string, maxBytes = 16_384): Clean {
  let out = input;
  for (const [kind, pattern] of PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      if (kind === "named_secret" || kind === "dsn_password") return `${groups[0]}[REDACTED:${kind}]`;
      return `[REDACTED:${kind}]`; });
  }
  for (const re of customPatterns) out = out.replace(re, "[REDACTED:custom]");
  out = out.replace(TOKEN, (token) => {
    if (HEX_OR_UUID.test(token)) return token;
    const runs = token.match(RUN) ?? [];
    const joined = /[+=]/.test(token) && token.length >= 32 ? [token.replace(/[^A-Za-z0-9]/g, "")] : [];
    return [...runs, ...joined].some(looksGenerated) ? `[REDACTED:high_entropy:${digest(token)}]` : token; });
  return truncate(out, maxBytes) as Clean;
}

/** Bounds text to `maxBytes` of UTF-8 without splitting a character, saying so with a readable marker. */
/**
 * The last boundary for text that leaves the laptop (a draft's title and body, a notice): secrets redacted as
 * everywhere, and private local paths (home folders, temporary folders, volumes) replaced, on the final document.
 */
export function outbound(text: string): string {
  return clean(text, 60_000).replace(/(?:~\/|(?<![\w.])\/(?:Users|home|root|private|var\/folders|tmp|Volumes)\/|[A-Za-z]:\\Users\\)[^\s"'`)\]<>|]*/g, "<private path>");
}

export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = " … [truncated]";
  const room = maxBytes - Buffer.byteLength(marker);
  let bytes = Buffer.from(text).subarray(0, Math.max(0, room)).toString("utf8");
  if (bytes.endsWith("�")) bytes = bytes.slice(0, -1);
  while (Buffer.byteLength(bytes) > room) bytes = bytes.slice(0, -1);
  return bytes + marker;
}

/** Cleans every string in a value, keys included. The writer stores JSON only through this. */
export function cleanDeep(value: unknown): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [clean(k), cleanDeep(v)]));
  return value;
}

/** An error's message, cleaned: the only way an error's text is printed, stored or returned. */
export const errorText = (error: unknown, maxBytes = 500): Clean => clean(error instanceof Error ? error.message : String(error), maxBytes);
