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
    r: "refresh", p: "prompt", Enter: "prompt", t: "theme", "?": "help", o: "expand",
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
