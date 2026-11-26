/**
 * The Overwatch command center: the inbox grouped by why it needs the owner, three ways out (Done, Later, Never) with
 * undo, focus and the prompt bar, the environments strip, search, and keyboard navigation. Rows never move while the
 * owner looks: new arrivals wait behind a "new" line in their group until shown.
 *
 * View logic and state transitions live here; presentation lives in `views.ts` and `style.css`.
 */
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Command, Dom, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { IncidentId, ThreadId, threadIdOf } from "../../src/domain/ids.ts";
import { OverwatchApi } from "../../src/domain/model.ts";
import { ServiceStatus, type Cause } from "../../src/domain/status.ts";
import { MuteReason } from "../../src/domain/incident.ts";
import { routePrompt } from "../../src/domain/route.ts";
import { SearchHit } from "../../src/domain/search.ts";
import { IncidentPageState, InboxItem, ThreadPageState } from "../../src/domain/views.ts";
import { renderDocument } from "./views.ts";

export const Client = DomainFoldkit.make(OverwatchApi);
/** What the page's Commands and Subscriptions need: the typed client. */
export type Services = (typeof OverwatchApi)["Client"]["Identifier"];
type Return = Update.Return<Model, Message, Services>;


export const EnvFilter = Schema.Literals(["all", "prod", "preprod"]);
export type EnvFilter = typeof EnvFilter.Type;

export const SortOrder = Schema.Literals(["priority", "recent"]);
export type SortOrder = typeof SortOrder.Type;

export const Theme = Schema.Literals(["dark", "light"]);
export type Theme = typeof Theme.Type;

export const ConnectionState = Schema.Literals(["connecting", "live", "offline"]);
export type ConnectionState = typeof ConnectionState.Type;

export { ServiceStatus, WatcherStatus } from "../../src/domain/status.ts";

export const Model = Schema.Struct({
  commandIds: DomainFoldkit.CommandIds,
  live: Schema.Boolean,
  connection: ConnectionState,
  inbox: Schema.Array(InboxItem),
  envFilter: EnvFilter,
  sortOrder: SortOrder,
  focus: Schema.NullOr(IncidentId),
  page: Schema.NullOr(IncidentPageState),
  thread: Schema.NullOr(ThreadPageState),
  /** What the owner has typed, per incident: a draft stays with the incident it was typed on. */
  drafts: Schema.Record(Schema.String, Schema.String),
  /** Prompts sent and not yet acknowledged, by command id. The draft stays until its send is confirmed. */
  sending: Schema.Record(Schema.String, Schema.Struct({ subject: Schema.String, text: Schema.String, promptId: Schema.String })),
  /**
   * Each draft's prompt id, chosen when the draft is started and reused by every retry of the same text, so a send
   * whose acknowledgement was lost is not asked twice: the service ignores a prompt id it already has. `sent` is the
   * text last tried; editing it after a try makes a new prompt with a new id.
   */
  draftIds: Schema.Record(Schema.String, Schema.Struct({ promptId: Schema.String, sent: Schema.NullOr(Schema.String) })),
  notice: Schema.NullOr(Schema.String),
  status: Schema.NullOr(ServiceStatus),
  statusError: Schema.NullOr(Schema.String),
  statusOpen: Schema.Boolean,
  shortcutsOpen: Schema.Boolean,
  searchOpen: Schema.Boolean,
  searchQuery: Schema.String,
  searchLoading: Schema.Boolean,
  searchRequestId: Schema.NullOr(Schema.String),
  searchHits: Schema.Array(SearchHit),
  searchError: Schema.NullOr(Schema.String),
  searchSelected: Schema.Number,
  copiedQuery: Schema.Boolean,
  /** The finding (by run id) whose product summary was just copied. */
  copiedSummary: Schema.NullOr(Schema.String),
  theme: Theme,
  /** When the owner last looked at each incident (its `changedAt` then): what is new to them. Kept in the browser. */
  seen: Schema.Record(Schema.String, Schema.Number),
  /** The rows as shown, by group: they stay put until the owner asks for the new ones. Null until first arranged. */
  layout: Schema.NullOr(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Later or Never, asking one more thing before it is sent. */
  sheet: Schema.NullOr(
    Schema.Union([
      Schema.TaggedStruct("Later", { incidentId: IncidentId, text: Schema.String, error: Schema.NullOr(Schema.String) }),
      Schema.TaggedStruct("Never", { incidentId: IncidentId, reason: Schema.NullOr(MuteReason) }),
    ]),
  ),
  /** The last way out taken, which `u` undoes. */
  undo: Schema.NullOr(Schema.Struct({ incidentId: IncidentId, kind: Schema.String })),
  mutedOpen: Schema.Boolean,
  /** Working and Quiet are collapsed to a count unless opened. */
  expanded: Schema.Record(Schema.String, Schema.Boolean),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ReceivedInbox: { items: Schema.Array(InboxItem) },
  ReceivedPage: { page: Schema.NullOr(IncidentPageState) },
  ReceivedThread: { thread: Schema.NullOr(ThreadPageState) },
  ReceivedStatus: { status: ServiceStatus },
  FailedStatus: { reason: Schema.String },
  FailedRead: { reason: Schema.String },
  ClickedItem: { incidentId: IncidentId },
  /** A way out, from a key or a row's button: Done, Later or Never. Later and Never ask one thing first. */
  ChoseWayOut: { incidentId: IncidentId, kind: Schema.Literals(["done", "later", "never"]) },
  PressedWayOut: { kind: Schema.Literals(["done", "later", "never"]) },
  ChangedLaterText: { text: Schema.String },
  PressedLaterWorse: {},
  ClickedLaterWorse: { incidentId: IncidentId },
  ChoseMuteReason: { reason: Schema.NullOr(MuteReason) },
  ConfirmedSheet: {},
  /** Undo: the last way out, or the incident in focus if it has left the inbox. */
  PressedUndo: {},
  ClickedRestore: { incidentId: IncidentId },
  /** Shows the rows held behind the "new" lines, and sorts. */
  PressedShowNew: {},
  /** Another tab stored seen marks: they are merged in, so every tab agrees on what is new. */
  ReceivedSeen: { seen: Schema.Record(Schema.String, Schema.Number) },
  ToggledGroup: { group: Schema.String },
  ToggledMuted: {},
  ChangedEnvFilter: { filter: EnvFilter },
  ChangedSortOrder: { order: SortOrder },
  ChangedDraft: { text: Schema.String },
  /** Enter sends where the preview says; Shift+Enter sends in a new session. */
  SubmittedPrompt: { newSession: Schema.optionalKey(Schema.Boolean) },
  DismissedNotice: {},
  ToggledTheme: {},
  ToggledStatusPanel: {},
  ToggledShortcuts: {},
  OpenedSearch: {},
  ClosedOverlays: {},
  ChangedSearchQuery: { query: Schema.String },
  MovedSearchSelection: { delta: Schema.Number },
  ConfirmedSearchSelection: {},
  SelectedSearchHit: { hit: SearchHit },
  MovedFocus: { delta: Schema.Number },
  PressedJumpToPrompt: {},
  ClickedCopyQuery: { query: Schema.String },
  ClickedCopySummary: { runId: Schema.String, text: Schema.String },
  /** The clipboard took the text; `target` is "query" or the run id of a summary. */
  CompletedCopy: { target: Schema.String },
  FailedCopy: { reason: Schema.String },
  CompletedDomEffect: {},
  ReceivedResult: { result: Client.Message },
});
export type Message = typeof Message.Type;

export const Flags = Schema.Struct({
  session: Schema.String,
  theme: Schema.optionalKey(Theme),
  seen: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
});
export type Flags = typeof Flags.Type;

/** The draft for the incident in focus. */
export const draftOf = (model: Model): string => (model.focus ? (model.drafts[model.focus] ?? "") : "");
/** Whether a prompt on the incident in focus is on its way and not yet acknowledged. */
export const isSending = (model: Model): boolean => Object.values(model.sending).some((s) => s.subject === model.focus);

export const init = (flags: Flags): Return => ({
  model: {
    commandIds: { session: flags.session, sent: 0 },
    live: false,
    connection: "connecting",
    inbox: [],
    envFilter: "all",
    sortOrder: "priority",
    focus: null,
    page: null,
    thread: null,
    drafts: {},
    sending: {},
    draftIds: {},
    notice: null,
    status: null,
    statusError: null,
    statusOpen: false,
    shortcutsOpen: false,
    searchOpen: false,
    searchQuery: "",
    searchLoading: false,
    searchRequestId: null,
    searchHits: [],
    searchError: null,
    searchSelected: 0,
    copiedQuery: false,
    copiedSummary: null,
    theme: flags.theme ?? "dark",
    seen: flags.seen ?? {},
    layout: null,
    sheet: null,
    undo: null,
    mutedOpen: false,
    expanded: {},
  },
});

const FocusSelector = Command.define("FocusSelector", {
  args: { selector: Schema.String },
  messages: [Message.CompletedDomEffect],
  execute: ({ selector }) =>
    Dom.focus(selector).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedDomEffect()),
    ),
});

