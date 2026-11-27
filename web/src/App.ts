/**
 * The page: renders what the service decided and sends the owner's commands. It keeps its own clock for staleness
 * (a one-second tick comparing wall and monotonic time with the last time it heard the service), freezes row
 * positions while the owner looks, and never generates identifiers or decides groups.
 *
 * Foldkit (0.171) is the view layer and runtime; Effect is everything else. What is Foldkit's, and its Effect UI
 * counterpart for a move back:
 *
 * | Here (Foldkit)                                              | Effect UI                                          |
 * | ----------------------------------------------------------- | -------------------------------------------------- |
 * | `Runtime.makeApplication` + `Runtime.run` (`entry.ts`), Flags | `BrowserHost.mount(App, props)`, `AppProps`        |
 * | `resources` Layer for Commands and Subscriptions             | `Component.provide(AppLayer)`                      |
 * | `view(model, h)` returning a `Document` (title)              | `view` + `head` (`Head.title`)                     |
 * | `document` Subscription writing `data-link` / `data-theme`   | `HtmlHead.bodyData` / `HtmlHead.htmlData`          |
 * | Submodel: `defineView` + `h.submodel` + `Update.foldChild`   | `Html.component` with `props`, `onEmit`            |
 * | a child's `Events` union as its OutMessage                   | `events` + `$.emit`                                |
 * | `Command.define(name, { args, messages, execute })`          | `Command.Service` / `Command.make`                  |
 * | `ReadItem`, `LoadTarget`, `LoadBrief`, `Search` Commands     | `Query.Service` (GetItem, GetFocus, GetBrief, ...) |
 * | token args (`n`) on `WaitBeforeSeen` / `WaitBeforeDismissal`  | `mode: "switch"`                                   |
 * | `Subscription.make` / `persistentEntry`, `Dom.streamFrom...`  | `Subscription.make`, `HtmlSubscription.onDocument` |
 * | `Mount.define` / `defineStream` (`ShowSheet`, `KeepBar`, ...) | `Mount.make` / `Mount.makeStream`                  |
 * | native modal `<dialog>` (`components/Sheet.ts`)             | `@effect/ui-kit` `Dialog`                          |
 * | `aria-expanded` group buttons (`components/Inbox.ts`)        | `@effect/ui-kit` `Collapsible`                     |
 * | `foldkit` Story (`web/test/app.test.ts`)                     | `@effect/ui/testing` Story                         |
 *
 * Components reach Foldkit only through `ui.ts`. `domain/`, `services/` and `model.ts` know no view layer.
 */
import { BrowserKeyValueStore, Clipboard } from "@effect/platform-browser";
import { Clock, Duration, Effect, Layer, Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import type { Document } from "foldkit/html";
import { KeyValueStore } from "effect/persistence";
import { freshness, silence } from "../freshness.mjs";
import * as Banners from "./components/Banners.ts";
import * as BriefSheet from "./components/BriefSheet.ts";
import * as CorrectSheet from "./components/CorrectSheet.ts";
import * as Dock from "./components/Dock.ts";
import * as Finder from "./components/Finder.ts";
import { KeyboardIcon, ThemeIcon } from "./components/Glyphs.ts";
import * as Inbox from "./components/Inbox.ts";
import * as KeysSheet from "./components/KeysSheet.ts";
import * as Stage from "./components/Stage.ts";
import * as Strip from "./components/Strip.ts";
import * as WayOutSheet from "./components/WayOutSheet.ts";
import { Decided, ItemDetail, Published, Sample, Snapshot, WayOutBody } from "./domain/Overwatch.ts";
import * as m from "./model.ts";
import { type ActionBody, Overwatch, ServiceEvents } from "./services/Overwatch.ts";
import { PageWindow } from "./services/PageWindow.ts";
import { Command, Dom, el, type H, Option, TaggedEnum, TaggedUnion, Update } from "./ui.ts";

// ---------------------------------------------------------------- model

export const Theme = Schema.Literals(["light", "dark"]);
export type Theme = typeof Theme.Type;
const Rows = Schema.Array(Schema.String);
export const Shown = Schema.Struct({ needsYou: Rows, new: Rows, working: Rows, quiet: Rows });
export const Collapsed = Schema.Struct({ needsYou: Schema.Boolean, new: Schema.Boolean, working: Schema.Boolean, quiet: Schema.Boolean });
export type Collapsed = typeof Collapsed.Type;
const Command_ = Schema.Literals([
  "escape", "search", "next", "previous", "done", "later", "worse", "never", "undo", "refresh", "prompt",
  "theme", "help", "open", "brief", "investigate", "correct", "fix", "publish",
]);

/** What is open over the page, what it was opened with, and the sheet's own state. */
export const Overlay = TaggedUnion({
  Later: { title: Schema.String, basis: Schema.NullOr(Schema.Number), sheet: WayOutSheet.Model },
  Never: { title: Schema.String, basis: Schema.NullOr(Schema.Number), sheet: WayOutSheet.Model },
  Correct: { id: Schema.String, title: Schema.String, verdict: Schema.String, app: Schema.String, jobId: Schema.String, sheet: CorrectSheet.Model },
  Brief: { sheet: BriefSheet.Model },
  Find: { q: Schema.String, sheet: Finder.Model },
  Keys: {},
});
export type Overlay = typeof Overlay.Type;

export const AppModel = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  /** When the page last heard the service, by its own clocks. */
  last: Schema.NullOr(Sample),
  /** The page's clocks at the latest tick or message. */
  now: Sample,
  /** The service's clock as last stated (a snapshot or heartbeat), against the page's monotonic clock. */
  anchor: Schema.NullOr(Schema.Struct({ atMs: Schema.Number, monoMs: Schema.Number })),
  /** The rows as shown; they stay put until the owner refreshes. Null until the first snapshot. */
  shown: Schema.NullOr(Shown),
  collapsed: Collapsed,
  focus: Schema.NullOr(Schema.String),
  /** The focused item in full, as last read, and the snapshot it was read against. */
  detail: Schema.NullOr(Schema.Struct({ seq: Schema.Number, item: ItemDetail })),
  overlay: Schema.NullOr(Overlay),
  /** How many overlays have opened: each opening starts its sheet afresh. */
  opened: Schema.Number,
  /** The owner's ways out, newest last, for u. */
  actions: Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.NullOr(Schema.Number) })),
  toast: Schema.Struct({ text: Schema.String, kind: Schema.String, shown: Schema.Boolean, n: Schema.Number }),
  /** How many seen waits have started: only the latest one counts. */
  seenWait: Schema.Number,
  /** A status read asked for while the stream is away; one at a time. */
  statusPending: Schema.Boolean,
  theme: Schema.NullOr(Theme),
  /** The bar's own state. */
  dock: Dock.Model,
});
export type AppModel = typeof AppModel.Type;

