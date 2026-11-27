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
  | "theme" | "help" | "open" | "brief" | "investigate" | "correct" | "fix" | "publish" | "copyHandoff" | "handoffSheet" | "lens";

const KEYS: Record<string, Command> = {
  j: "next", ArrowDown: "next", k: "previous", ArrowUp: "previous", d: "done", l: "later", w: "worse", n: "never", u: "undo",
  r: "refresh", p: "prompt", Enter: "prompt", t: "theme", "?": "help", o: "open", b: "brief", i: "investigate", y: "correct", f: "fix", P: "publish",
  c: "copyHandoff", O: "handoffSheet", g: "lens",
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

// ---------------------------------------------------------------- What's new

export interface CaughtUp {
  readonly seq: number;
  readonly atMs: number;
}

export type WhatsNewWindow = "since" | "24h";
export type WhatsNewKind = "fix" | "returned" | "new" | "change" | "quieted";

export interface WhatsNewItem {
  readonly id: string;
  readonly kind: WhatsNewKind;
  readonly subject: string;
  readonly title: string;
  readonly detail: string;
  readonly badge?: string;
  readonly tone: "ok" | "warn" | "error" | "accent" | "neutral";
}

export interface WhatsNewGroup {
  readonly kind: WhatsNewKind;
  readonly label: string;
  readonly items: ReadonlyArray<WhatsNewItem>;
}

export interface WhatsNewSummary {
  readonly window: WhatsNewWindow;
  readonly sinceSeq: number;
  readonly sinceAtMs: number;
  readonly count: number;
  readonly groups: ReadonlyArray<WhatsNewGroup>;
  readonly overflow: ReadonlyArray<WhatsNewItem>;
}

/** Narrow structural view of a Snapshot needed for What's new computation. */
export interface WhatsNewSnapshot {
  readonly seq: number;
  readonly atMs: number;
  readonly environments: ReadonlyArray<{ readonly app: string; readonly environment: string }>;
  readonly incidents: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly app: string;
    readonly environment: string;
    readonly severity: string;
    readonly active: boolean;
    readonly group?: string | null | undefined;
    readonly decidedSeq?: number | null | undefined;
    readonly way?: unknown;
    readonly returned?: { readonly code: string; readonly reason: string; readonly seq?: number | null | undefined; readonly causeSeq?: number | null | undefined } | null | undefined;
    readonly firstSeq: number;
    readonly lastSeq: number;
    readonly firstMs: number;
    readonly lastMs: number;
  }>;
  readonly deploys: ReadonlyArray<{
    readonly app: string;
    readonly environment: string;
    readonly revision: string;
    readonly previous?: string | null | undefined;
    readonly seq: number;
  }>;
  readonly outlook?: {
    readonly commits?: ReadonlyArray<{
      readonly app: string;
      readonly sha: string;
      readonly committedAt: number;
      readonly subject: string;
      readonly deployedEnvs: ReadonlyArray<string>;
    }> | null | undefined;
  } | null | undefined;
  readonly fixes?: ReadonlyArray<{
    readonly id: string;
    readonly incident: string;
    readonly state: string;
    readonly seq: number;
    readonly prUrl?: string | null | undefined;
  }> | null | undefined;
}

const WHATS_NEW_GROUP_MAX = 3;
const WHATS_NEW_VISIBLE_MAX = 8;

/**
 * Calm "What's new" digest computed purely from the latest snapshot and the browser's caught-up checkpoint.
 * First visit (`caughtUp === null`) or sequence reset (`caughtUp.seq > snapshot.seq`) falls back to the last 24h.
 * Bounded to at most 3 visible items per group and 8 visible items total; overflow goes behind a disclosure.
 */
