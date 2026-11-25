/**
 * The Overwatch command center: live inbox, focus workspace, search across the event log, service/OpenCode status,
 * archive, keyboard navigation, and the prompt bar.
 *
 * View logic and state transitions live here; presentation lives in `views.ts` and `style.css`.
 */
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Dom, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { IncidentId, ThreadId, threadIdOf } from "../../src/domain/ids.ts";
import { OverwatchApi } from "../../src/domain/model.ts";
import { ServiceStatus } from "../../src/domain/status.ts";
import { routePrompt } from "../../src/domain/route.ts";
import { SearchHit } from "../../src/domain/search.ts";
import { IncidentPageState, InboxItem, ThreadPageState } from "../../src/domain/views.ts";
import { renderDocument } from "./views.ts";

export const Client = DomainFoldkit.make(OverwatchApi);
/** What the page's Commands and Subscriptions need: the typed client. */
export type Services = (typeof OverwatchApi)["Client"]["Identifier"];
type Return = Update.Return<Model, Message, Services>;

export const Override = Schema.Literals(["auto", "new", "here"]);
export type Override = typeof Override.Type;

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
  sending: Schema.Record(Schema.String, Schema.Struct({ subject: Schema.String, text: Schema.String })),
  override: Override,
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
  ClickedArchive: { incidentId: IncidentId },
  ChangedEnvFilter: { filter: EnvFilter },
  ChangedSortOrder: { order: SortOrder },
  ChangedDraft: { text: Schema.String },
  ChangedOverride: { override: Override },
  SubmittedPrompt: {},
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
  PressedArchiveFocused: {},
  PressedJumpToPrompt: {},
  ClickedCopyQuery: { query: Schema.String },
  ClickedCopySummary: { runId: Schema.String, text: Schema.String },
  CompletedCopyQuery: {},
  CompletedDomEffect: {},
  ReceivedResult: { result: Client.Message },
});
export type Message = typeof Message.Type;

export const Flags = Schema.Struct({
  session: Schema.String,
  theme: Schema.optionalKey(Theme),
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
    override: "auto",
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

const CopyText = Command.define("CopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedCopyQuery],
  execute: ({ text }) =>
    Effect.tryPromise(async () => {
      const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText(v: string): Promise<void> } } }).navigator;
      if (nav?.clipboard) await nav.clipboard.writeText(text);
    }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedCopyQuery()),
    ),
});

const BlurActive = Command.define("BlurActive", {
  messages: [Message.CompletedDomEffect],
  execute: Effect.sync(() => {
    const doc = (globalThis as unknown as { document?: { activeElement?: { blur?: () => void } } }).document;
    doc?.activeElement?.blur?.();
    return Message.CompletedDomEffect();
  }),
});

/** Whether an environment name represents production tier. */
export function isProdEnv(environment: string): boolean {
  const lower = environment.toLowerCase();
  return lower === "prod" || lower === "production" || lower.startsWith("prod-") || lower.endsWith("-prod");
}

const SEVERITY_RANK: Record<string, number> = { error: 3, warn: 2, info: 1 };

/** Returns inbox items filtered and sorted according to the current view controls. */
/** How an environment reads on the fleet strip. Unknown and stale are their own states, never shown as quiet. */
export type EnvState = "failing" | "attention" | "unchecked" | "stale" | "unmeasured" | "quiet";

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