export const AppProps = Schema.Struct({ initialTheme: Schema.NullOr(Theme), initialCollapsed: Collapsed, now: Sample });
export type AppProps = typeof AppProps.Type;

// ---------------------------------------------------------------- messages

export const AppMessage = TaggedEnum({
  // The service and the page's clock
  ReceivedSnapshot: { snapshot: Snapshot, at: Sample },
  ReceivedHeartbeat: { atMs: Schema.NullOr(Schema.Number), at: Sample },
  LostChanges: {},
  Ticked: { at: Sample },
  SucceededStatus: { snapshot: Snapshot, at: Sample },
  FailedStatus: {},
  // Keys and the top bar
  PressedKey: { command: Command_ },
  ClickedTheme: {},
  ClickedHelp: {},
  // What the parts of the page ask for
  PickedSubject: { subject: Schema.String },
  PickedResult: { id: Schema.String },
  ToggledGroup: { group: Schema.Literals(m.GROUPS), open: Schema.Boolean },
  RequestedRefresh: {},
  RequestedInbox: {},
  RequestedItemAction: { action: Stage.ItemAction },
  RequestedPublish: { fixId: Schema.String },
  CopiedText: { text: Schema.String },
  FailedCopy: { reason: Schema.String },
  RequestedFind: { text: Schema.String },
  AskedAgent: { mode: Schema.String },
  FailedAsk: { message: Schema.String },
  SubmittedWayOut: { body: WayOutBody },
  SavedCorrection: {},
  CopiedBrief: {},
  FailedBrief: { message: Schema.String },
  ClosedOverlay: {},
  // Commands
  SucceededReadItem: { id: Schema.String, seq: Schema.Number, detail: ItemDetail },
  FailedReadItem: { id: Schema.String },
  SucceededAct: { id: Schema.String, before: Rows, action: Schema.String, decided: Decided, at: Sample },
  FailedAct: { status: Schema.Number, message: Schema.String },
  SucceededUndo: { id: Schema.String, decided: Decided, at: Sample },
  FailedUndo: { status: Schema.Number, message: Schema.String },
  SucceededMarkSeen: { decided: Decided, at: Sample },
  FailedMarkSeen: {},
  ElapsedSeenWait: { id: Schema.String, n: Schema.Number },
  ElapsedToast: { n: Schema.Number },
  SucceededInvestigate: {},
  SucceededRequestFix: {},
  SucceededPublish: { published: Published },
  CompletedOpenInOpenCode: {},
  CompletedRemember: {},
  CompletedScrollToTop: {},
  FailedRequest: { message: Schema.String },
  // The parts' own Messages
  GotStripMessage: { message: Strip.Message },
  GotInboxMessage: { message: Inbox.Message },
  GotStageMessage: { message: Stage.Message },
  GotDockMessage: { message: Dock.Message },
  GotWayOutMessage: { message: WayOutSheet.Message },
  GotCorrectMessage: { message: CorrectSheet.Message },
  GotBriefMessage: { message: BriefSheet.Message },
  GotFinderMessage: { message: Finder.Message },
  GotKeysMessage: { message: KeysSheet.Message },
});
export type AppMessage = typeof AppMessage.Type;

/** What the page's Commands and Subscriptions use; `AppLayer` provides it. */
export type AppServices = Overwatch | ServiceEvents | PageWindow | KeyValueStore.KeyValueStore | Clipboard.Clipboard;
type Return = Update.Return<AppModel, AppMessage, AppServices>;

// ---------------------------------------------------------------- commands

/** The page's own clocks, sampled together: the wall clock and the monotonic one. */
const sample = Effect.all({ wallMs: Clock.currentTimeMillis, monoMs: Effect.map(Clock.currentTimeNanos, (n) => Number(n) / 1e6) });

const failed = (error: { readonly message: string }) => AppMessage.FailedRequest({ message: error.message });

const FetchStatus = Command.define("FetchStatus", {
  messages: [AppMessage.SucceededStatus, AppMessage.FailedStatus],
  execute: Effect.gen(function* () {
    const api = yield* Overwatch;
    return yield* Effect.all([api.status, sample]);
  }).pipe(Effect.match({ onSuccess: ([snapshot, at]) => AppMessage.SucceededStatus({ snapshot, at }), onFailure: () => AppMessage.FailedStatus() })),
});

/** An item in full. `seq` is the snapshot it is read against, so every newer commit reads it again. */
export const ReadItem = Command.define("ReadItem", {
  args: { id: Schema.String, seq: Schema.Number },
  messages: [AppMessage.SucceededReadItem, AppMessage.FailedReadItem],
  execute: ({ id, seq }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* api.item(id);
    }).pipe(Effect.match({ onSuccess: (detail) => AppMessage.SucceededReadItem({ id, seq, detail }), onFailure: () => AppMessage.FailedReadItem({ id }) })),
});

/** A way out, bound to the position the owner was shown: if it changed since, the service refuses it. */
export const Act = Command.define("Act", {
  args: { id: Schema.String, body: WayOutBody, basis: Schema.optional(Schema.NullOr(Schema.Number)), before: Rows },
  messages: [AppMessage.SucceededAct, AppMessage.FailedAct],
  execute: ({ id, body, basis, before }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* Effect.all([api.act(id, basis === undefined ? body : { ...body, basisSeq: basis }), sample]);
    }).pipe(
      Effect.match({
        onSuccess: ([decided, at]) => AppMessage.SucceededAct({ id, before, action: body.action, decided, at }),
        onFailure: (error) => AppMessage.FailedAct({ status: error.status, message: error.message }),
      }),
    ),
});