export function whatsNew(
  snapshot: WhatsNewSnapshot,
  caughtUp: CaughtUp | null,
  nowMs: number,
  mode: WhatsNewWindow = "since",
): WhatsNewSummary {
  const use24h = mode === "24h" || caughtUp === null || caughtUp.seq > snapshot.seq;
  const window: WhatsNewWindow = use24h ? "24h" : "since";
  const sinceSeq = use24h ? 0 : caughtUp.seq;
  const sinceAtMs = use24h ? nowMs - DAY : caughtUp.atMs;

  const incById = new Map(snapshot.incidents.map((i) => [i.id, i]));
  const rawGroups: Array<{ readonly kind: WhatsNewKind; readonly label: string; readonly items: ReadonlyArray<WhatsNewItem> }> = [];

  // 1. Verified / Draft Fixes
  const fixItems: Array<WhatsNewItem> = [...(snapshot.fixes ?? [])]
    .filter((f) => f.seq > sinceSeq && (f.state === "verified" || ((f.state === "draft" || f.state === "published") && Boolean(f.prUrl))))
    .sort((a, b) => b.seq - a.seq)
    .map((f) => {
      const inc = incById.get(f.incident);
      return {
        id: `fix:${f.id}`,
        kind: "fix",
        subject: f.incident,
        title: inc?.title ?? f.incident,
        detail: inc ? `${inc.app} / ${inc.environment}` : f.id,
        badge: f.state === "verified" ? "⇧P ready" : "PR draft",
        tone: "ok",
      };
    });
  if (fixItems.length > 0) rawGroups.push({ kind: "fix", label: "Fixes ready", items: fixItems });

  // 2. Returned
  const returnedItems: Array<WhatsNewItem> = snapshot.incidents
    .filter((inc) => inc.returned != null && !inc.way && (inc.returned.seq ?? inc.decidedSeq ?? inc.lastSeq) > sinceSeq)
    .sort((a, b) => (b.returned?.seq ?? b.decidedSeq ?? b.lastSeq) - (a.returned?.seq ?? a.decidedSeq ?? a.lastSeq))
    .map((inc) => ({
      id: `ret:${inc.id}`,
      kind: "returned",
      subject: inc.id,
      title: inc.title,
      detail: `${inc.app} / ${inc.environment} · ${inc.returned!.reason}`,
      badge: RETURN_LABEL[inc.returned!.code] ?? "Back",
      tone: "accent",
    }));
  if (returnedItems.length > 0) rawGroups.push({ kind: "returned", label: "Returned", items: returnedItems });

  // 3. New problems
  const newItems: Array<WhatsNewItem> = snapshot.incidents
    .filter((inc) => !inc.way && !inc.returned && inc.group !== "quiet" && (use24h ? inc.firstMs >= sinceAtMs : inc.firstSeq > sinceSeq))
    .sort((a, b) => b.firstSeq - a.firstSeq)
    .map((inc) => ({
      id: `new:${inc.id}`,
      kind: "new",
      subject: inc.id,
      title: inc.title,
      detail: `${inc.app} / ${inc.environment} · ${ago(inc.firstMs, nowMs)}`,
      badge: inc.severity,
      tone: inc.severity === "error" ? "error" : inc.severity === "warn" ? "warn" : "neutral",
    }));
  if (newItems.length > 0) rawGroups.push({ kind: "new", label: "New problems", items: newItems });

  // 4. Commits & deploys
  const allCommits = snapshot.outlook?.commits ?? [];
  const changeItems: Array<WhatsNewItem> = allCommits.length > 0
    ? [...allCommits]
      .filter((c) => c.committedAt > sinceAtMs)
      .sort((a, b) => b.committedAt - a.committedAt)
      .map((c) => {
        const targetEnv = c.deployedEnvs[0] ?? snapshot.environments.find((e) => e.app === c.app)?.environment ?? "prod";
        return {
          id: `commit:${c.app}:${c.sha}`,
          kind: "change",
          subject: `env:${c.app}/${targetEnv}`,
          title: c.subject,
          detail: `${c.app} · ${c.sha.slice(0, 8)} · ${ago(c.committedAt, nowMs)}`,
          badge: c.deployedEnvs.length > 0 ? c.deployedEnvs.join(", ") : "unreleased",
          tone: c.deployedEnvs.length > 0 ? "ok" : "warn",
        };
      })
    : [...snapshot.deploys]
      .filter((d) => d.seq > sinceSeq)
      .sort((a, b) => b.seq - a.seq)
      .map((d) => ({
        id: `deploy:${d.app}:${d.environment}:${d.seq}`,
        kind: "change",
        subject: `env:${d.app}/${d.environment}`,
        title: `Deployed ${d.revision.slice(0, 8)}${d.previous ? ` ← ${d.previous.slice(0, 8)}` : ""}`,
        detail: `${d.app} / ${d.environment}`,
        badge: "deploy",
        tone: "neutral",
      }));
  if (changeItems.length > 0) rawGroups.push({ kind: "change", label: allCommits.length > 0 ? "Commits" : "Deploys", items: changeItems });

  // 5. Quieted
  const quietedItems: Array<WhatsNewItem> = snapshot.incidents
    .filter((inc) => !inc.active && !inc.way && inc.group === "quiet" && inc.lastSeq > sinceSeq)
    .sort((a, b) => b.lastSeq - a.lastSeq)
    .map((inc) => ({
      id: `quiet:${inc.id}`,
      kind: "quieted",
      subject: inc.id,
      title: inc.title,
      detail: `${inc.app} / ${inc.environment} · quiet`,
      badge: "quieted",
      tone: "ok",
    }));
  if (quietedItems.length > 0) rawGroups.push({ kind: "quieted", label: "Quieted", items: quietedItems });

  const groups: Array<WhatsNewGroup> = [];
  const overflow: Array<WhatsNewItem> = [];
  let visible = 0;

  for (const g of rawGroups) {
    const shownItems: Array<WhatsNewItem> = [];
    for (const item of g.items) {
      if (shownItems.length < WHATS_NEW_GROUP_MAX && visible < WHATS_NEW_VISIBLE_MAX) {
        shownItems.push(item);
        visible++;
      } else {
        overflow.push(item);
      }
    }
    if (shownItems.length > 0) groups.push({ kind: g.kind, label: g.label, items: shownItems });
  }

  return { window, sinceSeq, sinceAtMs, count: visible + overflow.length, groups, overflow };
}

