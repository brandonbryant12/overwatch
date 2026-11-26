/**
 * The page's own decisions, as pure functions: which rows are shown and in what order, what waits behind "N new",
 * where focus moves, what a key means, and how Later's words read. The service decides everything else.
 */

export const GROUPS = ["needsYou", "new", "working", "quiet"];
export const GROUP_LABEL = { needsYou: "Needs you", new: "New", working: "Working", quiet: "Quiet" };

/** The rows shown, frozen from one inbox: { group: ids }. */
export function freeze(inbox) {
  return Object.fromEntries(GROUPS.map((g) => [g, [...(inbox?.groups?.[g] ?? [])]]));
}

/** Where each id is in the server's inbox. */
function placeOf(inbox) {
  const at = new Map();
  for (const g of GROUPS) (inbox?.groups?.[g] ?? []).forEach((id, i) => at.set(id, { group: g, index: i }));
  return at;
}

/**
 * What a new inbox would change without moving anything shown: arrivals (ids not shown) and regroupings (ids shown
 * in another group). Both wait until the owner refreshes.
 */
export function staged(shown, inbox) {
  const at = placeOf(inbox);
  const visible = new Map();
  for (const g of GROUPS) for (const id of shown[g] ?? []) visible.set(id, g);
  const arrivals = [...at.keys()].filter((id) => !visible.has(id));
  const moved = [...visible].filter(([id, g]) => at.has(id) && at.get(id).group !== g).map(([id]) => id);
  return { arrivals, moved, count: arrivals.length + moved.length };
}

/** The owner's own action removed a row: it leaves at once. */
export function without(shown, id) {
  return Object.fromEntries(GROUPS.map((g) => [g, (shown[g] ?? []).filter((x) => x !== id)]));
}

/** The owner's undo put a row back: it returns at once, in its group, among the rows already shown, in server order. */
export function restore(shown, inbox, id) {
  const at = placeOf(inbox);
  const place = at.get(id);
  const next = without(shown, id);
  if (!place) return next;
  const rows = next[place.group];
  const after = rows.findIndex((x) => (at.get(x)?.group === place.group ? at.get(x).index : Infinity) > place.index);
  rows.splice(after < 0 ? rows.length : after, 0, id);
  return next;
}

/** The rows in display order, skipping collapsed groups. */
export function order(shown, collapsed) {
  return GROUPS.filter((g) => !collapsed[g]).flatMap((g) => shown[g] ?? []);
}

/** Focus after moving by `delta` through the displayed rows; from nothing, j starts at the top. */
export function step(rows, focus, delta) {
  if (!rows.length) return focus;
  const i = rows.indexOf(focus);
  if (i < 0) return delta > 0 ? rows[0] : rows[rows.length - 1];
  return rows[Math.min(rows.length - 1, Math.max(0, i + delta))];
}

/** Focus after the focused row left: the row that took its place, else the one before. */
export function after(rows, removed, focus) {
  if (focus !== removed) return focus;
  const i = rows.indexOf(removed);
  const rest = rows.filter((x) => x !== removed);
  return rest[Math.min(i, rest.length - 1)] ?? null;
}

/** What a key means. Keys typed into a field are text, except Escape. */
export function command(key, { typing = false, overlay = false, shift = false, meta = false } = {}) {
  if (key === "Escape") return "escape";
  if (typing) return null;
  if ((meta && key.toLowerCase() === "k") || key === "/") return "search";
  if (meta) return null;
  if (overlay) return null;
  const map = {
    j: "next", ArrowDown: "next", k: "previous", ArrowUp: "previous", d: "done", l: "later", w: "worse", n: "never", u: "undo",
    r: "refresh", p: "prompt", Enter: "prompt", t: "theme", "?": "help", o: "open", b: "brief", i: "investigate", y: "correct", f: "fix",
  };
  if (shift && key === "?") return "help";
  return map[key] ?? null;
}

const DAY = 86_400_000;
/**
 * Later's words: empty means "until something changes"; "worse"; "2h", "45m", "3d"; "tomorrow" (9:00); a weekday
 * ("monday", 9:00). Returns the action body, or { error }.
 */