export const Undo = Command.define("Undo", {
  args: { id: Schema.String, seq: Schema.NullOr(Schema.Number) },
  messages: [AppMessage.SucceededUndo, AppMessage.FailedUndo],
  execute: ({ id, seq }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* Effect.all([api.act(id, { action: "undo", actionSeq: seq } as ActionBody), sample]);
    }).pipe(
      Effect.match({
        onSuccess: ([decided, at]) => AppMessage.SucceededUndo({ id, decided, at }),
        onFailure: (error) => AppMessage.FailedUndo({ status: error.status, message: error.message }),
      }),
    ),
});

/** Seen means looked at: the row held focus for a moment. */
export const MarkSeen = Command.define("MarkSeen", {
  args: { id: Schema.String, throughSeq: Schema.Number },
  messages: [AppMessage.SucceededMarkSeen, AppMessage.FailedMarkSeen],
  execute: ({ id, throughSeq }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* Effect.all([api.act(id, { action: "seen", throughSeq }), sample]);
    }).pipe(Effect.match({ onSuccess: ([decided, at]) => AppMessage.SucceededMarkSeen({ decided, at }), onFailure: () => AppMessage.FailedMarkSeen() })),
});

/** O: the focused thing in an ordinary OpenCode session. The tab opens with the key press; the address follows. */
const OpenInOpenCode = Command.define("OpenInOpenCode", {
  args: { subject: Schema.String },
  messages: [AppMessage.CompletedOpenInOpenCode, AppMessage.FailedRequest],
  execute: ({ subject }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      const page = yield* PageWindow;
      yield* page.openTab(Effect.flatMap(api.focus(subject), (focus) => api.open(subject, focus.requestKey)));
    }).pipe(Effect.match({ onSuccess: () => AppMessage.CompletedOpenInOpenCode(), onFailure: failed })),
});

const Investigate = Command.define("Investigate", {
  args: { id: Schema.String },
  messages: [AppMessage.SucceededInvestigate, AppMessage.FailedRequest],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      yield* api.investigate(id, (yield* api.focus(id)).requestKey);
    }).pipe(Effect.match({ onSuccess: () => AppMessage.SucceededInvestigate(), onFailure: failed })),
});

/** F: a fix proposal on the latest investigation; the answer, a proposal or the rule that stops it, appears in place. */
const RequestFix = Command.define("RequestFix", {
  args: { id: Schema.String, jobId: Schema.String },
  messages: [AppMessage.SucceededRequestFix, AppMessage.FailedRequest],
  execute: ({ id, jobId }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      yield* api.fix(id, jobId, (yield* api.focus(id)).requestKey);
    }).pipe(Effect.match({ onSuccess: () => AppMessage.SucceededRequestFix(), onFailure: failed })),
});

/** Shift-P: the verified candidate's draft pull request, bound to what the owner is looking at. */
const Publish = Command.define("Publish", {
  args: { id: Schema.String, fixId: Schema.String, basis: Schema.NullOr(Schema.Number) },
  messages: [AppMessage.SucceededPublish, AppMessage.FailedRequest],
  execute: ({ id, fixId, basis }) =>
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return yield* api.publish(fixId, basis, (yield* api.focus(id)).requestKey);
    }).pipe(Effect.match({ onSuccess: (published) => AppMessage.SucceededPublish({ published }), onFailure: failed })),
});

/** Held focus counts as seen after a moment; `n` names the wait, and only the latest one counts. */
export const WaitBeforeSeen = Command.define("WaitBeforeSeen", {
  args: { id: Schema.String, n: Schema.Number },
  messages: [AppMessage.ElapsedSeenWait],
  execute: ({ id, n }) => Effect.sleep(Duration.millis(m.SEEN_AFTER_MS)).pipe(Effect.as(AppMessage.ElapsedSeenWait({ id, n }))),
});

export const WaitBeforeDismissal = Command.define("WaitBeforeDismissal", {
  args: { n: Schema.Number },
  messages: [AppMessage.ElapsedToast],
  execute: ({ n }) => Effect.sleep(Duration.millis(3200)).pipe(Effect.as(AppMessage.ElapsedToast({ n }))),
});

/** What the page keeps in this browser: the theme and which groups are open. Without storage it only forgets. */
export const Remember = Command.define("Remember", {
  args: { key: Schema.String, value: Schema.String },
  messages: [AppMessage.CompletedRemember],
  execute: ({ key, value }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      yield* store.set(key, value);
    }).pipe(Effect.ignore, Effect.as(AppMessage.CompletedRemember())),
});

const ScrollToTop = Command.define("ScrollToTop", {
  messages: [AppMessage.CompletedScrollToTop],
  execute: Effect.gen(function* () {
    const page = yield* PageWindow;
    yield* page.scrollToTop;
    return AppMessage.CompletedScrollToTop();
  }),
});

// ---------------------------------------------------------------- update

const connectionOf = (model: AppModel): m.Connection => freshness(model.last, model.now);
const down = (model: AppModel) => connectionOf(model) === "down";
const incidentOf = (model: AppModel, id: string | null) => (id === null ? undefined : model.snapshot?.incidents.find((i) => i.id === id));
const rowsOf = (model: AppModel) => (model.shown ? m.order(model.shown, model.collapsed) : []);
/** The focused item in full, when it has been read. */
const detailOf = (model: AppModel): ItemDetail | null => (model.detail !== null && model.detail.item.incident.id === model.focus ? model.detail.item : null);

/** A snapshot newer than the one shown replaces it; an older one is ignored. */
const apply = (model: AppModel, snapshot: Snapshot, at: Sample): AppModel => {
  if (model.snapshot && snapshot.seq < model.snapshot.seq) return model;
  return {
    ...model,
    snapshot,
    anchor: !model.anchor || snapshot.atMs >= model.anchor.atMs ? { atMs: snapshot.atMs, monoMs: at.monoMs } : model.anchor,
    shown: model.shown ?? m.freeze(snapshot.inbox),
  };
};