/** The fleet strip: one chip per watched environment, production first, from the service's status and the live inbox. */
export function environmentChips(model: Pick<Model, "status" | "inbox">): ReadonlyArray<EnvChip> {
  const status = model.status;
  if (!status) return [];
  const tierRank: Record<string, number> = { production: 0, staging: 1, development: 2 };
  return [...status.environments]
    .sort((a, b) => (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3) || a.app.localeCompare(b.app) || a.environment.localeCompare(b.environment))
    .map((env): EnvChip => {
      const open = model.inbox.filter((i) => i.app === env.app && i.environment === env.environment).length;
      const since = env.checkedThrough === null ? null : status.at - env.checkedThrough;
      const breaching = [env.notReadyPods, env.memoryPctOfLimit].some((m) => m?.state === "breach");
      const notMeasured = (m: typeof env.notReadyPods) => m === null || m.state === "unknown" || m.value === null;
      const missingReadings = env.expectsReadings
        ? [...(notMeasured(env.notReadyPods) ? ["readiness"] : []), ...(notMeasured(env.memoryPctOfLimit) ? ["memory"] : [])]
        : [];
      let state: EnvState;
      let label: string;
      if (env.lastError) {
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
      } else if (missingReadings.length > 0) {
        // Checked, but not everything was measured: never headlined as quiet.
        state = "unmeasured";
        label = `Checked, ${missingReadings.join(" and ")} not measured`;
      } else {
        state = "quiet";
        label = "Checked, quiet";
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

export function visibleInbox(model: Pick<Model, "inbox" | "envFilter" | "sortOrder">): ReadonlyArray<InboxItem> {
  const filtered =
    model.envFilter === "all"
      ? model.inbox
      : model.envFilter === "prod"
        ? model.inbox.filter((item) => isProdEnv(item.environment))
        : model.inbox.filter((item) => !isProdEnv(item.environment));

  return [...filtered].sort((a, b) => {
    if (model.sortOrder === "recent") return b.lastAt - a.lastAt;
    const sevDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sevDiff !== 0) return sevDiff;
    const prodDiff = (isProdEnv(b.environment) ? 1 : 0) - (isProdEnv(a.environment) ? 1 : 0);
    if (prodDiff !== 0) return prodDiff;
    return b.lastAt - a.lastAt;
  });
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
  if (model.page?.disposition === "archived") return "This incident is archived; its thread is closed.";
  const sessions = (model.thread?.sessions ?? []).map((s) => ({
    sessionId: s.sessionId,
    mode: "investigate" as const,
    status: s.status as "pending" | "running" | "idle" | "failed",
  }));
  const route = routePrompt(sessions, "investigate", model.override);
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
    },
    commands: [ScrollIntoView({ selector: `[data-incident="${incidentId}"]` })],
  };
}

function archiveIncident(model: Model, incidentId: IncidentId): Return {
  const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
  let nextFocus = model.focus;
  let nextPage = model.page;
  let nextThread = model.thread;
  if (model.focus === incidentId) {
    const list = visibleInbox(model);
    const idx = list.findIndex((i) => i.incidentId === incidentId);
    const remaining = list.filter((i) => i.incidentId !== incidentId);
    const nextItem = remaining.length === 0 ? null : (remaining[Math.min(idx < 0 ? 0 : idx, remaining.length - 1)] ?? null);
    nextFocus = nextItem ? nextItem.incidentId : null;
    nextPage = null;
    nextThread = null;
  }
  return {
    model: { ...model, commandIds, focus: nextFocus, page: nextPage, thread: nextThread, notice: null, copiedQuery: false, copiedSummary: null },
    commands: [
      Command.mapMessage(
        Client.ArchiveIncident({ target: incidentId, input: { actor: "owner (page)" }, commandId }),
        (result) => Message.ReceivedResult({ result }),
      ),
    ],
  };
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedInbox: ({ items }) => ({
      model: {
        ...model,
        inbox: items,
        live: true,
        connection: "live",
        notice: model.notice?.startsWith("Live updates stopped:") ? null : model.notice,
      },
    }),
    ReceivedPage: ({ page }) => ({ model: { ...model, page } }),
    ReceivedThread: ({ thread }) => ({ model: { ...model, thread } }),
    ReceivedStatus: ({ status }) => ({ model: { ...model, status, statusError: null } }),
    FailedStatus: ({ reason }) => ({ model: { ...model, statusError: reason } }),
    FailedRead: ({ reason }) => ({
      model: { ...model, live: false, connection: "offline", notice: `Live updates stopped: ${reason}` },
    }),
    ClickedItem: ({ incidentId }) => focusIncident(model, incidentId),
    ClickedArchive: ({ incidentId }) => archiveIncident(model, incidentId),
    ChangedEnvFilter: ({ filter }) => ({ model: { ...model, envFilter: filter } }),
    ChangedSortOrder: ({ order }) => ({ model: { ...model, sortOrder: order } }),
    ChangedDraft: ({ text }) => (model.focus ? { model: { ...model, drafts: { ...model.drafts, [model.focus]: text } } } : { model }),
    ChangedOverride: ({ override }) => ({ model: { ...model, override } }),
    SubmittedPrompt: () => {
      const draft = draftOf(model);
      if (!model.focus || !draft.trim() || isSending(model) || model.page?.disposition === "archived") return { model };
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      const title = model.page?.title ?? model.inbox.find((i) => i.incidentId === model.focus)?.title ?? model.focus;
      return {
        model: { ...model, commandIds, sending: { ...model.sending, [commandId]: { subject: model.focus, text: draft } }, notice: null },
        commands: [
          Command.mapMessage(
            Client.AskThread({
              target: threadIdOf(model.focus),
              input: {
                subject: model.focus,
                title,
                promptId: commandId,
                text: draft.trim(),
                mode: "investigate",
                origin: "page",
                override: model.override,
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
      if (model.searchOpen || model.statusOpen || model.shortcutsOpen) {
        return { model: { ...model, searchOpen: false, statusOpen: false, shortcutsOpen: false } };
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
      const list = visibleInbox(model);
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
    PressedArchiveFocused: () => {
      if (!model.focus || model.page?.disposition === "archived") return { model };
      return archiveIncident(model, model.focus);
    },
    PressedJumpToPrompt: () => {
      if (!model.focus || model.page?.disposition === "archived") return { model };
      return { model, commands: [FocusSelector({ selector: "#prompt-input" })] };
    },
    ClickedCopySummary: ({ runId, text }) => ({
      model: { ...model, copiedSummary: runId },
      commands: [CopyText({ text })],
    }),
    ClickedCopyQuery: ({ query }) => ({
      model: { ...model, copiedQuery: true },
      commands: [CopyText({ text: query })],
    }),
    CompletedCopyQuery: () => ({ model }),
    CompletedDomEffect: () => ({ model }),
    ReceivedResult: ({ result }) =>
      Client.Message.match(result, {
        SucceededArchiveIncident: () => ({ model }),
        FailedArchiveIncident: ({ failure }: { failure: { readonly _tag: string } }) => ({
          model: { ...model, notice: `Archive ${failureText(failure)}` },
        }),
        SucceededAskThread: ({ commandId }: { commandId: string }) => {
          const sent = model.sending[commandId];
          const { [commandId]: _, ...sending } = model.sending;
          if (!sent) return { model: { ...model, sending } };
          // Clear the draft only if it is still what was sent; anything typed since stays.
          const drafts = { ...model.drafts };
          if (drafts[sent.subject] === sent.text) delete drafts[sent.subject];
          return { model: { ...model, sending, drafts } };
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
    key: (model: Model) => (model.focus ?? "none") as IncidentId,
    isEnabled: (model) => model.focus !== null,
    toMessage: ({ state }): Message => Message.ReceivedPage({ page: Option.getOrNull(state) }),
    onFailure: (error): Message => Message.FailedRead({ reason: String((error as { _tag?: string })._tag ?? error) }),
    onDefect: (): Message => Message.FailedRead({ reason: "the connection to the service failed" }),
  }),
  thread: Client.ThreadPage.watch({
    key: (model: Model) => (model.focus ? threadIdOf(model.focus) : ThreadId.make("none")),
    isEnabled: (model) => model.focus !== null,
    toMessage: ({ state }): Message => Message.ReceivedThread({ thread: Option.getOrNull(state) }),
    onFailure: (error): Message => Message.FailedRead({ reason: String((error as { _tag?: string })._tag ?? error) }),
    onDefect: (): Message => Message.FailedRead({ reason: "the connection to the service failed" }),
  }),
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
        modalOpen: model.searchOpen || model.statusOpen || model.shortcutsOpen,
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
            { keys: "a", isEnabled: !modalOpen, mapEvent: () => Message.PressedArchiveFocused() },
            { keys: "e", isEnabled: !modalOpen, mapEvent: () => Message.PressedArchiveFocused() },
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