// ---------------------------------------------------------------- Policy pills

export interface PolicyTag {
  readonly id: "watch_only" | "draft_pr" | "db_ro" | "no_alerts" | "critical";
  readonly label: string;
  readonly title: string;
  readonly tone: "muted" | "accent" | "cyan" | "warn";
  readonly highSignal: boolean;
}

export interface PolicyLike {
  readonly investigate?: boolean | null | undefined;
  readonly readings?: number | null | undefined;
  readonly notify?: boolean | null | undefined;
  readonly critical?: boolean | null | undefined;
  readonly fixMode?: string | null | undefined;
  readonly genUi?: boolean | null | undefined;
  readonly databases?: ReadonlyArray<string> | null | undefined;
}

/** At most 3 calm pills describing non-default per-environment behavior policies. */
export function policyTags(env: { readonly environment: string; readonly policy?: PolicyLike | null | undefined }): ReadonlyArray<PolicyTag> {
  const p = env.policy;
  if (!p) return [];
  const tags: Array<PolicyTag> = [];
  if (p.fixMode === "draft_pr") {
    tags.push({
      id: "draft_pr",
      label: "draft PR",
      title: "Opens draft PRs after verification; never merges",
      tone: "accent",
      highSignal: true,
    });
  }
  if ((p.databases?.length ?? 0) > 0) {
    tags.push({
      id: "db_ro",
      label: "DB ro",
      title: `Read-only SQL queries only (${p.databases!.join(", ")})`,
      tone: "cyan",
      highSignal: true,
    });
  }
  if (p.investigate === false && (p.fixMode == null || p.fixMode === "off")) {
    tags.push({
      id: "watch_only",
      label: "watch only",
      title: "Monitors and counts only; auto-investigation and fixes are off",
      tone: "muted",
      highSignal: false,
    });
  }
  if (p.critical === true && !/^(prod|production)$/i.test(env.environment)) {
    tags.push({
      id: "critical",
      label: "critical",
      title: "Treated as production-critical; active errors route to Needs you",
      tone: "warn",
      highSignal: false,
    });
  }
  if (p.notify === false && p.critical === true) {
    tags.push({
      id: "no_alerts",
      label: "no alerts",
      title: "Critical environment with desktop notifications muted",
      tone: "warn",
      highSignal: false,
    });
  }
  return tags.slice(0, 3);
}

// ---------------------------------------------------------------- Read-only DB evidence