export const init = (props: AppProps): Return => ({
  model: {
    snapshot: null,
    last: null,
    now: props.now,
    anchor: null,
    shown: null,
    collapsed: props.initialCollapsed,
    focus: null,
    detail: null,
    overlay: null,
    opened: 0,
    actions: [],
    toast: { text: "", kind: "", shown: false, n: 0 },
    seenWait: 0,
    statusPending: false,
    theme: props.initialTheme,
    dock: Dock.init,
  },
});

/** The model with Commands to run. */
const go = (model: AppModel, ...commands: ReadonlyArray<Command.Command<AppMessage, never, AppServices>>): Return => ({ model, commands });
/** More Commands after a step. */
const also = (step: Return, ...commands: ReadonlyArray<Command.Command<AppMessage, never, AppServices>>): Return => ({
  model: step.model,
  commands: [...(step.commands ?? []), ...commands],
});
/** The focused item, read again: something the owner did may have changed it. */
const readAgain = (model: AppModel) => (m.isIncident(model.focus) && model.snapshot !== null ? [ReadItem({ id: model.focus, seq: model.snapshot.seq })] : []);

const dockProps = (model: AppModel): Dock.Props => {
  const detail = detailOf(model);
  const focused = m.isIncident(model.focus) ? incidentOf(model, model.focus) ?? detail?.incident : undefined;
  const label = model.focus === null ? "" : focused ? `${focused.app}/${focused.environment} · ${focused.title}` : model.focus.slice(4).replaceAll("/", " / ");
  return { focus: model.focus, label, down: down(model), overlay: model.overlay !== null };
};

// Each part's Messages are folded into the page's: its update runs on its own Model, its Commands are lifted, and
// each of its events becomes the page Message that says the same thing.

const foldStrip = Update.foldChild({
  update: Strip.update,
  read: () => Option.some(Strip.init),
  write: (model: AppModel) => model,
  toParentMessage: (message: Strip.Message): AppMessage => AppMessage.GotStripMessage({ message }),
  foldOutMessage: (event: Strip.Events) => (model: AppModel) => step(model, AppMessage.PickedSubject({ subject: event.subject })),
});

const foldInbox = Update.foldChild({
  update: Inbox.update,
  read: () => Option.some(Inbox.init),
  write: (model: AppModel) => model,
  toParentMessage: (message: Inbox.Message): AppMessage => AppMessage.GotInboxMessage({ message }),
  foldOutMessage: (event: Inbox.Events) => (model: AppModel) =>
    step(
      model,
      Inbox.Events.match(event, {
        Picked: ({ id }) => AppMessage.PickedSubject({ subject: id }),
        RequestedRefresh: () => AppMessage.RequestedRefresh(),
        Toggled: ({ group, open }) => AppMessage.ToggledGroup({ group, open }),
      }),
    ),
});

const foldStage = Update.foldChild({
  update: Stage.update,
  read: () => Option.some(Stage.init),
  write: (model: AppModel) => model,
  toParentMessage: (message: Stage.Message): AppMessage => AppMessage.GotStageMessage({ message }),
  foldOutMessage: (event: Stage.Events) => (model: AppModel) =>
    step(
      model,
      Stage.Events.match(event, {
        RequestedInbox: () => AppMessage.RequestedInbox(),
        Picked: ({ subject }) => AppMessage.PickedSubject({ subject }),
        RequestedAction: ({ action }) => AppMessage.RequestedItemAction({ action }),
        RequestedPublish: ({ fixId }) => AppMessage.RequestedPublish({ fixId }),
        Copied: ({ text }) => AppMessage.CopiedText({ text }),
        FailedCopy: ({ reason }) => AppMessage.FailedCopy({ reason }),
      }),
    ),
});

const toDock = (message: Dock.Message): AppMessage => AppMessage.GotDockMessage({ message });
const foldDock = Update.foldChild({
  update: (dock: Dock.Model, input: { readonly message: Dock.Message; readonly props: Dock.Props }) => Dock.update(dock, input.message, input.props),
  read: (model: AppModel) => Option.some(model.dock),
  write: (model: AppModel, dock: Dock.Model) => ({ ...model, dock }),
  toParentMessage: toDock,
  foldOutMessage: (event: Dock.Events) => (model: AppModel) =>
    step(
      model,
      Dock.Events.match(event, {
        RequestedFind: ({ text }) => AppMessage.RequestedFind({ text }),
        Asked: ({ mode }) => AppMessage.AskedAgent({ mode }),
        FailedAsk: ({ message }) => AppMessage.FailedAsk({ message }),
      }),
    ),
});

/** The sheet a page Message closes or submits with. */
const closeSheet = (model: AppModel) => step(model, AppMessage.ClosedOverlay());

const wayOutProps = (model: AppModel): WayOutSheet.Props | null =>
  model.overlay?._tag === "Later" || model.overlay?._tag === "Never"
    ? { opened: String(model.opened), kind: model.overlay._tag === "Later" ? "later" : "never", title: model.overlay.title, nowMs: model.now.wallMs }
    : null;
const foldWayOut = Update.foldChild({
  update: (sheet: WayOutSheet.Model, input: { readonly message: WayOutSheet.Message; readonly props: WayOutSheet.Props }) => WayOutSheet.update(sheet, input.message, input.props),
  read: (model: AppModel) => (model.overlay?._tag === "Later" || model.overlay?._tag === "Never" ? Option.some(model.overlay.sheet) : Option.none()),
  write: (model: AppModel, sheet: WayOutSheet.Model) =>
    model.overlay?._tag === "Later" || model.overlay?._tag === "Never" ? { ...model, overlay: { ...model.overlay, sheet } } : model,
  toParentMessage: (message: WayOutSheet.Message): AppMessage => AppMessage.GotWayOutMessage({ message }),
  foldOutMessage: (event: WayOutSheet.Events) => (model: AppModel) =>
    event._tag === "Submitted" ? step(model, AppMessage.SubmittedWayOut({ body: event.body })) : closeSheet(model),
});

const correctProps = (model: AppModel): CorrectSheet.Props | null =>
  model.overlay?._tag === "Correct"
    ? { opened: String(model.opened), id: model.overlay.id, title: model.overlay.title, verdict: model.overlay.verdict, app: model.overlay.app, jobId: model.overlay.jobId }
    : null;