const ScrollIntoView = Command.define("ScrollIntoView", {
  args: { selector: Schema.String },
  messages: [Message.CompletedDomEffect],
  execute: ({ selector }) =>
    Dom.scrollIntoViewIfNotVisible(selector, { block: "nearest" }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedDomEffect()),
    ),
});

const SyncTheme = Command.define("SyncTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedDomEffect],
  execute: ({ theme }) =>
    Effect.sync(() => {
      const g = globalThis as unknown as {
        document?: { documentElement?: { dataset: Record<string, string> } };
        localStorage?: { setItem(k: string, v: string): void };
      };
      if (g.document?.documentElement) g.document.documentElement.dataset.theme = theme;
      try {
        g.localStorage?.setItem("overwatch.theme", theme);
      } catch {
        // Ignore storage restrictions.
      }
      return Message.CompletedDomEffect();
    }),
});

type Clipboard = { writeText(v: string): Promise<void> } | undefined;

/** Copies text and says whether it worked: a page without clipboard access, or a refused write, is a failure. */
export const copyToClipboard = (text: string, target: string, clipboard: Clipboard) =>
  Effect.tryPromise(async () => {
    if (!clipboard) throw new Error("this page has no clipboard access (it needs to be opened from 127.0.0.1)");
    await clipboard.writeText(text);
  }).pipe(
    Effect.as(Message.CompletedCopy({ target })),
    Effect.catch((error) => Effect.succeed(Message.FailedCopy({ reason: String((error as { cause?: unknown }).cause ?? error).replace(/^Error: /, "") }))),
  );

const CopyText = Command.define("CopyText", {
  args: { text: Schema.String, target: Schema.String },
  messages: [Message.CompletedCopy, Message.FailedCopy],
  execute: ({ text, target }) =>
    copyToClipboard(text, target, (globalThis as unknown as { navigator?: { clipboard?: Clipboard } }).navigator?.clipboard),
});

/**
 * Merges seen marks: for each incident the latest mark wins. Every tab in a browser shares one store, so a tab adds
 * what it learned to what is stored rather than writing its own copy over another tab's. Bounded to the newest 2,000.
 */
export function mergeSeen(stored: Record<string, number>, learned: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...stored };
  for (const [id, at] of Object.entries(learned)) if (!(merged[id]! >= at)) merged[id] = at;
  return Object.fromEntries(Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 2_000));
}

