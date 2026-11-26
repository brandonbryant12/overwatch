/**
 * The page's own decisions, as pure functions: which rows are shown and in what order, what waits behind "N new",
 * where focus moves, what a key means, and how Later's words read. The service decides everything else.
 *
 * Every function takes the narrowest shape it reads, so the page's Schemas and the tests' plain objects both fit.
 */

export const GROUPS = ["needsYou", "new", "working", "quiet"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_LABEL: Record<Group, string> = { needsYou: "Needs you", new: "New", working: "Working", quiet: "Quiet" };

/** The rows shown, by group. */
export type Shown = Record<Group, ReadonlyArray<string>>;
/** What the page reads of the service's inbox. */
export interface InboxGroups {
  readonly groups?: Partial<Record<string, ReadonlyArray<string>>> | undefined;
}

/** One list per group, in group order. */
const byGroup = (f: (group: Group) => ReadonlyArray<string>): Shown => ({ needsYou: f("needsYou"), new: f("new"), working: f("working"), quiet: f("quiet") });

/** The rows shown, frozen from one inbox: { group: ids }. */
export const freeze = (inbox: InboxGroups | null | undefined): Shown => byGroup((g) => [...(inbox?.groups?.[g] ?? [])]);

/** Where each id is in the server's inbox. */
const placeOf = (inbox: InboxGroups | null | undefined) => {
  const at = new Map<string, { group: Group; index: number }>();
  for (const g of GROUPS) (inbox?.groups?.[g] ?? []).forEach((id, index) => at.set(id, { group: g, index }));
  return at;
};

export interface Staged {
  readonly arrivals: ReadonlyArray<string>;
  readonly moved: ReadonlyArray<string>;
  readonly count: number;
}

/**
 * What a new inbox would change without moving anything shown: arrivals (ids not shown) and regroupings (ids shown
 * in another group). Both wait until the owner refreshes.
 */
export function staged(shown: Partial<Shown>, inbox: InboxGroups | null | undefined): Staged {
  const at = placeOf(inbox);
  const visible = new Map<string, Group>();
  for (const g of GROUPS) for (const id of shown[g] ?? []) visible.set(id, g);
  const arrivals = [...at.keys()].filter((id) => !visible.has(id));
  const moved = [...visible].filter(([id, g]) => at.has(id) && at.get(id)!.group !== g).map(([id]) => id);
  return { arrivals, moved, count: arrivals.length + moved.length };
}

/** The owner's own action removed a row: it leaves at once. */
export const without = (shown: Partial<Shown>, id: string): Shown => byGroup((g) => (shown[g] ?? []).filter((x) => x !== id));

/** The owner's undo put a row back: it returns at once, in its group, among the rows already shown, in server order. */
export function restore(shown: Partial<Shown>, inbox: InboxGroups | null | undefined, id: string): Shown {
  const at = placeOf(inbox);
  const place = at.get(id);
  const next = without(shown, id);
  if (!place) return next;
  const rows = [...next[place.group]];
  const after = rows.findIndex((x) => {
    const p = at.get(x);
    return (p?.group === place.group ? p.index : Infinity) > place.index;
  });
  rows.splice(after < 0 ? rows.length : after, 0, id);
  return { ...next, [place.group]: rows };
}

/** The rows in display order, skipping collapsed groups. */
export const order = (shown: Partial<Shown>, collapsed: Partial<Record<Group, boolean>>): ReadonlyArray<string> =>
  GROUPS.filter((g) => !collapsed[g]).flatMap((g) => shown[g] ?? []);

/** Focus after moving by `delta` through the displayed rows; from nothing, j starts at the top. */
export function step(rows: ReadonlyArray<string>, focus: string | null, delta: number): string | null {
  if (!rows.length) return focus;
  const i = focus === null ? -1 : rows.indexOf(focus);
  if (i < 0) return delta > 0 ? rows[0]! : rows[rows.length - 1]!;
  return rows[Math.min(rows.length - 1, Math.max(0, i + delta))]!;
}

/** Focus after the focused row left: the row that took its place, else the one before. */
export function after(rows: ReadonlyArray<string>, removed: string, focus: string | null): string | null {
  if (focus !== removed) return focus;
  const i = rows.indexOf(removed);
  const rest = rows.filter((x) => x !== removed);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}

export type Command =
  | "escape" | "search" | "next" | "previous" | "done" | "later" | "worse" | "never" | "undo" | "refresh" | "prompt"
  | "theme" | "help" | "open" | "brief" | "investigate" | "correct" | "fix" | "publish";

const KEYS: Record<string, Command> = {
  j: "next", ArrowDown: "next", k: "previous", ArrowUp: "previous", d: "done", l: "later", w: "worse", n: "never", u: "undo",
  r: "refresh", p: "prompt", Enter: "prompt", t: "theme", "?": "help", o: "open", b: "brief", i: "investigate", y: "correct", f: "fix", P: "publish",
};

/** What a key means. Keys typed into a field are text, except Escape. */
export function command(
  key: string,
  { typing = false, overlay = false, shift = false, meta = false }: { typing?: boolean; overlay?: boolean; shift?: boolean; meta?: boolean } = {},
): Command | null {
  if (key === "Escape") return "escape";
  if (typing) return null;
  if ((meta && key.toLowerCase() === "k") || key === "/") return "search";
  if (meta) return null;
  if (overlay) return null;
  if (shift && key === "?") return "help";
  return Object.hasOwn(KEYS, key) ? KEYS[key]! : null;
}

/** A way out the page asks the service for: Done, Later (until something changes, worse or a time) or Never. */
export interface WayOut {
  readonly action: "done" | "later" | "never";
  readonly when?: "worse";
  readonly untilMs?: number;
  readonly reason?: string;
}

const DAY = 86_400_000;
/**
 * Later's words: empty means "until something changes"; "worse"; "2h", "45m", "3d"; "tomorrow" (9:00); a weekday
 * ("monday", 9:00). Returns the action body, or { error }.
 */
export function later(text: string, nowMs: number): WayOut | { readonly error: string } {
  const t = text.trim().toLowerCase();
  if (!t) return { action: "later" };
  if (t === "worse" || t === "w") return { action: "later", when: "worse" };
  const span = /^(\d{1,4})\s*(m|min|h|hr|d|day)s?$/.exec(t);
  if (span) {
    const n = Number(span[1]), unit = span[2]![0];
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : DAY);
    return ms > 0 ? { action: "later", untilMs: nowMs + ms } : { error: "Choose a time in the future" };
  }
  const nine = (base: number) => {
    const d = new Date(base);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  if (t === "tomorrow") return { action: "later", untilMs: nine(nowMs + DAY) };
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const day = days.findIndex((d) => d.startsWith(t) && t.length >= 3);
  if (day >= 0) {
    const ahead = ((day - new Date(nowMs).getDay() + 7) % 7) || 7;
    return { action: "later", untilMs: nine(nowMs + ahead * DAY) };
  }
  return { error: "Try 2h, 45m, tomorrow, monday or worse, or leave it empty" };
}

export type Connection = "unknown" | "live" | "stale" | "down";

/** What the strip shows for an environment: nothing the page cannot vouch for is shown as measured. */
export const shownHealth = (health: string, connection: Connection): string => (connection === "live" ? health : "unknown");

/** The service's clock as last stated against the page's monotonic clock. */
export interface Anchor {
  readonly atMs: number;
  readonly monoMs: number;
}

/**
 * The service's wall clock as the page can know it: the last time the service stated it (a snapshot's or a
 * heartbeat's atMs), plus the page's own monotonic time since.
 */
export const serverNow = (anchor: Anchor | null, monoMs: number): number | null =>
  anchor ? anchor.atMs + Math.max(0, monoMs - anchor.monoMs) : null;

/**
 * An environment's cell, aged on the page's own clock: the snapshot says when each expected reading was last
 * measured and how long that stays fresh; once any has gone old the cell is stale, however live the connection.
 * A live transport never certifies a fresh measurement.
 */
export function cellHealth(
  env: { readonly health: string; readonly freshForMs: number; readonly readings?: ReadonlyArray<{ readonly okMs: number | null }> | null | undefined },
  connection: Connection,
  now: number | null,
): string {
  if (connection !== "live") return "unknown";
  if (env.health === "signed_out" || env.health === "stale" || now === null || !Array.isArray(env.readings)) return env.health;
  const old = env.readings.some((r) => r.okMs === null || now - r.okMs > env.freshForMs);
  return old ? "stale" : env.health;
}

/** The line that holds back changes: arrivals (new or returned rows) ask for attention; moves only say so. */
export function pendingLabel({ arrivals, moved }: Pick<Staged, "arrivals" | "moved">) {
  const parts: Array<string> = [];
  if (arrivals.length) parts.push(`${arrivals.length} new`);
  if (moved.length) parts.push(`${moved.length} moved`);
  return { text: parts.join(" · "), attention: arrivals.length > 0, count: arrivals.length + moved.length };
}

/** How long a row must hold focus before it counts as looked at. */
export const SEEN_AFTER_MS = 1500;

export const HEALTH_LABEL: Record<string, string> = {
  quiet: "Checked and quiet",
  attention: "Needs a look",
  partial: "Checked in part",
  stale: "Not checked recently",
  signed_out: "Signed out",
  unknown: "Health unknown",
};

export const RETURN_LABEL: Record<string, string> = {
  again: "Back: happened again", deploy: "Back: deployed", finding: "Back: new finding", worse: "Back: worse", severity: "Back: more severe",
  deadline: "Back: time's up", recurred: "Back: recurred",
};

/** "4m ago", "2h ago", "3d ago". */
export function ago(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A row's count as words: exact, or a lower bound. */
export const countText = (count: number, exact: boolean): string => `${count.toLocaleString("en-US")}${exact ? "" : "+"}×`;

/** What the page reads of an adjudicated investigation. */
export interface VerdictResult {
  readonly verdict: string;
  readonly planned: number;
  readonly counts?: { readonly real?: number | undefined; readonly not_real?: number | undefined; readonly unsure?: number | undefined; readonly missing?: number | undefined } | null | undefined;
  readonly challenge?: { readonly outcome?: string | null | undefined } | null | undefined;
  readonly observed?: boolean | null | undefined;
  readonly observations?: number | null | undefined;
}

/**
 * How an investigation's result reads at a glance. "agreed" only when every planned reading filed the same verdict
 * and the verdict stands; any dissent, missing reading or undecided result looks different.
 */
export function verdictView(result: VerdictResult) {
  const c = result.counts ?? {};
  const label = ({ real: "Real", not_real: "Not real", unsure: "Undecided" } as Record<string, string>)[result.verdict] ?? result.verdict;
  const unanimous = Math.max(c.real ?? 0, c.not_real ?? 0, c.unsure ?? 0) === result.planned && !((c.missing ?? 0) > 0);
  const tone = result.verdict === "unsure" ? "undecided" : unanimous && result.challenge?.outcome !== "disproved" ? "agreed" : "disagreed";
  const parts = [`${c.real ?? 0} of ${result.planned} said real`];
  if (c.not_real) parts.push(`${c.not_real} not real`);
  if (c.unsure) parts.push(`${c.unsure} unsure`);
  if (c.missing) parts.push(`${c.missing} did not file`);
  const challenge = result.challenge ? (result.challenge.outcome ? `challenger ${result.challenge.outcome}` : "challenger did not file") : null;
  // Negative facts are stated in words: a real verdict telemetry did not confirm, and how many distinct observations
  // the agreeing readings cited (agreement on one line is one observation).
  const n = result.observations;
  const evidence = result.verdict !== "real" ? null
    : result.observed ? `observed in telemetry${typeof n === "number" ? ` · ${n} distinct observation${n === 1 ? "" : "s"} cited` : ""}`
    : "no telemetry confirmation: code only, not observed";
  return { label, tone, votes: parts.join(" · "), challenge, observed: Boolean(result.observed), evidence };
}

/** What stands behind an answer: the responder reads evidence but cites none. */
export function answerBasis(turn: { readonly reads?: number | null | undefined }): string {
  const n = turn.reads ?? 0;
  return n ? `Read ${n} piece${n === 1 ? "" : "s"} of evidence; no evidence cited in the answer` : "No evidence read or cited: unverified";
}

/** An evidence handle, short for reading; the page keeps the full handle on hover and copy. */
export const shortHandle = (h: unknown): string => (typeof h === "string" && h.length > 10 ? `${h.slice(0, 8)}…` : String(h ?? ""));

/** What the page reads of a capacity forecast. */
export interface Forecast {
  readonly source: string;
  readonly resource: string;
  readonly unit?: string | null | undefined;
  readonly limit: number;
  readonly state: string;
  readonly reason?: string | null | undefined;
  readonly asOfMs: number | null;
  readonly etaMinutes?: number | null | undefined;
  readonly samples?: number | null | undefined;
  readonly ratePerMinute?: number | null | undefined;
  readonly intervalMs: number;
}

/** Time left in words, only from a forecast the service made; otherwise null (the reason is shown when asked). */
export function timeLeft(f: Forecast | null | undefined, nowMs: number) {
  // Aged on the page's own clock like every reading: a forecast whose newest sample is older than one interval is gone.
  if (!f || f.state !== "forecast" || f.asOfMs === null || nowMs - f.asOfMs > f.intervalMs) return null;
  const at = f.asOfMs + (f.etaMinutes ?? 0) * 60_000;
  const left = Math.max(0, at - nowMs), h = Math.floor(left / 3_600_000), mins = Math.ceil((left % 3_600_000) / 60_000);
  const span = h ? `${h} h ${mins} min` : `${mins} min`;
  const amount = (v: number) => (f.unit === "bytes" ? bytes(v) : `${Number(v.toPrecision(3)).toLocaleString("en-US")} units`);
  return {
    short: `${f.resource} full in ~${span}`,
    long: `${f.resource} reaches its limit of ${amount(f.limit)} in about ${span} (around ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}), at the rate of the last ${f.samples} readings: +${amount(f.ratePerMinute ?? 0)} a minute. A projection, not a promise.`,
  };
}

/** A fix attempt's state in words: what it is, and the one rule or step that explains it. */
export const FIX_LABEL: Record<string, string> = {
  queued: "Checking eligibility", proposing: "A model is selecting a change", verifying: "Verifying in isolation",
  verified: "Verified: ready for your review", published: "Draft pull request opened", blocked: "No proposal: blocked", ineligible: "No proposal: not eligible",
  refused: "No proposal: refused", verify_failed: "Verify failed", stale: "Void: no longer current", unresolved: "The base could not be read",
};
export const fixTone = (state: string): string =>
  ["verified", "published"].includes(state) ? "live" : ["queued", "proposing", "verifying"].includes(state) ? "working" : "stopped";

/** What the page reads of a staging comparison. */
export interface Comparison {
  readonly app?: string | undefined;
  readonly staging: string;
  readonly state: string;
  readonly reason?: string | null | undefined;
  readonly stagingRevision?: string | null | undefined;
  readonly productionRevision?: string | null | undefined;
  readonly stagingCount?: number | null | undefined;
  readonly productionCount?: number | null | undefined;
}

/** A staging comparison in words: regression, no signal, unknown (with the side and reason), or the same release. */
export function comparisonText(c: Comparison | null | undefined): string | null {
  if (!c) return null;
  const st = String(c.stagingRevision ?? "").slice(0, 12), pr = String(c.productionRevision ?? "unknown").slice(0, 12);
  if (c.state === "regression") return `New in ${c.staging} since ${st}: ${c.stagingCount} occurrences over two intervals; production ${pr} unchanged with ${c.productionCount}. A staging signal only: it does not decide a promotion.`;
  if (c.state === "no_signal") return `${c.staging} ${st} against production ${pr}: no new staging-only problem in two intervals. Low traffic cannot certify a release.`;
  if (c.state === "same_release") return `${c.staging} runs the production revision ${pr}.`;
  return `${c.staging} ${st} against production ${pr}: unknown. ${c.reason ?? ""}`;
}

/** Bytes in decimal units, three significant figures: 1.3 GB, 500 GB. */
export function bytes(value: number): string {
  const units = ["bytes", "kB", "MB", "GB", "TB", "PB"];
  let v = value, i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) (v /= 1000), i++;
  return `${Number(v.toPrecision(3))} ${units[i]}`;
}

/** What each fix state waits for: the next observation that would change it. */
export const FIX_NEXT: Record<string, string> = {
  queued: "Next: the rules are checked, then a model selects a change.", proposing: "Next: the fixer's selection.", verifying: "Next: the verify commands finish in isolation.",
  verified: "Nothing leaves this laptop until you press P.", published: "Overwatch is done with it. Whether the fix worked shows on the problem itself; close it with Done.",
  blocked: "Next: pass overwatch trial --fixes, then press f.",
  ineligible: "Next: a new investigation or deployment; f checks again.", refused: "Nothing further for this finding.", verify_failed: "Next: make the verify command pass from tracked files (docs/setup.md), pass overwatch trial --fixes, then press f for a new attempt.",
  stale: "Next: press f to derive again on the current base.", unresolved: "Next: press f once the remote answers.",
};

/** A forecast or comparison without an answer, and what would give one. */
export function outlookNext(x: (Partial<Forecast> & Partial<Comparison>) | null | undefined): string | null {
  if (!x) return null;
  if (x.samples !== undefined) {
    if (x.state === "forecast") return null;
    if (x.state === "reached") return "Reached: free or raise capacity.";
    return `${x.reason ?? "No estimate"}. Next: ${x.state === "outside_horizon" ? "a faster rise would bring it inside 24 hours" : `${Math.max(1, 6 - (x.samples ?? 0))} more fresh, rising readings`}.`;
  }
  return x.state === "unknown" ? `${x.reason ?? "Unknown"}. Next: two aligned, fully measured intervals after the next staging release.` : null;
}

/** Subjects other than problems: environments ("env:") and sources ("src:"). */
export const isIncident = (subject: string | null): subject is string => subject !== null && !subject.startsWith("env:") && !subject.startsWith("src:");