const foldCorrect = Update.foldChild({
  update: (sheet: CorrectSheet.Model, input: { readonly message: CorrectSheet.Message; readonly props: CorrectSheet.Props }) => CorrectSheet.update(sheet, input.message, input.props),
  read: (model: AppModel) => (model.overlay?._tag === "Correct" ? Option.some(model.overlay.sheet) : Option.none()),
  write: (model: AppModel, sheet: CorrectSheet.Model) => (model.overlay?._tag === "Correct" ? { ...model, overlay: { ...model.overlay, sheet } } : model),
  toParentMessage: (message: CorrectSheet.Message): AppMessage => AppMessage.GotCorrectMessage({ message }),
  foldOutMessage: (event: CorrectSheet.Events) => (model: AppModel) => (event._tag === "Saved" ? step(model, AppMessage.SavedCorrection()) : closeSheet(model)),
});

const toBrief = (message: BriefSheet.Message): AppMessage => AppMessage.GotBriefMessage({ message });
const foldBrief = Update.foldChild({
  update: BriefSheet.update,
  read: (model: AppModel) => (model.overlay?._tag === "Brief" ? Option.some(model.overlay.sheet) : Option.none()),
  write: (model: AppModel, sheet: BriefSheet.Model) => (model.overlay?._tag === "Brief" ? { ...model, overlay: { ...model.overlay, sheet } } : model),
  toParentMessage: toBrief,
  foldOutMessage: (event: BriefSheet.Events) => (model: AppModel) =>
    step(
      model,
      BriefSheet.Events.match(event, {
        Copied: () => AppMessage.CopiedBrief(),
        FailedCopy: ({ reason }) => AppMessage.FailedCopy({ reason }),
        Failed: ({ message }) => AppMessage.FailedBrief({ message }),
        RequestedClose: () => AppMessage.ClosedOverlay(),
      }),
    ),
});

const toFinder = (message: Finder.Message): AppMessage => AppMessage.GotFinderMessage({ message });
const foldFinder = Update.foldChild({
  update: Finder.update,
  read: (model: AppModel) => (model.overlay?._tag === "Find" ? Option.some(model.overlay.sheet) : Option.none()),
  write: (model: AppModel, sheet: Finder.Model) => (model.overlay?._tag === "Find" ? { ...model, overlay: { ...model.overlay, sheet } } : model),
  toParentMessage: toFinder,
  foldOutMessage: (event: Finder.Events) => (model: AppModel) => (event._tag === "Picked" ? step(model, AppMessage.PickedResult({ id: event.id })) : closeSheet(model)),
});

const foldKeys = Update.foldChild({
  update: KeysSheet.update,
  read: (model: AppModel) => (model.overlay?._tag === "Keys" ? Option.some(KeysSheet.init) : Option.none()),
  write: (model: AppModel) => model,
  toParentMessage: (message: KeysSheet.Message): AppMessage => AppMessage.GotKeysMessage({ message }),
  foldOutMessage: () => (model: AppModel) => closeSheet(model),
});