const readStoredSeen = (): Record<string, number> => {
  try {
    const parsed = JSON.parse((globalThis as unknown as { localStorage?: { getItem(k: string): string | null } }).localStorage?.getItem("overwatch.seen") ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
      : {};
  } catch {
    return {};
  }
};

/** Keeps what the owner has looked at in this browser: a convenience, so the page works without it. */
const SaveSeen = Command.define("SaveSeen", {
  args: { id: Schema.String, at: Schema.Number },
  messages: [Message.CompletedDomEffect],
  execute: ({ id, at }) =>
    Effect.sync(() => {
      try {
        const merged = mergeSeen(readStoredSeen(), { [id]: at });
        (globalThis as unknown as { localStorage?: { setItem(k: string, v: string): void } }).localStorage?.setItem("overwatch.seen", JSON.stringify(merged));
      } catch {
        // Private windows and blocked storage: the page still works, it only forgets.
      }
      return Message.CompletedDomEffect();
    }),
});

const BlurActive = Command.define("BlurActive", {
  messages: [Message.CompletedDomEffect],
  execute: Effect.sync(() => {
    const doc = (globalThis as unknown as { document?: { activeElement?: { blur?: () => void } } }).document;
    doc?.activeElement?.blur?.();
    return Message.CompletedDomEffect();
  }),
});

/**
 * The tier the service reports for an app's environment (its `tier` setting), never a guess from the name: an
 * environment called `live` can be production. Before the first status arrives the tier is unknown and counts as
 * production, so nothing that might be production is filtered out of view.
 */
export function isProduction(model: Pick<Model, "status">, item: { readonly app: string; readonly environment: string }): boolean {
  const env = model.status?.environments.find((e) => e.app === item.app && e.environment === item.environment);
  return (env?.tier ?? "production") === "production";
}

const SEVERITY_RANK: Record<string, number> = { error: 3, warn: 2, info: 1 };

/** Returns inbox items filtered and sorted according to the current view controls. */
/** How an environment reads on the fleet strip. Unknown and stale are their own states, never shown as quiet. */
export type EnvState = "suspended" | "failing" | "attention" | "unchecked" | "stale" | "unmeasured" | "quiet";

export interface EnvChip {
  readonly key: string;
  readonly app: string;
  readonly environment: string;
  readonly tier: string;
  readonly state: EnvState;
  /** What the state is, in words: the page never relies on colour alone. */
  readonly label: string;
  readonly details: ReadonlyArray<string>;
}

const age = (ms: number) => {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 48 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
};

/** An environment counts as stale once three of its polling intervals have passed without a full check. */
export const STALE_INTERVALS = 3;

type EnvStatus = ServiceStatus["environments"][number];

/** The readings an environment is expected to have and does not: never quiet while any is missing. */
export const missingReadings = (env: EnvStatus): string[] => {
  if (!env.expectsReadings) return [];
  const notMeasured = (m: EnvStatus["notReadyPods"]) => m === null || m.state === "unknown" || m.value === null;
  return [...(notMeasured(env.notReadyPods) ? ["readiness"] : []), ...(notMeasured(env.memoryPctOfLimit) ? ["memory"] : [])];
};

/**
 * Why an environment may not be called quiet, or nothing when it may. The one rule behind every "quiet" the page
 * says: not while it is suspended, failing, not yet checked or stale, over a limit, missing a reading it should have,
 * or has something open in the inbox.
 */
export function notQuietBecause(env: EnvStatus, statusAt: number, open: number): string | null {
  if (env.suspended) return "suspended";
  if (env.lastError) return "failing";
  if (env.checkedThrough === null) return "not checked yet";
  if (statusAt - env.checkedThrough > STALE_INTERVALS * env.everyMs) return "stale";
  if (open > 0) return "open";
  if ([env.notReadyPods, env.memoryPctOfLimit].some((m) => m?.state === "breach")) return "over a limit";
  if (missingReadings(env).length > 0) return "missing a reading";
  return null;
}

const openIn = (model: Pick<Model, "inbox">, env: { app: string; environment: string }) =>
  model.inbox.filter((i) => i.app === env.app && i.environment === env.environment && (i.disposition ?? "inbox") === "inbox").length;

/**
 * Whether the page may say "all quiet" (the all-clear). Only with a status in hand, no configuration errors, no cause
 * waiting on the owner, nothing in the inbox, and every environment quiet by `notQuietBecause`.
 */
export function allQuiet(model: Pick<Model, "status" | "inbox">): boolean {
  const status = model.status;
  if (!status || status.configErrors.length > 0 || status.causes.length > 0 || status.environments.length === 0) return false;
  if (model.inbox.some((i) => (i.disposition ?? "inbox") === "inbox")) return false;
  return status.environments.every((env) => notQuietBecause(env, status.at, openIn(model, env)) === null);
}

/** The fleet strip: one chip per watched environment, production first, from the service's status and the live inbox. */
export function environmentChips(model: Pick<Model, "status" | "inbox">): ReadonlyArray<EnvChip> {
  const status = model.status;
  if (!status) return [];
  const tierRank: Record<string, number> = { production: 0, staging: 1, development: 2 };
  return [...status.environments]
    .sort((a, b) => (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3) || a.app.localeCompare(b.app) || a.environment.localeCompare(b.environment))
    .map((env): EnvChip => {
      const open = openIn(model, env);
      const since = env.checkedThrough === null ? null : status.at - env.checkedThrough;
      const breaching = [env.notReadyPods, env.memoryPctOfLimit].some((m) => m?.state === "breach");
      const missing = missingReadings(env);
      let state: EnvState;
      let label: string;
      if (env.suspended) {
        // Not being read: never quiet, and its incidents neither resolve nor come back on data that was not read.
        state = "suspended";
        const last = env.checkedThrough ?? env.suspended.since;
        label = `Not checked since ${new Date(last).toISOString().slice(11, 16)} UTC (${env.suspended.words})`;
      } else if (env.lastError) {
        state = "failing";
        label = `Check failing: ${env.lastError.slice(0, 80)}`;
      } else if (since === null) {
        state = "unchecked";
        label = "Not checked yet";
      } else if (since > STALE_INTERVALS * env.everyMs) {
        state = "stale";
        label = `Not checked for ${age(since)}`;
      } else if (open > 0 || breaching) {
        state = "attention";
        label = open > 0 ? `${open} open` : "Over a limit";
      } else if (missing.length > 0) {
        // Checked, but not everything was measured: never headlined as quiet.
        state = "unmeasured";
        label = `Checked, ${missing.join(" and ")} not measured`;
      } else if (notQuietBecause(env, status.at, open) === null) {
        state = "quiet";
        label = "Checked, quiet";
      } else {
        // Anything the rule above refuses and no branch named: shown as not known, never as quiet.
        state = "unchecked";
        label = `Not quiet: ${notQuietBecause(env, status.at, open)}`;
      }
      const details: string[] = [];
      if (since !== null) details.push(`checked ${age(since)} ago`);
      const ready = env.notReadyPods;
      if (ready) details.push(ready.state === "unknown" || ready.value === null ? "readiness not measured" : ready.value === 0 ? "all pods ready" : `${ready.value} not ready`);
      const memory = env.memoryPctOfLimit;
      if (memory) details.push(memory.state === "unknown" || memory.value === null ? "memory not measured" : `memory ${Math.round(memory.value)}% of limit`);
      if (state !== "attention" && open > 0) details.push(`${open} open`);
      return { key: `${env.app}/${env.environment}`, app: env.app, environment: env.environment, tier: env.tier, state, label, details };
    });
}

/** Incidents in the inbox (no way out taken), filtered by tier and sorted. */
export function visibleInbox(model: Pick<Model, "inbox" | "envFilter" | "sortOrder" | "status">): ReadonlyArray<InboxItem> {
  const open = model.inbox.filter((item) => (item.disposition ?? "inbox") === "inbox");
  const filtered =
    model.envFilter === "all"
      ? open
      : model.envFilter === "prod"
        ? open.filter((item) => isProduction(model, item))
        : open.filter((item) => !isProduction(model, item));

  return [...filtered].sort((a, b) => {
    if (model.sortOrder === "recent") return b.lastAt - a.lastAt;
    const sevDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const prodDiff = (isProduction(model, b) ? 1 : 0) - (isProduction(model, a) ? 1 : 0);
    if (prodDiff !== 0) return prodDiff;
    return b.lastAt - a.lastAt;
  });
}

// ------------------------------------------------------------ the grouped inbox

export const GROUPS = ["needs", "new", "working", "quiet"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_TITLE: Record<Group, string> = { needs: "Needs you", new: "New", working: "Working", quiet: "Quiet" };
/** Groups shown as a count until opened. */
export const COLLAPSED: ReadonlyArray<Group> = ["working", "quiet"];

export type Row =
  | { readonly kind: "incident"; readonly id: string; readonly item: InboxItem; readonly why: string }
  | { readonly kind: "cause"; readonly id: string; readonly cause: Cause; readonly why: string };

const causeRowId = (cause: Cause) => `cause:${cause.id}`;

/**
 * Which group each row belongs in, and the one line saying why. Pure; the page's grouping is only this.
 *
 * - Needs you: a cause that stops Overwatch working (a suspended connection, offline, OpenCode down); anything that
 *   came back; a production incident whose finding says real or unsure, or whose investigation failed after its retry.
 * - Working: an agent is on it; nothing to do yet.
 * - New: arrived or changed (a finding, a rise in severity) since the owner last looked at it.
 * - Quiet: handled without the owner (the finding says not real), or already looked at and unchanged.
 *
 * A row is in the first of these that applies, in that order.
 */
export function groupInbox(model: Pick<Model, "inbox" | "status" | "seen" | "envFilter" | "sortOrder">): Record<Group, ReadonlyArray<Row>> {
  const groups: Record<Group, Row[]> = { needs: [], new: [], working: [], quiet: [] };
  for (const cause of model.status?.causes ?? []) groups.needs.push({ kind: "cause", id: causeRowId(cause), cause, why: cause.fix });
  for (const item of visibleInbox(model)) {
    const prod = isProduction(model, item);
    const seen = model.seen[item.incidentId];
    const row = (why: string): Row => ({ kind: "incident", id: item.incidentId, item, why });
    if (item.back) groups.needs.push(row(item.back));
    else if (prod && item.failure) groups.needs.push(row(`The investigation failed after a retry: ${item.failure}`));
    else if (prod && (item.verdict === "real" || item.verdict === "unsure")) groups.needs.push(row(`Production, and the finding says ${item.verdict}.`));
    else if (item.running > 0) groups.working.push(row("An agent is on it."));
    else if (item.verdict === "not_real") groups.quiet.push(row("Handled: the finding says it is not real."));
    else if (seen === undefined || seen < item.changedAt) groups.new.push(row(seen === undefined ? "New." : "Changed since you looked."));
    else groups.quiet.push(row(item.verdict ? `The finding says ${item.verdict}.` : "Nothing new since you looked."));
  }
  return groups;
}

/**
 * The inbox as shown. Rows stay where they were placed: one that changed updates in place, one that was dealt with
 * leaves, and one that arrived waits behind its group's "new" line until the owner shows them. A row that now belongs
 * in another group (it came back, say) stays where it is and is counted on that group's line. Before the first arrangement everything is shown as grouped.
 */
export function arrangedInbox(model: Pick<Model, "inbox" | "status" | "seen" | "envFilter" | "sortOrder" | "layout">): {
  readonly rows: Record<Group, ReadonlyArray<Row>>;
  readonly pending: Record<Group, number>;
} {
  const desired = groupInbox(model);
  const none = { needs: 0, new: 0, working: 0, quiet: 0 };
  if (!model.layout) return { rows: desired, pending: none };
  const byId = new Map(GROUPS.flatMap((g) => desired[g].map((row) => [row.id, row] as const)));
  const rows = {} as Record<Group, ReadonlyArray<Row>>;
  const pending = { ...none };
  for (const g of GROUPS) {
    rows[g] = (model.layout[g] ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    // Arrived, or now belongs here (a row that came back): counted on this group's line, shown where it is until then.
    pending[g] = desired[g].filter((row) => !(model.layout![g] ?? []).includes(row.id)).length;
  }
  return { rows, pending };
}

/** The layout that shows every row where it belongs now, sorted: what "show new" and returning to the page do. */
export const layoutOf = (model: Pick<Model, "inbox" | "status" | "seen" | "envFilter" | "sortOrder">): Record<string, ReadonlyArray<string>> => {
  const desired = groupInbox(model);
  return Object.fromEntries(GROUPS.map((g) => [g, desired[g].map((row) => row.id)]));
};

/** Rows in the order j and k move through: collapsed groups are skipped unless opened. */
export function navigableRows(model: Model): ReadonlyArray<Row> {
  const { rows } = arrangedInbox(model);
  return GROUPS.flatMap((g) => (COLLAPSED.includes(g) && !model.expanded[g] ? [] : rows[g]));
}

/** What the owner sees about a muted incident: its reason, how many it hid this week, and when it last did. */
export function mutedRows(model: Pick<Model, "inbox">, now: number) {
  const week = now - 7 * 24 * 3_600_000;
  return model.inbox
    .filter((item) => item.disposition === "never")
    .map((item) => ({
      item,
      hiddenThisWeek: item.hidden.reduce((sum, o) => (o.at > week ? sum + o.count : sum), 0),
      lastHiddenAt: item.hidden.length ? Math.max(...item.hidden.map((o) => o.at)) : null,
    }));
}

/**
 * A Done that keeps coming back was the wrong way out: after `offer.after` returns within `offer.withinMs` (3 in 14
 * days by default), its row offers Later until it gets worse, or Never. It offers; it does not apply either.
 */
export function bounceOffer(model: Pick<Model, "status">, item: InboxItem): number | null {
  const offer = model.status?.offer ?? { after: 3, withinMs: 14 * 24 * 3_600_000 };
  const now = model.status?.at ?? Math.max(item.lastAt, ...item.returns);
  const recent = item.returns.filter((at) => at > now - offer.withinMs).length;
  return recent >= offer.after ? recent : null;
}

/** How many occurrences Never would have hidden over the last 14 days: shown before it is confirmed. */
export const wouldHide = (item: InboxItem, now: number) => item.recent.reduce((sum, o) => (o.at > now - 14 * 24 * 3_600_000 ? sum + o.count : sum), 0);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * What the owner typed for Later: a duration ("30m", "2h", "2d", "1w"), "tomorrow" or a weekday (9:00 local time),
 * or nothing for "until something changes" (a new finding, a deploy in its environment).
 */
export type LaterChoice = { until: number; label: string } | { until: null; waitsFor: "change" | "worse"; label: string };

export function parseLater(text: string, now: number): LaterChoice | { error: string } {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "change" || t === "until change" || t === "until something changes") return { until: null, waitsFor: "change", label: "until something changes" };
  if (t === "worse" || t === "until worse" || t === "until it gets worse") return { until: null, waitsFor: "worse", label: "until it gets worse" };
  const duration = /^(\d+)\s*(m|h|d|w)$/.exec(t);
  if (duration) return { until: now + Number(duration[1]) * UNIT[duration[2]!]!, label: t.replace(/\s+/g, "") };
  const morning = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  if (t === "tomorrow") return { until: morning(1), label: "tomorrow" };
  const day = WEEKDAYS.findIndex((name) => name === t || name.slice(0, 3) === t);
  if (day >= 0) {
    const ahead = (day - new Date(now).getDay() + 7) % 7 || 7;
    return { until: morning(ahead), label: WEEKDAYS[day]! };
  }
  return { error: 'Type 2h, 2d, tomorrow or monday; "worse" for until it gets worse; or leave it empty for until something changes.' };
}

/** Resolves an incident id from any search hit (incident, finding, thread, or prompt). */
export function incidentIdFromHit(hit: SearchHit): IncidentId | null {
  if (hit.kind === "incident" || hit.kind === "finding") return IncidentId.make(hit.id);
  if (hit.id.startsWith("thr_")) return IncidentId.make(hit.id.slice(4));
  if (hit.id.startsWith("inc_")) return IncidentId.make(hit.id);
  return null;
}

/** What the prompt bar will do if sent now: the same pure function the Thread aggregate applies. */
export function preview(model: Model): string {
  if (!model.focus) return "Put an incident in focus to prompt on it.";
  const sessions = (model.thread?.sessions ?? []).map((s) => ({
    sessionId: s.sessionId,
    mode: "investigate" as const,
    status: s.status as "pending" | "running" | "idle" | "failed",
  }));
  const route = routePrompt(sessions, "investigate", "auto");
  return route.kind === "new" ? `new session: ${route.reason}` : `continues ${route.sessionId}: ${route.reason}`;
}

const failureText = (failure: { readonly _tag: string }) =>
  failure._tag === "Rejected" ? "refused" : failure._tag === "Denied" ? "not allowed" : "not confirmed; try again";

function focusIncident(model: Model, incidentId: IncidentId): Return {
  if (model.focus === incidentId) {
    return {
      model: { ...model, searchOpen: false, statusOpen: false, shortcutsOpen: false },
    };
  }
  // Looking at it is what makes it no longer new to the owner.
  const item = model.inbox.find((i) => i.incidentId === incidentId);
  const kept = Object.fromEntries(Object.entries(model.seen).filter(([id]) => model.inbox.some((i) => i.incidentId === id)));
  const seen = item && model.seen[incidentId] !== item.changedAt ? { ...kept, [incidentId]: item.changedAt } : model.seen;
  return {
    model: {
      ...model,
      focus: incidentId,
      page: null,
      thread: null,
      copiedQuery: false,
      searchOpen: false,
      statusOpen: false,
      shortcutsOpen: false,
      mutedOpen: false,
      seen,
    },
    commands: [ScrollIntoView({ selector: `[data-incident="${incidentId}"]` }), ...(item && seen !== model.seen ? [SaveSeen({ id: incidentId, at: item.changedAt })] : [])],
  };
}

const WAY_WORD = { done: "Done", later: "Later", never: "Never" } as const;
const ACTOR = "owner (page)";

/** Focus moves to the next row in the order shown, or the one before when it was the last. */
function advanceFrom(model: Model, incidentId: string): Model {
  if (model.focus !== incidentId) return model;
  const rows = navigableRows(model).filter((row) => row.kind === "incident");
  const idx = rows.findIndex((row) => row.id === incidentId);
  const rest = rows.filter((row) => row.id !== incidentId);
  const next = rest.length === 0 ? null : (rest[Math.min(idx < 0 ? 0 : idx, rest.length - 1)] ?? null);
  return { ...model, focus: next ? IncidentId.make(next.id) : null, page: null, thread: null, copiedQuery: false, copiedSummary: null };
}

/** Sends a way out. Done goes at once; Later and Never are sent from their sheet. Each says so, with Undo. */
function sendWayOut(model: Model, incidentId: IncidentId, way: "done" | "later" | "never", input: Record<string, unknown>, label: string): Return {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  const command =
    way === "done"
      ? Client.MarkDone({ target: incidentId, input: { actor: ACTOR, ...input }, commandId })
      : way === "later"
        ? Client.Defer({ target: incidentId, input: { actor: ACTOR, ...input }, commandId })
        : Client.Mute({ target: incidentId, input: { actor: ACTOR, ...input }, commandId });
  const next = advanceFrom({ ...model, commandIds, sheet: null }, incidentId);
  return {
    model: { ...next, undo: { incidentId, kind: way }, notice: `${label}. Press u to undo.` },
    commands: [Command.mapMessage(command as never, (result) => Message.ReceivedResult({ result: result as never }))],
  };
}

function chooseWayOut(model: Model, incidentId: IncidentId, way: "done" | "later" | "never"): Return {
  if (way === "done") return sendWayOut(model, incidentId, "done", {}, "Done");
  if (way === "later") return { model: { ...model, sheet: { _tag: "Later", incidentId, text: "", error: null } }, commands: [FocusSelector({ selector: "#later-input" })] };
  return { model: { ...model, sheet: { _tag: "Never", incidentId, reason: null } } };
}

function restore(model: Model, incidentId: IncidentId): Return {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  return {
    model: { ...model, commandIds, undo: null, notice: "Put back in the inbox." },
    commands: [Command.mapMessage(Client.Restore({ target: incidentId, input: { actor: ACTOR }, commandId }), (result) => Message.ReceivedResult({ result }))],
  };
}

/** The clock for Later and the Never preview: the service's, from its last status, else the browser's. */
const nowOf = (model: Model) => model.status?.at ?? Date.now();

/**
 * Fixes the layout when the inbox first arrives; rows stay put from then on. While no row is shown at all nothing can
 * move, so what arrives then is shown at once rather than held behind a "new" line.
 */
const settleLayout = (model: Model): Model => {
  if (!model.live) return model;
  const nothingShown = model.layout === null || GROUPS.every((g) => arrangedInbox(model).rows[g].length === 0);
  return nothingShown ? { ...model, layout: layoutOf(model) } : model;
};

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedInbox: ({ items }) => ({
      model: settleLayout({
        ...model,
        inbox: items,
        live: true,
        connection: "live",
        notice: model.notice?.startsWith("Live updates stopped:") ? null : model.notice,
      }),
    }),
    ReceivedPage: ({ page }) => ({ model: { ...model, page } }),
    ReceivedThread: ({ thread }) => ({ model: { ...model, thread } }),
    // The first status brings the tiers (and any causes): the one moment, at start, that rows are arranged again.
    ReceivedStatus: ({ status }) => {
      const next = { ...model, status, statusError: null };
      return { model: model.status === null && model.layout !== null ? { ...next, layout: layoutOf(next) } : next };
    },
    FailedStatus: ({ reason }) => ({ model: { ...model, statusError: reason } }),
    FailedRead: ({ reason }) => ({
      model: { ...model, live: false, connection: "offline", notice: `Live updates stopped: ${reason}` },
    }),
    ClickedItem: ({ incidentId }) => focusIncident(model, incidentId),
    ChoseWayOut: ({ incidentId, kind }) => chooseWayOut(model, incidentId, kind),
    PressedWayOut: ({ kind }) => {
      const item = model.focus ? model.inbox.find((i) => i.incidentId === model.focus) : undefined;
      if (!item || item.disposition !== "inbox") return { model };
      return chooseWayOut(model, item.incidentId, kind);
    },
    ChangedLaterText: ({ text }) => (model.sheet?._tag === "Later" ? { model: { ...model, sheet: { ...model.sheet, text, error: null } } } : { model }),
    ChoseMuteReason: ({ reason }) => (model.sheet?._tag === "Never" ? { model: { ...model, sheet: { ...model.sheet, reason } } } : { model }),
    ConfirmedSheet: () => {
      const sheet = model.sheet;
      if (!sheet) return { model };
      if (sheet._tag === "Never") return sendWayOut(model, sheet.incidentId, "never", sheet.reason ? { reason: sheet.reason } : {}, `Never${sheet.reason ? ` (${sheet.reason})` : ""}`);
      const parsed = parseLater(sheet.text, nowOf(model));
      if ("error" in parsed) return { model: { ...model, sheet: { ...sheet, error: parsed.error } } };
      return sendWayOut(model, sheet.incidentId, "later", parsed.until === null ? { waitsFor: parsed.waitsFor, label: parsed.label } : { until: parsed.until, label: parsed.label }, `Later: ${parsed.label}`);
    },
    // One key for "I know about this level; tell me if it grows". Offered on a Done that keeps coming back.
    PressedLaterWorse: () => {
      const item = model.focus ? model.inbox.find((i) => i.incidentId === model.focus) : undefined;
      if (!item || item.disposition !== "inbox") return { model };
      return sendWayOut(model, item.incidentId, "later", { waitsFor: "worse", label: "until it gets worse" }, "Later: until it gets worse");
    },
    ClickedLaterWorse: ({ incidentId }) => sendWayOut(model, incidentId, "later", { waitsFor: "worse", label: "until it gets worse" }, "Later: until it gets worse"),
    PressedUndo: () => {
      if (model.undo) return restore(model, model.undo.incidentId);
      const item = model.focus ? model.inbox.find((i) => i.incidentId === model.focus) : undefined;
      return item && item.disposition !== "inbox" ? restore(model, item.incidentId) : { model };
    },
    ClickedRestore: ({ incidentId }) => restore(model, incidentId),
    PressedShowNew: () => ({ model: { ...model, layout: layoutOf(model) } }),
    ReceivedSeen: ({ seen }) => ({ model: { ...model, seen: mergeSeen(model.seen, seen) } }),
    ToggledGroup: ({ group }) => ({ model: { ...model, expanded: { ...model.expanded, [group]: !model.expanded[group] } } }),
    ToggledMuted: () => ({ model: { ...model, mutedOpen: !model.mutedOpen, searchOpen: false, statusOpen: false, shortcutsOpen: false } }),
    ChangedEnvFilter: ({ filter }) => ({ model: { ...model, envFilter: filter } }),
    ChangedSortOrder: ({ order }) => ({ model: { ...model, sortOrder: order } }),
    ChangedDraft: ({ text }) => {
      if (!model.focus) return { model };
      const current = model.draftIds[model.focus];
      const fresh = !current || (current.sent !== null && current.sent !== text.trim());
      if (!fresh) return { model: { ...model, drafts: { ...model.drafts, [model.focus]: text } } };
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: {
          ...model,
          commandIds,
          drafts: { ...model.drafts, [model.focus]: text },
          draftIds: { ...model.draftIds, [model.focus]: { promptId: `prompt:${commandId}`, sent: null } },
        },
      };
    },
    SubmittedPrompt: ({ newSession }) => {
      const draft = draftOf(model);
      if (!model.focus || !draft.trim() || isSending(model)) return { model };
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      const title = model.page?.title ?? model.inbox.find((i) => i.incidentId === model.focus)?.title ?? model.focus;
      const known = model.draftIds[model.focus];
      // The same text again reuses the draft's id; a draft whose id is unknown (or whose text changed since a try) gets one now.
      const promptId = known && (known.sent === null || known.sent === draft.trim()) ? known.promptId : `prompt:${commandId}`;
      return {
        model: {
          ...model,
          commandIds,
          sending: { ...model.sending, [commandId]: { subject: model.focus, text: draft, promptId } },
          draftIds: { ...model.draftIds, [model.focus]: { promptId, sent: draft.trim() } },
          notice: null,
        },
        commands: [
          Command.mapMessage(
            Client.AskThread({
              target: threadIdOf(model.focus),
              input: {
                subject: model.focus,
                title,
                promptId,
                text: draft.trim(),
                mode: "investigate",
                origin: "page",
                // Sessions are workers the owner does not manage: Overwatch routes, Shift+Enter asks for a new one.
                override: newSession === true ? "new" : "auto",
              },
              commandId,
            }),
            (result) => Message.ReceivedResult({ result }),
          ),
        ],
      };
    },
    DismissedNotice: () => ({ model: { ...model, notice: null } }),
    ToggledTheme: () => {
      const theme: Theme = model.theme === "dark" ? "light" : "dark";
      return { model: { ...model, theme }, commands: [SyncTheme({ theme })] };
    },
    ToggledStatusPanel: () => ({
      model: { ...model, statusOpen: !model.statusOpen, searchOpen: false, shortcutsOpen: false },
    }),
    ToggledShortcuts: () => ({
      model: { ...model, shortcutsOpen: !model.shortcutsOpen, searchOpen: false, statusOpen: false },
    }),
    OpenedSearch: () => ({
      model: { ...model, searchOpen: true, statusOpen: false, shortcutsOpen: false, searchSelected: 0 },
      commands: [FocusSelector({ selector: "#search-input" })],
    }),
    ClosedOverlays: () => {
      if (model.searchOpen || model.statusOpen || model.shortcutsOpen || model.mutedOpen || model.sheet) {
        return { model: { ...model, searchOpen: false, statusOpen: false, shortcutsOpen: false, mutedOpen: false, sheet: null } };
      }
      return { model, commands: [BlurActive()] };
    },
    ChangedSearchQuery: ({ query }) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return {
          model: {
            ...model,
            searchQuery: query,
            searchHits: [],
            searchLoading: false,
            searchError: null,
            searchRequestId: null,
            searchSelected: 0,
          },
        };
      }
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: {
          ...model,
          commandIds,
          searchQuery: query,
          searchLoading: true,
          searchError: null,
          searchRequestId: commandId,
          searchSelected: 0,
        },
        commands: [
          Command.mapMessage(
            Client.Search({ input: { text: trimmed, limit: 25 }, requestId: commandId }),
            (result) => Message.ReceivedResult({ result }),
          ),
        ],
      };
    },
    MovedSearchSelection: ({ delta }) => {
      if (model.searchHits.length === 0) return { model };
      const next = (model.searchSelected + delta + model.searchHits.length) % model.searchHits.length;
      return { model: { ...model, searchSelected: next } };
    },
    ConfirmedSearchSelection: () => {
      const hit = model.searchHits[model.searchSelected];
      if (!hit) return { model };
      const target = incidentIdFromHit(hit);
      if (!target) return { model: { ...model, searchOpen: false } };
      return focusIncident(model, target);
    },
    SelectedSearchHit: ({ hit }) => {
      const target = incidentIdFromHit(hit);
      if (!target) return { model: { ...model, searchOpen: false } };
      return focusIncident(model, target);
    },
    MovedFocus: ({ delta }) => {
      const list = navigableRows(model).flatMap((row) => (row.kind === "incident" ? [row.item] : []));
      if (list.length === 0) return { model };
      const currentIdx = model.focus ? list.findIndex((i) => i.incidentId === model.focus) : -1;
      const nextIdx =
        currentIdx < 0
          ? delta >= 0
            ? 0
            : list.length - 1
          : Math.max(0, Math.min(list.length - 1, currentIdx + delta));
      const target = list[nextIdx];
      return target ? focusIncident(model, target.incidentId) : { model };
    },
    PressedJumpToPrompt: () => {
      if (!model.focus) return { model };
      return { model, commands: [FocusSelector({ selector: "#prompt-input" })] };
    },
    ClickedCopySummary: ({ runId, text }) => ({ model, commands: [CopyText({ text, target: runId })] }),
    ClickedCopyQuery: ({ query }) => ({ model, commands: [CopyText({ text: query, target: "query" })] }),
    // "Copied" only once the clipboard took it; a failure says so and how to copy by hand.
    CompletedCopy: ({ target }) => ({
      model: target === "query" ? { ...model, copiedQuery: true } : { ...model, copiedSummary: target },
    }),
    FailedCopy: ({ reason }) => ({
      model: { ...model, copiedQuery: false, copiedSummary: null, notice: `Could not copy: ${reason}. Select the text and copy it by hand.` },
    }),
    CompletedDomEffect: () => ({ model }),
    ReceivedResult: ({ result }) =>
      Client.Message.match(result, {
        SucceededMarkDone: () => ({ model }),
        SucceededDefer: () => ({ model }),
        SucceededMute: () => ({ model }),
        SucceededRestore: () => ({ model }),
        FailedMarkDone: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, undo: null, notice: `Done ${failureText(failure)}` } }),
        FailedDefer: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, undo: null, notice: `Later ${failureText(failure)}` } }),
        FailedMute: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, undo: null, notice: `Never ${failureText(failure)}` } }),
        FailedRestore: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, notice: `Undo ${failureText(failure)}` } }),
        SucceededAskThread: ({ commandId }: { commandId: string }) => {
          const sent = model.sending[commandId];
          const { [commandId]: _, ...sending } = model.sending;
          if (!sent) return { model: { ...model, sending } };
          // Clear the draft only if it is still what was sent; anything typed since stays.
          const drafts = { ...model.drafts };
          const draftIds = { ...model.draftIds };
          if (drafts[sent.subject] === sent.text) delete drafts[sent.subject];
          if (draftIds[sent.subject]?.promptId === sent.promptId) delete draftIds[sent.subject];
          return { model: { ...model, sending, drafts, draftIds } };
        },
        FailedAskThread: ({ commandId, failure }: { commandId: string; failure: { readonly _tag: string } }) => {
          const { [commandId]: _, ...sending } = model.sending;
          return { model: { ...model, sending, notice: `Prompt ${failureText(failure)}; your text is still in the prompt bar` } };
        },
        SucceededSearch: ({ requestId, result: hits }: { requestId: string; result: ReadonlyArray<SearchHit> }) => {
          if (requestId !== model.searchRequestId) return { model };
          return {
            model: { ...model, searchLoading: false, searchHits: hits, searchError: null, searchSelected: 0 },
          };
        },
        FailedSearch: ({ requestId, failure }: { requestId: string; failure: { readonly _tag: string } }) => {
          if (requestId !== model.searchRequestId) return { model };
          return {
            model: { ...model, searchLoading: false, searchError: `Search ${failureText(failure)}` },
          };
        },
      } as never) as Return,
  });

