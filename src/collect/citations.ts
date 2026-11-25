import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type { Finding } from "./report.ts";

/**
 * Checks a finding's citations against what the investigation could actually have seen. No model is involved:
 * a quote is either in the text it is attributed to or it is not.
 *
 * - `codeLocation` must name a file and line that exist in the code the investigation was given.
 * - A quote attributed to a file must be in that file.
 * - A quote attributed to a telemetry source must be in something that source returned to this session: a
 *   `query_telemetry` result, or an excerpt of that source in its context pack. Other parts of the context pack
 *   (Overwatch's description, the owner's question, earlier conclusions) are recorded as shown but are not evidence.
 * - A quote attributed to `git_history` (or a `git:<operation>` label) must be in something that tool returned to
 *   this session: Overwatch ran it, so its output is a source it can read.
 * - A quote attributed to anything else (a skill, a tool Overwatch cannot see, a mistyped name) cannot be checked.
 *   It is kept and marked not verified, even if the same words appear somewhere the session was shown.
 *
 * The first three are contradictions when they fail, and the finding is sent back with what was wrong.
 */
export interface Shown {
  /** The telemetry source the text came from, or `brief:<kind>` / `git:<operation>` for text that is not a source's. */
  readonly source: string;
  readonly text: string;
}

export interface CitationInput {
  readonly shown: ReadonlyArray<Shown>;
  /** Source names configured for the app's environments. */
  readonly sources: ReadonlyArray<string>;
  /** The code the investigation reads. Absent when no code could be provided. */
  readonly directory?: string;
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The parts of a quote that must be found, in order: the quote split where the author elided text with "...". Every
 * part the author did not elide must be there, however short: a dropped word can change what a quote says.
 */
export function quoteParts(quote: string): string[] {
  return squash(quote)
    .split(/\s*(?:\.{3,}|…)\s*/)
    .map((part) => part.replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter(Boolean);
}

/** True when every part of the quote appears in the text, in order. Whitespace differences do not matter. */
export function quoted(quote: string, haystack: string): boolean {
  const parts = quoteParts(quote);
  if (!parts.length || parts.join("").length < 8) return false;
  const body = squash(haystack);
  let from = 0;
  for (const part of parts) {
    const at = body.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** Reads a file of the investigation's code by its relative path. Never leaves the directory, even through a link. */
async function codeFile(directory: string, path: string): Promise<string | undefined> {
  const relative = path.replace(/^\.\//, "");
  if (!relative || isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return undefined;
  try {
    const root = await realpath(directory);
    const target = await realpath(join(root, relative));
    if (target !== root && !target.startsWith(root + sep)) return undefined;
    const info = await stat(target);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return undefined;
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

const LOCATION = /^([^\s:]+):(\d+)(?:-(\d+))?$/;

export async function verifyCitations(finding: Finding, input: CitationInput): Promise<{ finding: Finding; errors: string[] }> {
  const errors: string[] = [];
  const e = finding.engineering;
  let locationFile: string | undefined;

  if (e.codeLocation) {
    const match = LOCATION.exec(e.codeLocation);
    if (!input.directory) {
      errors.push("engineering.codeLocation: this investigation has no code to read, so a code location cannot be checked. Remove it and say so under notChecked.");
    } else if (match) {
      locationFile = await codeFile(input.directory, match[1]!);
      if (locationFile === undefined) {
        errors.push(`engineering.codeLocation: ${match[1]} is not a file in the working directory. Use a path relative to it.`);
      } else {
        const count = locationFile.split("\n").length - (locationFile.endsWith("\n") ? 1 : 0);
        const last = Number(match[3] ?? match[2]);
        if (Number(match[2]) < 1 || last < Number(match[2]) || last > count) {
          errors.push(`engineering.codeLocation: ${match[1]} has ${count} line(s); ${e.codeLocation} is outside it.`);
        }
      }
    }
  }

  const evidence: Array<Finding["engineering"]["evidence"][number]> = [];
  for (const [index, item] of e.evidence.entries()) {
    // What a label names is decided by what it is, never by which lookup happens to succeed: a configured source's
    // name is that source, git_history's labels are git, and anything else is a path in the working directory.
    const label = item.source.trim();
    const fromSource = input.sources.includes(label);
    const fromGit = !fromSource && (label === "git_history" || label.startsWith("git:"));
    const path = label.replace(/:\d+(-\d+)?$/, "");
    const file = !fromSource && !fromGit && input.directory ? await codeFile(input.directory, path) : undefined;
    let verified: boolean;
    if (file !== undefined) {
      verified = quoted(item.quote, file);
      if (!verified) errors.push(`engineering.evidence[${index}]: the quote is not in ${path}. Copy the line exactly as it is in the file.`);
    } else if (fromSource) {
      // Only what that source returned counts: the owner's question or a conclusion in the brief is not evidence.
      verified = input.shown.some((shown) => shown.source === label && quoted(item.quote, shown.text));
      if (!verified) {
        errors.push(
          `engineering.evidence[${index}]: the quote is not in anything source "${label}" returned to this investigation. Copy a line exactly from an overwatch_query result or from the report you were given, or name where it really came from.`,
        );
      }
    } else if (fromGit) {
      verified = input.shown.some((shown) => (label.startsWith("git:") ? shown.source === label : shown.source.startsWith("git:")) && quoted(item.quote, shown.text));
      if (!verified) errors.push(`engineering.evidence[${index}]: the quote is not in anything git_history returned to this investigation. Copy a line exactly from its output.`);
    } else {
      // Not a configured source and not a file: Overwatch cannot tell where it came from, so it is not verified,
      // whatever else the session was shown. It is kept, and shown as unverified.
      verified = false;
    }
    evidence.push({ source: item.source, quote: item.quote, verified });
  }
  return { finding: { ...finding, engineering: { ...e, evidence } }, errors };
}

/**
 * What a finding may claim. A verdict of "real" with the cause "observed" needs at least one quote that matched
 * something Overwatch can read (a configured source's output, a file in the worktree, `git_history`'s output).
 * Without one the cause is recorded as "inferred", and `note` says so to the agent.
 */
export function claimable(finding: Finding): { finding: Finding; note: string | null } {
  const e = finding.engineering;
  if (e.verdict !== "real" || e.causeBasis !== "observed" || e.evidence.some((x) => x.verified === true)) return { finding, note: null };
  return {
    finding: { ...finding, engineering: { ...e, causeBasis: "inferred" } },
    note: 'The cause was recorded as "inferred", not "observed": a real verdict with an observed cause needs at least one quote that exactly matched a source\'s output, a file in the working directory, or git_history\'s output, and none did.',
  };
}