/** One Message, before the reads it implies (see `update`). */
const step = (model: AppModel, message: AppMessage): Return => {
  const detail = detailOf(model);

  /** A note in the corner, for a few seconds. */
  const say = (next: AppModel, text: string, kind = ""): Return => {
    const n = next.toast.n + 1;
    return go({ ...next, toast: { text, kind, shown: true, n } }, WaitBeforeDismissal({ n }));
  };
  /** A seen wait for a row now in focus; only the latest one counts. */
  const waitSeen = (next: AppModel, id: string): Return => {
    const n = next.seenWait + 1;
    return go({ ...next, seenWait: n }, WaitBeforeSeen({ id, n }));
  };
  /** Puts a subject in focus: its item is read, and held for a moment it counts as seen. */
  const focusOn = (next: AppModel, subject: string | null): Return => {
    if (next.focus === subject) return go(next);
    const focused = { ...next, focus: subject };
    return m.isIncident(subject) ? waitSeen(focused, subject) : go(focused);
  };
  const open = (overlay: Overlay, ...commands: ReadonlyArray<Command.Command<AppMessage, never, AppServices>>) =>
    go({ ...model, overlay, opened: model.opened + 1 }, ...commands);
  const openFind = (q: string) => {
    const finder = Finder.init({ opened: String(model.opened + 1), initialQuery: q, incidents: model.snapshot?.incidents ?? [] });
    return open(Overlay.Find({ q, sheet: finder.model }), ...Command.mapMessages(finder.commands, toFinder));
  };
  const openBrief = () => {
    const brief = BriefSheet.init();
    return open(Overlay.Brief({ sheet: brief.model }), ...Command.mapMessages(brief.commands, toBrief));
  };
  /** Done, Later or Never on the item in focus. */
  const wayOut = (body: WayOutBody, basis: number | null | undefined, next: AppModel = model) => {
    const id = next.focus;
    if (!m.isIncident(id) || down(next)) return go(next);
    return go(next, Act({ id, body, ...(basis === undefined ? {} : { basis }), before: [...rowsOf(next)] }));
  };
  const sheet = (kind: "later" | "never") => {
    const i = incidentOf(model, model.focus);
    if (!i || down(model)) return go(model);
    const basis = i.decidedSeq ?? null;
    return open(kind === "later" ? Overlay.Later({ title: i.title, basis, sheet: WayOutSheet.init }) : Overlay.Never({ title: i.title, basis, sheet: WayOutSheet.init }));
  };
  const undo = () => {
    if (down(model)) return go(model);
    const fallback = m.isIncident(model.focus) ? incidentOf(model, model.focus)?.way : undefined;
    const last = model.actions.at(-1) ?? (fallback && model.focus !== null ? { id: model.focus, seq: fallback.seq } : null);
    if (!last) return say(model, "Nothing to undo");
    return go({ ...model, actions: model.actions.slice(0, -1) }, Undo(last));
  };
  const latestDone = () => detail?.investigations.filter((x) => x.result).at(-1);
  const correct = () => {
    const i = incidentOf(model, model.focus);
    const job = latestDone();
    if (!i || !job?.result || down(model)) return say(model, job ? "Service not answering" : "Nothing investigated to correct yet");
    return open(Overlay.Correct({ id: i.id, title: i.title, verdict: m.verdictView(job.result).label, app: i.app, jobId: job.jobId, sheet: CorrectSheet.init }));
  };
  const investigate = () => (m.isIncident(model.focus) && !down(model) ? go(model, Investigate({ id: model.focus })) : go(model));
  const fix = () => {
    const job = latestDone();
    return m.isIncident(model.focus) && !down(model) && job ? go(model, RequestFix({ id: model.focus, jobId: job.jobId })) : go(model);
  };
  const publish = (fixId = detail?.fixes.find((f) => f.action)?.id) => {
    const id = model.focus;
    if (!fixId || !m.isIncident(id) || down(model)) return go(model);
    return also(
      say(model, "Opening the draft: protection, push, then the pull request, each read back…", "ok"),
      Publish({ id, fixId, basis: incidentOf(model, id)?.decidedSeq ?? null }),
    );
  };
  const openInOpenCode = () => {
    if (!model.focus || down(model)) return say(model, model.focus ? "Service not answering" : "Put something in focus first");
    return go(model, OpenInOpenCode({ subject: model.focus }));
  };
  const toggleTheme = () => {
    const theme = model.theme === "light" ? "dark" : "light";
    return go({ ...model, theme }, Remember({ key: "ow-theme", value: theme }));
  };
  const refresh = () => go(model.snapshot ? { ...model, shown: m.freeze(model.snapshot.inbox) } : model);
  const close = () => go({ ...model, overlay: null });

  switch (message._tag) {
    case "ReceivedSnapshot":
      return go(apply({ ...model, last: message.at, now: message.at }, message.snapshot, message.at));
    case "ReceivedHeartbeat": {
      const at = message.atMs;
      const anchor = at !== null && (!model.anchor || at >= model.anchor.atMs) ? { atMs: at, monoMs: message.at.monoMs } : model.anchor;
      return go({ ...model, last: message.at, now: message.at, anchor });
    }
    case "LostChanges":
      // Ask for status once while the stream is away; its answer updates data only, never liveness.
      return model.statusPending ? go(model) : go({ ...model, statusPending: true }, FetchStatus());
    case "Ticked":
      return go({ ...model, now: message.at });
    case "SucceededStatus":
      return go(apply({ ...model, statusPending: false }, message.snapshot, message.at));
    case "FailedStatus":
      return go({ ...model, statusPending: false });

    case "PressedKey": {
      const rows = rowsOf(model);
      switch (message.command) {
        case "escape": return model.overlay ? close() : go(model);
        case "search": return openFind("");
        case "next": return focusOn(model, m.step(rows, model.focus, 1));
        case "previous": return focusOn(model, m.step(rows, model.focus, -1));
        case "done": return wayOut({ action: "done" }, incidentOf(model, model.focus)?.decidedSeq);
        case "later": return sheet("later");
        case "never": return sheet("never");
        case "worse": return wayOut({ action: "later", when: "worse" }, incidentOf(model, model.focus)?.decidedSeq);
        case "undo": return undo();
        case "refresh": return refresh();
        case "prompt": return model.focus ? go(model) : openFind("");
        case "theme": return toggleTheme();
        case "help": return open(Overlay.Keys());
        case "open": return openInOpenCode();
        case "brief": return openBrief();
        case "investigate": return investigate();
        case "correct": return correct();
        case "fix": return fix();
        case "publish": return publish();
      }
      return go(model);
    }
    case "ClickedTheme": return toggleTheme();
    case "ClickedHelp": return open(Overlay.Keys());

    case "PickedSubject": return focusOn(model, message.subject);
    case "PickedResult": return focusOn({ ...model, overlay: null }, message.id);
    case "ToggledGroup": {
      const collapsed = { ...model.collapsed, [message.group]: !message.open };
      return go({ ...model, collapsed }, Remember({ key: "ow-groups", value: JSON.stringify(collapsed) }));
    }
    case "RequestedRefresh": return refresh();
    case "RequestedInbox": return go({ ...model, focus: null }, ScrollToTop());
    case "RequestedItemAction":
      switch (message.action) {
        case "done": return wayOut({ action: "done" }, incidentOf(model, model.focus)?.decidedSeq);
        case "worse": return wayOut({ action: "later", when: "worse" }, incidentOf(model, model.focus)?.decidedSeq);
        case "later": return sheet("later");
        case "never": return sheet("never");
        case "undo": return undo();
        case "open": return openInOpenCode();
        case "investigate": return investigate();
        case "correct": return correct();
        case "fix": return fix();
      }
      return go(model);
    case "RequestedPublish": return publish(message.fixId);
    case "CopiedText": return say(model, `Copied ${message.text}`, "ok");
    case "FailedCopy": return say(model, `Copy failed: ${message.reason}`, "error");
    case "RequestedFind": return openFind(message.text);
    case "AskedAgent":
      return also(say(model, message.mode === "new" ? "Queued: an agent answers here, under Questions." : "Added to the queued request.", "ok"), ...readAgain(model));
    case "FailedAsk": return also(say(model, message.message, "error"), ...readAgain(model));
    case "SubmittedWayOut": {
      const basis = model.overlay?._tag === "Later" || model.overlay?._tag === "Never" ? model.overlay.basis : undefined;
      return wayOut(message.body, basis, { ...model, overlay: null });
    }
    case "SavedCorrection": return also(say({ ...model, overlay: null }, "Saved to the playbook.", "ok"), ...readAgain(model));
    case "CopiedBrief": return say(model, "Copied. Nothing was sent.", "ok");
    case "FailedBrief": return say(model, message.message, "error");
    case "ClosedOverlay": return close();

    case "SucceededReadItem": {
      // The latest read of the item in focus stands; a late answer to an earlier read is dropped.
      const current = model.detail !== null && model.detail.item.incident.id === message.id ? model.detail.seq : -Infinity;
      return message.id === model.focus && message.seq >= current ? go({ ...model, detail: { seq: message.seq, item: message.detail } }) : go(model);
    }
    case "FailedReadItem": return go(model);
    case "SucceededAct": {
      const { id, before, decided, at } = message;
      const removed = { ...model, actions: [...model.actions, { id, seq: decided.action.seq }], shown: m.without(model.shown ?? {}, id) };
      const next = m.after(before, id, id);
      const applied = apply(removed, decided, at);
      const word = message.action === "done" ? "Done" : message.action === "never" ? "Never" : "Later";
      const said = say(next && next !== id ? { ...applied, focus: next } : applied, `${word}: ${incidentOf(applied, id)?.title ?? ""} · u puts it back`);
      if (!(next && next !== id && m.isIncident(next))) return said;
      const waited = waitSeen(said.model, next);
      return also(waited, ...(said.commands ?? []));
    }
    case "FailedAct":
      return message.status === 409
        ? also(say(model, "This changed since you looked (another tab or a return). Look again, then decide.", "error"), ...readAgain(model))
        : say(model, message.message, "error");
    case "SucceededUndo": {
      const restored = apply({ ...model, shown: m.restore(model.shown ?? {}, message.decided.inbox, message.id) }, message.decided, message.at);
      const said = say({ ...restored, focus: message.id }, "Put back");
      return also(waitSeen(said.model, message.id), ...(said.commands ?? []));
    }
    case "FailedUndo": return say(model, message.status === 409 ? "That changed since: nothing undone" : message.message, "error");
    case "SucceededMarkSeen": return go(apply(model, message.decided, message.at));
    case "FailedMarkSeen": return go(model);
    case "ElapsedSeenWait": {
      const i = incidentOf(model, message.id);
      if (message.n !== model.seenWait || model.focus !== message.id || !i || down(model) || i.lastSeq <= (i.seenSeq ?? 0) || !model.snapshot) return go(model);
      return go(model, MarkSeen({ id: message.id, throughSeq: model.snapshot.seq }));
    }
    case "ElapsedToast":
      return message.n === model.toast.n ? go({ ...model, toast: { ...model.toast, shown: false } }) : go(model);
    case "SucceededInvestigate":
      return also(say(model, "Investigation queued: independent readings, then a challenger if most say real.", "ok"), ...readAgain(model));
    case "SucceededRequestFix":
      return also(say(model, "Fix requested: every rule is checked before anything is proposed.", "ok"), ...readAgain(model));
    case "SucceededPublish": {
      const fixed = message.published.fix;
      return also(fixed?.pr ? say(model, `Draft #${fixed.pr.number} opened.`, "ok") : say(model, `Stopped: ${fixed?.reason ?? "see the item"}`, "error"), ...readAgain(model));
    }
    case "FailedRequest": return also(say(model, message.message, "error"), ...readAgain(model));
    case "CompletedOpenInOpenCode":
    case "CompletedRemember":
    case "CompletedScrollToTop":
      return go(model);

    case "GotStripMessage": return foldStrip(model, message.message);
    case "GotInboxMessage": return foldInbox(model, message.message);
    case "GotStageMessage": return foldStage(model, message.message);
    case "GotDockMessage": return foldDock(model, { message: message.message, props: dockProps(model) });
    case "GotWayOutMessage": {
      const props = wayOutProps(model);
      return props === null ? go(model) : foldWayOut(model, { message: message.message, props });
    }
    case "GotCorrectMessage": {
      const props = correctProps(model);
      return props === null ? go(model) : foldCorrect(model, { message: message.message, props });
    }
    case "GotBriefMessage": return foldBrief(model, message.message);
    case "GotFinderMessage": return foldFinder(model, message.message);
    case "GotKeysMessage": return foldKeys(model, message.message);
  }
};