const decodeStatus = Schema.decodeUnknownSync(ServiceStatus);

const pollStatusOnce: Effect.Effect<Message> = Effect.tryPromise(async () => {
  const response = await fetch("/status");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw = await response.json();
  return decodeStatus(raw);
}).pipe(
  Effect.map((status): Message => Message.ReceivedStatus({ status })),
  Effect.catch((error) =>
    Effect.succeed(Message.FailedStatus({ reason: error instanceof Error ? error.message : "Service status unavailable" })),
  ),
);

export const subscriptions = Subscription.make<Model, Message, Services>()((entry) => ({
  inbox: Client.Inbox.watch({
    key: () => "inbox",
    toMessage: ({ state }): Message =>
      Message.ReceivedInbox({ items: Option.match(state, { onNone: () => [], onSome: (s) => s.items }) }),
    onFailure: (error): Message => Message.FailedRead({ reason: String((error as { _tag?: string })._tag ?? error) }),
    onDefect: (): Message => Message.FailedRead({ reason: "the connection to the service failed" }),
  }),
  page: Client.IncidentPage.watch({
    key: (model: Model) => model.focus ?? IncidentId.make("inc_none"),
    isEnabled: (model) => model.focus !== null,
    toMessage: ({ state }): Message => Message.ReceivedPage({ page: Option.getOrNull(state) }),
    onFailure: (error): Message => Message.FailedRead({ reason: String((error as { _tag?: string })._tag ?? error) }),
    onDefect: (): Message => Message.FailedRead({ reason: "the connection to the service failed" }),
  }),
  thread: Client.ThreadPage.watch({
    key: (model: Model) => (model.focus ? threadIdOf(model.focus) : ThreadId.make("thr_none")),
    isEnabled: (model) => model.focus !== null,
    toMessage: ({ state }): Message => Message.ReceivedThread({ thread: Option.getOrNull(state) }),
    onFailure: (error): Message => Message.FailedRead({ reason: String((error as { _tag?: string })._tag ?? error) }),
    onDefect: (): Message => Message.FailedRead({ reason: "the connection to the service failed" }),
  }),
  // Coming back to the page shows what arrived meanwhile, sorted: the one other moment rows may move.
  returned: Subscription.persistentEntry(
    (() => {
      const doc = (globalThis as unknown as { document?: { addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void; visibilityState?: string } }).document;
      if (!doc) return Stream.empty;
      return Stream.callback<Message>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = () => {
              if (doc.visibilityState === "visible") Queue.offerUnsafe(queue, Message.PressedShowNew());
            };
            doc.addEventListener("visibilitychange", listener);
            return listener;
          }),
          (listener) => Effect.sync(() => doc.removeEventListener("visibilitychange", listener)),
        ),
      );
    })(),
  ),
  otherTabs: Subscription.persistentEntry(
    (() => {
      const win = (globalThis as unknown as { addEventListener?: (t: string, f: (e: { key: string | null }) => void) => void; removeEventListener?: (t: string, f: (e: { key: string | null }) => void) => void }).addEventListener
        ? (globalThis as unknown as { addEventListener: (t: string, f: (e: { key: string | null }) => void) => void; removeEventListener: (t: string, f: (e: { key: string | null }) => void) => void })
        : undefined;
      if (!win || !(globalThis as { document?: unknown }).document) return Stream.empty;
      return Stream.callback<Message>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (e: { key: string | null }) => {
              if (e.key === "overwatch.seen") Queue.offerUnsafe(queue, Message.ReceivedSeen({ seen: readStoredSeen() }));
            };
            win.addEventListener("storage", listener);
            return listener;
          }),
          (listener) => Effect.sync(() => win.removeEventListener("storage", listener)),
        ),
      );
    })(),
  ),
  statusPoll: Subscription.persistentEntry(
    Stream.concat(
      Stream.fromEffect(pollStatusOnce),
      Stream.tick(Duration.seconds(5)).pipe(Stream.mapEffect(() => pollStatusOnce)),
    ),
  ),
  keyBindings: entry(
    { searchOpen: Schema.Boolean, modalOpen: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        searchOpen: model.searchOpen,
        modalOpen: model.searchOpen || model.statusOpen || model.shortcutsOpen || model.mutedOpen || model.sheet !== null,
      }),
      dependenciesToStream: ({ searchOpen, modalOpen }) =>
        Dom.streamFromKeyBindings<Message>({
          bindings: [
            { keys: "Mod+K", whileTyping: "Allow", mapEvent: () => Message.OpenedSearch() },
            { keys: "/", isEnabled: !modalOpen, mapEvent: () => Message.OpenedSearch() },
            { keys: "Escape", whileTyping: "Allow", mapEvent: () => Message.ClosedOverlays() },
            { keys: "?", isEnabled: !searchOpen, mapEvent: () => Message.ToggledShortcuts() },
            { keys: "j", isEnabled: !modalOpen, whenRepeated: "Allow", mapEvent: () => Message.MovedFocus({ delta: 1 }) },
            { keys: "ArrowDown", isEnabled: !modalOpen, whenRepeated: "Allow", mapEvent: () => Message.MovedFocus({ delta: 1 }) },
            { keys: "k", isEnabled: !modalOpen, whenRepeated: "Allow", mapEvent: () => Message.MovedFocus({ delta: -1 }) },
            { keys: "ArrowUp", isEnabled: !modalOpen, whenRepeated: "Allow", mapEvent: () => Message.MovedFocus({ delta: -1 }) },
            { keys: "d", isEnabled: !modalOpen, mapEvent: () => Message.PressedWayOut({ kind: "done" }) },
            { keys: "l", isEnabled: !modalOpen, mapEvent: () => Message.PressedWayOut({ kind: "later" }) },
            { keys: "n", isEnabled: !modalOpen, mapEvent: () => Message.PressedWayOut({ kind: "never" }) },
            { keys: "u", isEnabled: !modalOpen, mapEvent: () => Message.PressedUndo() },
            { keys: "w", isEnabled: !modalOpen, mapEvent: () => Message.PressedLaterWorse() },
            { keys: "r", isEnabled: !modalOpen, mapEvent: () => Message.PressedShowNew() },
            { keys: "m", isEnabled: !searchOpen, mapEvent: () => Message.ToggledMuted() },
            { keys: "p", isEnabled: !modalOpen, mapEvent: () => Message.PressedJumpToPrompt() },
            { keys: "Enter", isEnabled: !modalOpen, mapEvent: () => Message.PressedJumpToPrompt() },
            { keys: "1", isEnabled: !modalOpen, mapEvent: () => Message.ChangedEnvFilter({ filter: "all" }) },
            { keys: "2", isEnabled: !modalOpen, mapEvent: () => Message.ChangedEnvFilter({ filter: "prod" }) },
            { keys: "3", isEnabled: !modalOpen, mapEvent: () => Message.ChangedEnvFilter({ filter: "preprod" }) },
            { keys: "t", isEnabled: !modalOpen, mapEvent: () => Message.ToggledTheme() },
            { keys: "ArrowDown", isEnabled: searchOpen, whileTyping: "Allow", whenRepeated: "Allow", mapEvent: () => Message.MovedSearchSelection({ delta: 1 }) },
            { keys: "ArrowUp", isEnabled: searchOpen, whileTyping: "Allow", whenRepeated: "Allow", mapEvent: () => Message.MovedSearchSelection({ delta: -1 }) },
            { keys: "Enter", isEnabled: searchOpen, whileTyping: "Allow", mapEvent: () => Message.ConfirmedSearchSelection() },
          ],
        }),
    },
  ),
}));

export const view = (model: Model, h: HtmlBuilder<Message>): Document => renderDocument(model, h, preview(model));