export function later(text, nowMs) {
  const t = text.trim().toLowerCase();
  if (!t) return { action: "later" };
  if (t === "worse" || t === "w") return { action: "later", when: "worse" };
  const span = /^(\d{1,4})\s*(m|min|h|hr|d|day)s?$/.exec(t);
  if (span) {
    const n = Number(span[1]), unit = span[2][0];
    const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : DAY);
    return ms > 0 ? { action: "later", untilMs: nowMs + ms } : { error: "Choose a time in the future" };
  }
  const nine = (base) => {
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

/** What the strip shows for an environment: nothing the page cannot vouch for is shown as measured. */
export function shownHealth(health, connection) {
  return connection === "live" ? health : "unknown";
}

/**
 * The service's wall clock as the page can know it: the last time the service stated it (a snapshot's or a
 * heartbeat's atMs), plus the page's own monotonic time since. `anchor` is { atMs, monoMs }.
 */
export function serverNow(anchor, monoMs) {
  return anchor ? anchor.atMs + Math.max(0, monoMs - anchor.monoMs) : null;
}

/**
 * An environment's cell, aged on the page's own clock: the snapshot says when each expected reading was last
 * measured and how long that stays fresh; once any has gone old the cell is stale, however live the connection.
 * A live transport never certifies a fresh measurement.
 */
export function cellHealth(env, connection, now) {
  if (connection !== "live") return "unknown";
  if (env.health === "signed_out" || env.health === "stale" || now === null || !Array.isArray(env.readings)) return env.health;
  const old = env.readings.some((r) => r.okMs === null || now - r.okMs > env.freshForMs);
  return old ? "stale" : env.health;
}

/** The line that holds back changes: arrivals (new or returned rows) ask for attention; moves only say so. */
export function pendingLabel({ arrivals, moved }) {
  const parts = [];
  if (arrivals.length) parts.push(`${arrivals.length} new`);
  if (moved.length) parts.push(`${moved.length} moved`);
  return { text: parts.join(" · "), attention: arrivals.length > 0, count: arrivals.length + moved.length };
}

/** How long a row must hold focus before it counts as looked at. */
export const SEEN_AFTER_MS = 1500;

export const HEALTH_LABEL = {
  quiet: "Checked and quiet",
  attention: "Needs a look",
  partial: "Checked in part",
  stale: "Not checked recently",
  signed_out: "Signed out",
  unknown: "Health unknown",
};

export const RETURN_LABEL = { again: "Back: happened again", deploy: "Back: deployed", finding: "Back: new finding", worse: "Back: worse", severity: "Back: more severe", deadline: "Back: time's up", recurred: "Back: recurred" };

/** "4m ago", "2h ago", "3d ago". */
export function ago(ms, nowMs) {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A row's count as words: exact, or a lower bound. */
export const countText = (count, exact) => `${count.toLocaleString("en-US")}${exact ? "" : "+"}×`;

/**
 * How an investigation's result reads at a glance. "agreed" only when every planned reading filed the same verdict
 * and the verdict stands; any dissent, missing reading or undecided result looks different.
 */
export function verdictView(result) {
  const c = result.counts ?? {};
  const label = { real: "Real", not_real: "Not real", unsure: "Undecided" }[result.verdict] ?? result.verdict;
  const unanimous = Math.max(c.real ?? 0, c.not_real ?? 0, c.unsure ?? 0) === result.planned && !(c.missing > 0);
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
export function answerBasis(turn) {
  const n = turn.reads ?? 0;
  return n ? `Read ${n} piece${n === 1 ? "" : "s"} of evidence; no evidence cited in the answer` : "No evidence read or cited: unverified";
}

/** An evidence handle, short for reading; the page keeps the full handle on hover and copy. */
export const shortHandle = (h) => (typeof h === "string" && h.length > 10 ? `${h.slice(0, 8)}…` : String(h ?? ""));

/** Time left in words, only from a forecast the service made; otherwise null (the reason is shown when asked). */
export function timeLeft(f, nowMs) {
  // Aged on the page's own clock like every reading: a forecast whose newest sample is older than one interval is gone.
  if (!f || f.state !== "forecast" || nowMs - f.asOfMs > f.intervalMs) return null;
  const at = f.asOfMs + f.etaMinutes * 60_000;
  const left = Math.max(0, at - nowMs), h = Math.floor(left / 3_600_000), mins = Math.ceil((left % 3_600_000) / 60_000);
  const span = h ? `${h} h ${mins} min` : `${mins} min`;
  const amount = (v) => (f.unit === "bytes" ? bytes(v) : `${Number(v.toPrecision(3)).toLocaleString("en-US")} units`);
  return { short: `${f.resource} full in ~${span}`, long: `${f.resource} reaches its limit of ${amount(f.limit)} in about ${span} (around ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}), at the rate of the last ${f.samples} readings: +${amount(f.ratePerMinute)} a minute. A projection, not a promise.` };
}

/** A fix attempt's state in words: what it is, and the one rule or step that explains it. */
export const FIX_LABEL = {
  queued: "Checking eligibility", proposing: "A model is selecting a change", verifying: "Verifying in isolation", publishing: "Publishing a draft",
  draft: "Draft pull request open", awaiting_deploy: "Merged, waiting for a release", released_quiet: "Released and quiet: closed by rule",
  closed_unmerged: "Closed without merging", blocked: "No proposal: blocked", ineligible: "No proposal: not eligible", refused: "No proposal: refused",
  verify_failed: "Verify failed", stale: "Void: no longer current", declined: "Declined by you",
};
export const fixTone = (state) => (["draft", "awaiting_deploy", "released_quiet"].includes(state) ? "live" : ["queued", "proposing", "verifying", "publishing"].includes(state) ? "working" : "stopped");

/** A staging comparison in words: regression, no signal, unknown (with the side and reason), or the same release. */
export function comparisonText(c) {
  if (!c) return null;
  const st = String(c.stagingRevision ?? "").slice(0, 12), pr = String(c.productionRevision ?? "unknown").slice(0, 12);
  if (c.state === "regression") return `New in ${c.staging} since ${st}: ${c.stagingCount} occurrences over two intervals; production ${pr} unchanged with ${c.productionCount}. A staging signal only: it does not decide a promotion.`;
  if (c.state === "no_signal") return `${c.staging} ${st} against production ${pr}: no new staging-only problem in two intervals. Low traffic cannot certify a release.`;
  if (c.state === "same_release") return `${c.staging} runs the production revision ${pr}.`;
  return `${c.staging} ${st} against production ${pr}: unknown. ${c.reason ?? ""}`;
}

/** Bytes in decimal units, three significant figures: 1.3 GB, 500 GB. */
export function bytes(v) {
  const units = ["bytes", "kB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) (v /= 1000), i++;
  return `${Number(v.toPrecision(3))} ${units[i]}`;
}

/** What each fix state waits for: the next observation that would change it. */
export const FIX_NEXT = {
  queued: "Next: the rules are checked, then a model selects a change.", proposing: "Next: the fixer's selection.", verifying: "Next: the verify commands finish in isolation.",
  publishing: "Next: the host answers, one step at a time.", draft: "Next: the draft is merged or closed (checked once a minute).",
  awaiting_deploy: "Next: a deployment that contains the merge, then three quiet intervals.", released_quiet: "Closed by rule; nothing further.",
  closed_unmerged: "The problem stays open; a new investigation can lead to a new proposal.", blocked: "Next: pass overwatch trial --fixes, then press f.",
  ineligible: "Next: a new investigation or deployment; f checks again.", refused: "Nothing further for this finding.", verify_failed: "Next: a passing overwatch trial --fixes, then f.",
  stale: "Next: press f to try again on the current base.", declined: "Nothing further.", unresolved: "Next: press f once the host answers.",
};
/** A forecast or comparison without an answer, and what would give one. */
export function outlookNext(x) {
  if (!x) return null;
  if (x.samples !== undefined) return x.state === "forecast" ? null : x.state === "reached" ? "Reached: free or raise capacity." : `${x.reason ?? "No estimate"}. Next: ${x.state === "outside_horizon" ? "a faster rise would bring it inside 24 hours" : `${Math.max(1, 6 - (x.samples ?? 0))} more fresh, rising readings`}.`;
  return x.state === "unknown" ? `${x.reason ?? "Unknown"}. Next: two aligned, fully measured intervals after the next staging release.` : null;
}