/**
 * One Message, then what it implies for reads, as queries did: a new subject in focus is read in full (again with
 * every newer snapshot), the bar learns where a prompt on it goes, and its row scrolls into view.
 */
export const update = (model: AppModel, message: AppMessage): Return => {
  const result = step(model, message);
  const next = result.model;
  const focusChanged = next.focus !== model.focus;
  const reads: Array<Command.Command<AppMessage, never, AppServices>> = [];
  if (m.isIncident(next.focus) && next.snapshot !== null && (focusChanged || next.snapshot.seq !== model.snapshot?.seq)) {
    reads.push(ReadItem({ id: next.focus, seq: next.snapshot.seq }));
  }
  if (!focusChanged) return reads.length ? also(result, ...reads) : result;
  if (next.focus !== null) reads.push(Command.mapMessage(Inbox.RevealRow({ id: next.focus }), (message) => AppMessage.GotInboxMessage({ message })));
  const dock = Dock.focusChanged(next.dock, next.focus);
  return also({ model: { ...next, dock: dock.model }, commands: result.commands ?? [] }, ...reads, ...Command.mapMessages(dock.commands, toDock));
};

// ---------------------------------------------------------------- subscriptions

/** Whether a key press comes from a field the owner types in. */
const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);

export const subscriptions = Subscription.make<AppModel, AppMessage, AppServices>()((entry) => ({
  changes: Subscription.persistentEntry(
    Stream.unwrap(
      Effect.gen(function* () {
        return (yield* ServiceEvents).changes;
      }),
    ).pipe(
      Stream.mapEffect((event) =>
        Effect.map(sample, (at): AppMessage =>
          event._tag === "Snapshot" ? AppMessage.ReceivedSnapshot({ snapshot: event.snapshot, at })
            : event._tag === "Heartbeat" ? AppMessage.ReceivedHeartbeat({ atMs: event.atMs ?? null, at })
            : AppMessage.LostChanges())
      ),
    ),
  ),
  // The page's own clock: once a second, whatever any request is doing.
  clock: Subscription.persistentEntry(Stream.tick(Duration.seconds(1)).pipe(Stream.mapEffect(() => Effect.map(sample, (at) => AppMessage.Ticked({ at }))))),
  keys: entry(
    { overlay: Schema.Boolean, focused: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ overlay: model.overlay !== null, focused: model.focus !== null }),
      dependenciesToStream: ({ overlay, focused }) =>
        Dom.streamFromEventFilterMapPreventDefault({
          target: document,
          type: "keydown",
          filterMapEvent: (event) => {
            if (event.isComposing) return Option.none();
            const command = m.command(event.key, { typing: editable(event.target), overlay, shift: event.shiftKey, meta: event.metaKey || event.ctrlKey });
            // With something in focus, p and Enter go to the bar, which takes them itself.
            return command === null || (command === "prompt" && focused) ? Option.none() : Option.some(AppMessage.PressedKey({ command }));
          },
        }),
    },
  ),
  // The document says how the link is and which theme is chosen, for the stylesheet and for scripts.
  document: entry(
    { link: Schema.String, theme: Schema.NullOr(Theme) },
    {
      modelToDependencies: (model) => ({ link: connectionOf(model), theme: model.theme }),
      dependenciesToStream: ({ link, theme }) =>
        Stream.fromEffect(
          Effect.sync(() => {
            document.body.dataset.link = link;
            if (theme !== null) document.documentElement.dataset.theme = theme;
          }),
        ).pipe(Stream.drain),
    },
  ),
}));