export const isDbPiece = (piece: { readonly origin?: string | null | undefined; readonly source: string }): boolean =>
  piece.origin === "db" || /^db[:/]|^db$/i.test(piece.source);

export interface DbTable {
  readonly query?: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

const formatDbCell = (value: unknown): string =>
  value === null || value === undefined ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const objectsToTable = (items: ReadonlyArray<Record<string, unknown>>, query?: string): DbTable | null => {
  const colSet = new Set<string>();
  for (const item of items) for (const key of Object.keys(item)) colSet.add(key);
  const columns = [...colSet];
  if (columns.length === 0) return null;
  const rows = items.map((item) => columns.map((c) => formatDbCell(item[c])));
  return { ...(query ? { query } : {}), columns, rows };
};

const splitPipeRow = (line: string): Array<string> => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

/**
 * Parses read-only DB query output into a structured table when recognizable (JSON row arrays, `{ query?, columns?, rows? }`,
 * TSV from psql/mysql, or pipe-separated tables with optional leading `-- SQL` / `SQL:` header). Returns null otherwise.
 */
export function parseDbEvidence(text: string): DbTable | null {
  const raw = text.trim();
  if (!raw) return null;

  let query: string | undefined;
  let body = raw;

  const firstNl = raw.indexOf("\n");
  if (firstNl > 0) {
    const firstLine = raw.slice(0, firstNl).trim();
    const sqlHeader = /^(?:--\s*|SQL:\s*)(.+)$/i.exec(firstLine);
    if (sqlHeader && sqlHeader[1]?.trim()) {
      query = sqlHeader[1].trim();
      body = raw.slice(firstNl + 1).trim();
    }
  }
  if (!body) return null;

  // 1. JSON formats: array of objects, or { query?, columns?, rows? }
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) {
        if (parsed.length > 0 && parsed.every(isPlainObject)) return objectsToTable(parsed, query);
        return null;
      }
      if (isPlainObject(parsed)) {
        const q = typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : query;
        const rawRows = parsed.rows;
        if (!Array.isArray(rawRows)) return null;
        if (Array.isArray(parsed.columns) && parsed.columns.length > 0) {
          const columns = parsed.columns.map(String);
          const rows = rawRows.map((r) =>
            Array.isArray(r) ? columns.map((_, i) => formatDbCell(r[i]))
              : isPlainObject(r) ? columns.map((c) => formatDbCell(r[c]))
              : [formatDbCell(r)],
          );
          return { ...(q ? { query: q } : {}), columns, rows };
        }
        if (rawRows.length > 0 && rawRows.every(isPlainObject)) return objectsToTable(rawRows, q);
        return null;
      }
    } catch {
      // Not valid JSON; fall through to delimited table formats.
    }
  }

  const lines = body.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  // 2. TSV (psql -A -F \t, mysql --batch)
  if (lines[0]!.includes("\t")) {
    const columns = lines[0]!.split("\t").map((c) => c.trim());
    if (columns.length >= 2 && columns.some(Boolean)) {
      const rest = lines.slice(1).filter((l) => !/^[-+\t\s]+$/.test(l));
      if (rest.length > 0 && rest.every((l) => l.includes("\t"))) {
        const rows = rest.map((l) => {
          const cells = l.split("\t");
          return columns.map((_, i) => (cells[i] ?? "").trim());
        });
        return { ...(query ? { query } : {}), columns, rows };
      }
    }
  }

  // 3. Pipe-separated tables (Markdown / psql aligned)
  if (lines[0]!.includes("|")) {
    const columns = splitPipeRow(lines[0]!);
    if (columns.length >= 2 && columns.every(Boolean)) {
      const hasSep = /^[\s|+:-]+$/.test(lines[1]!) && lines[1]!.includes("-");
      const dataLines = (hasSep ? lines.slice(2) : lines.slice(1)).filter((l) => !/^\(\d+\s+rows?\)$/i.test(l.trim()));
      if (dataLines.every((l) => l.includes("|"))) {
        const rows = dataLines.map((l) => {
          const cells = splitPipeRow(l);
          return columns.map((_, i) => cells[i] ?? "");
        });
        if (hasSep || rows.length > 0) return { ...(query ? { query } : {}), columns, rows };
      }
    }
  }

  return null;
}