// ---------------------------------------------------------------- view

export const view = (model: AppModel, h: H<AppMessage>): Document => {
  const connection = connectionOf(model);
  const quiet = Math.round(silence(model.last, model.now) / 1000);
  const serverNow = m.serverNow(model.anchor, model.now.monoMs);
  const detail = detailOf(model);
  const overlay = model.overlay;
  const opened = String(model.opened);
  const sheet = () => {
    if (overlay === null) return null;
    switch (overlay._tag) {
      case "Later":
      case "Never":
        return h.submodel({
          slotId: "way-out",
          model: overlay.sheet,
          view: WayOutSheet.view,
          viewInputs: wayOutProps(model)!,
          toParentMessage: (message) => AppMessage.GotWayOutMessage({ message }),
        });
      case "Correct":
        return h.submodel({
          slotId: "correct",
          model: overlay.sheet,
          view: CorrectSheet.view,
          viewInputs: correctProps(model)!,
          toParentMessage: (message) => AppMessage.GotCorrectMessage({ message }),
        });
      case "Brief":
        return h.submodel({ slotId: "brief", model: overlay.sheet, view: BriefSheet.view, viewInputs: { opened }, toParentMessage: toBrief });
      case "Find":
        return h.submodel({
          slotId: "find",
          model: overlay.sheet,
          view: Finder.view,
          viewInputs: { opened, initialQuery: overlay.q, incidents: model.snapshot?.incidents ?? [] },
          toParentMessage: toFinder,
        });
      case "Keys":
        return h.submodel({ slotId: "keys", model: KeysSheet.init, view: KeysSheet.view, viewInputs: { opened }, toParentMessage: (message) => AppMessage.GotKeysMessage({ message }) });
    }
  };
  return {
    title: "Overwatch",
    // The runtime replaces its container with this root, so the root is the container again (`#app`).
    body: el(
      h,
      "div",
      { attrs: { id: "app" }, on: [h.Style({ display: "contents" })] },
      el(
        h,
        "div",
        { on: [h.Style({ display: "contents" })] },
        el(
          h,
          "header",
          { class: "topbar" },
          el(
            h,
            "a",
            { class: "brand", attrs: { href: "/", "aria-label": "Overwatch" } },
            el(h, "img", { attrs: { src: "logo.svg", alt: "", width: "28", height: "28" } }),
            el(h, "span", { class: "wordmark" }, "Overwatch", el(h, "i", {}, ".")),
          ),
          el(
            h,
            "span",
            { class: "connection", attrs: { "data-connection": connection, "aria-live": "polite" } },
            el(h, "span", { class: "pulse", attrs: { "aria-hidden": "true" } }),
            el(
              h,
              "span",
              { class: "connection-text" },
              connection === "live" ? "Live" : connection === "stale" ? `Stale · ${quiet}s` : connection === "down" ? "Not answering" : "Connecting…",
            ),
          ),
          el(h, "span", { class: "spacer" }),
          el(
            h,
            "div",
            { class: "tools" },
            el(
              h,
              "button",
              { class: "icon-button", attrs: { type: "button", "data-theme-toggle": "", title: "Theme (t)", "aria-label": "Toggle theme" }, on: [h.OnClick(AppMessage.ClickedTheme())] },
              ThemeIcon(h),
            ),
            el(
              h,
              "button",
              { class: "icon-button", attrs: { type: "button", "data-help": "", title: "Keyboard (?)", "aria-label": "Keyboard shortcuts" }, on: [h.OnClick(AppMessage.ClickedHelp())] },
              KeyboardIcon(h),
            ),
          ),
        ),
        Banners.view(h, { snapshot: model.snapshot, connection, silence: quiet }),
        h.submodel({
          slotId: "strip",
          model: Strip.init,
          view: Strip.view,
          viewInputs: { snapshot: model.snapshot, connection, serverNow, focus: model.focus },
          toParentMessage: (message) => AppMessage.GotStripMessage({ message }),
        }),
        el(
          h,
          "main",
          { class: "deck" },
          h.submodel({
            slotId: "inbox",
            model: Inbox.init,
            view: Inbox.view,
            viewInputs: { snapshot: model.snapshot, shown: model.shown, collapsed: model.collapsed, focus: model.focus },
            toParentMessage: (message) => AppMessage.GotInboxMessage({ message }),
          }),
          h.submodel({
            slotId: "stage",
            model: Stage.init,
            view: Stage.view,
            viewInputs: { snapshot: model.snapshot, focus: model.focus, detail, connection, serverNow, wallNow: model.now.wallMs },
            toParentMessage: (message) => AppMessage.GotStageMessage({ message }),
          }),
          h.submodel({ slotId: "dock", model: model.dock, view: Dock.view, viewInputs: dockProps(model), toParentMessage: toDock }),
        ),
        el(
          h,
          "div",
          { class: ["toast", model.toast.shown && "show", model.toast.shown && model.toast.kind], attrs: { "data-toast": "", role: "status", "aria-live": "polite" } },
          model.toast.text,
        ),
        el(h, "div", { attrs: { "data-overlay": "" } }, sheet()),
      ),
    ),
  };
};

// ---------------------------------------------------------------- services

/** The services the page's Commands and Subscriptions run on, over the browser's `fetch`, storage and clipboard. */
export const AppLayer = Layer.mergeAll(Overwatch.layer, ServiceEvents.layer, PageWindow.layer, BrowserKeyValueStore.layerLocalStorage, Clipboard.layer);
