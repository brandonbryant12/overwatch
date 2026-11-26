/**
 * The page: renders what the service decided and sends the owner's commands. It keeps its own clock for staleness
 * (a one-second tick comparing wall and monotonic time with the last time it heard the service), freezes row
 * positions while the owner looks, and never generates identifiers or decides groups.
 */
import { Command, Component, Head, Subscription, UiSchema } from "@effect/ui";
import { Html, HtmlHead, HtmlSubscription } from "@effect/ui/html";
import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Clock, Duration, Effect, Layer, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import { AsyncResult } from "effect/reactivity";
import { freshness, silence } from "../freshness.mjs";
import { Banners } from "./components/Banners.ts";
import { BriefSheet } from "./components/BriefSheet.ts";
import { CorrectSheet } from "./components/CorrectSheet.ts";
import { Dock } from "./components/Dock.ts";
import { Finder } from "./components/Finder.ts";
import { KeyboardIcon, ThemeIcon } from "./components/Glyphs.ts";
import { Inbox } from "./components/Inbox.ts";
import { KeysSheet } from "./components/KeysSheet.ts";
import { ItemAction, Stage } from "./components/Stage.ts";
import { Strip } from "./components/Strip.ts";
import { WayOutSheet } from "./components/WayOutSheet.ts";
import { Decided, type ItemDetail, Published, Sample, Snapshot, WayOutBody } from "./domain/Overwatch.ts";
import * as m from "./model.ts";
import { GetItem } from "./queries/GetItem.ts";
import { ItemsTag } from "./queries/tags.ts";
import { type ActionBody, Overwatch, ServiceEvents } from "./services/Overwatch.ts";
import { PageWindow } from "./services/PageWindow.ts";

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

/** What is open over the page, and what it was opened with. */
export const Overlay = UiSchema.TaggedEnum({
  Later: { title: Schema.String, basis: Schema.NullOr(Schema.Number) },
  Never: { title: Schema.String, basis: Schema.NullOr(Schema.Number) },
  Correct: { id: Schema.String, title: Schema.String, verdict: Schema.String, app: Schema.String, jobId: Schema.String },
  Brief: {},
  Find: { q: Schema.String },
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
  overlay: Schema.NullOr(Overlay),
  /** How many overlays have opened: each opening starts its sheet afresh. */
  opened: Schema.Number,
  /** The owner's ways out, newest last, for u. */
  actions: Schema.Array(Schema.Struct({ id: Schema.String, seq: Schema.NullOr(Schema.Number) })),
  toast: Schema.Struct({ text: Schema.String, kind: Schema.String, shown: Schema.Boolean, n: Schema.Number }),
  /** A status read asked for while the stream is away; one at a time. */
  statusPending: Schema.Boolean,
  theme: Schema.NullOr(Theme),
});
export type AppModel = typeof AppModel.Type;

export const AppProps = Schema.Struct({ initialTheme: Schema.NullOr(Theme), initialCollapsed: Collapsed, now: Sample });

// ---------------------------------------------------------------- messages

export const AppMessage = UiSchema.TaggedEnum({
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
  RequestedItemAction: { action: ItemAction },
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
  SucceededAct: { id: Schema.String, before: Rows, action: Schema.String, decided: Decided, at: Sample },
  FailedAct: { status: Schema.Number, message: Schema.String },
  SucceededUndo: { id: Schema.String, decided: Decided, at: Sample },
  FailedUndo: { status: Schema.Number, message: Schema.String },
  SucceededMarkSeen: { decided: Decided, at: Sample },
  FailedMarkSeen: {},
  ElapsedSeenWait: { id: Schema.String },
  ElapsedToast: { n: Schema.Number },
  SucceededInvestigate: {},
  SucceededRequestFix: {},
  SucceededPublish: { published: Published },
  FailedRequest: { message: Schema.String },
});
export type AppMessage = typeof AppMessage.Type;

// ---------------------------------------------------------------- commands

/** The page's own clocks, sampled together: the wall clock and the monotonic one. */
const sample = Effect.all({ wallMs: Clock.currentTimeMillis, monoMs: Effect.map(Clock.currentTimeNanos, (n) => Number(n) / 1e6) });

const failed = (error: { readonly message: string }) => AppMessage.FailedRequest({ message: error.message });

class FetchStatus extends Command.Service<FetchStatus>()("app/FetchStatus", { args: {}, success: AppMessage }) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return () =>
      Effect.all([api.status, sample]).pipe(
        Effect.match({ onSuccess: ([snapshot, at]) => AppMessage.SucceededStatus({ snapshot, at }), onFailure: () => AppMessage.FailedStatus() }),
      );
  }));
}

/** A way out, bound to the position the owner was shown: if it changed since, the service refuses it. */
export class Act extends Command.Service<Act>()("app/Act", {
  args: { id: Schema.String, body: WayOutBody, basis: Schema.optional(Schema.NullOr(Schema.Number)), before: Rows },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id, body, basis, before }) =>
      Effect.all([api.act(id, basis === undefined ? body : { ...body, basisSeq: basis }), sample]).pipe(
        Effect.match({
          onSuccess: ([decided, at]) => AppMessage.SucceededAct({ id, before, action: body.action, decided, at }),
          onFailure: (error) => AppMessage.FailedAct({ status: error.status, message: error.message }),
        }),
      );
  }));
}

export class Undo extends Command.Service<Undo>()("app/Undo", {
  args: { id: Schema.String, seq: Schema.NullOr(Schema.Number) },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id, seq }) =>
      Effect.all([api.act(id, { action: "undo", actionSeq: seq } as ActionBody), sample]).pipe(
        Effect.match({
          onSuccess: ([decided, at]) => AppMessage.SucceededUndo({ id, decided, at }),
          onFailure: (error) => AppMessage.FailedUndo({ status: error.status, message: error.message }),
        }),
      );
  }));
}

/** Seen means looked at: the row held focus for a moment. */
class MarkSeen extends Command.Service<MarkSeen>()("app/MarkSeen", {
  args: { id: Schema.String, throughSeq: Schema.Number },
  success: AppMessage,
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id, throughSeq }) =>
      Effect.all([api.act(id, { action: "seen", throughSeq }), sample]).pipe(
        Effect.match({ onSuccess: ([decided, at]) => AppMessage.SucceededMarkSeen({ decided, at }), onFailure: () => AppMessage.FailedMarkSeen() }),
      );
  }));
}

/** O: the focused thing in an ordinary OpenCode session. The tab opens with the key press; the address follows. */
class OpenInOpenCode extends Command.Service<OpenInOpenCode>()("app/OpenInOpenCode", {
  args: { subject: Schema.String },
  success: Schema.Union([AppMessage, Component.Noop]),
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    const page = yield* PageWindow;
    return ({ subject }) =>
      page.openTab(Effect.flatMap(api.focus(subject), (focus) => api.open(subject, focus.requestKey))).pipe(
        Effect.match({ onSuccess: () => Component.noop, onFailure: failed }),
      );
  }));
}

class Investigate extends Command.Service<Investigate>()("app/Investigate", {
  args: { id: Schema.String },
  success: AppMessage,
  invalidates: () => [ItemsTag],
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id }) =>
      Effect.flatMap(api.focus(id), (focus) => api.investigate(id, focus.requestKey)).pipe(
        Effect.match({ onSuccess: () => AppMessage.SucceededInvestigate(), onFailure: failed }),
      );
  }));
}

/** F: a fix proposal on the latest investigation; the answer, a proposal or the rule that stops it, appears in place. */
class RequestFix extends Command.Service<RequestFix>()("app/RequestFix", {
  args: { id: Schema.String, jobId: Schema.String },
  success: AppMessage,
  invalidates: () => [ItemsTag],
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id, jobId }) =>
      Effect.flatMap(api.focus(id), (focus) => api.fix(id, jobId, focus.requestKey)).pipe(
        Effect.match({ onSuccess: () => AppMessage.SucceededRequestFix(), onFailure: failed }),
      );
  }));
}

/** Shift-P: the verified candidate's draft pull request, bound to what the owner is looking at. */
class Publish extends Command.Service<Publish>()("app/Publish", {
  args: { id: Schema.String, fixId: Schema.String, basis: Schema.NullOr(Schema.Number) },
  success: AppMessage,
  invalidates: () => [ItemsTag],
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const api = yield* Overwatch;
    return ({ id, fixId, basis }) =>
      Effect.flatMap(api.focus(id), (focus) => api.publish(fixId, basis, focus.requestKey)).pipe(
        Effect.match({ onSuccess: (published) => AppMessage.SucceededPublish({ published }), onFailure: failed }),
      );
  }));
}

const ReadItemAgain = Command.make("ReadItemAgain", { args: {} }, () => GetItem.invalidate().pipe(Effect.as(Component.noop)));

export const WaitBeforeSeen = Command.make("WaitBeforeSeen", { args: { id: Schema.String }, mode: "switch" }, ({ id }) =>
  Effect.sleep(Duration.millis(m.SEEN_AFTER_MS)).pipe(Effect.as(AppMessage.ElapsedSeenWait({ id }))));

export const WaitBeforeDismissal = Command.make("WaitBeforeDismissal", { args: { n: Schema.Number }, mode: "switch" }, ({ n }) =>
  Effect.sleep(Duration.millis(3200)).pipe(Effect.as(AppMessage.ElapsedToast({ n }))));

/** What the page keeps in this browser: the theme and which groups are open. Without storage it only forgets. */
class Remember extends Command.Service<Remember>()("app/Remember", {
  args: { key: Schema.String, value: Schema.String },
  success: Component.Noop,
}) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    return ({ key, value }) => store.set(key, value).pipe(Effect.ignore, Effect.as(Component.noop));
  }));
}

class ScrollToTop extends Command.Service<ScrollToTop>()("app/ScrollToTop", { args: {}, success: Component.Noop }) {
  static readonly layer = this.toLayer(Effect.gen(function* () {
    const page = yield* PageWindow;
    return () => page.scrollToTop.pipe(Effect.as(Component.noop));
  }));
}

// ---------------------------------------------------------------- update

const AppDef = Html.component({
  name: "App",
  props: AppProps,
  model: AppModel,
  message: AppMessage,
  queries: {
    detail: {
      query: GetItem,
      args: ({ model }) => (m.isIncident(model.focus) && model.snapshot !== null ? { id: model.focus, seq: model.snapshot.seq } : undefined),
    },
  },
});

const connectionOf = (model: AppModel): m.Connection => freshness(model.last, model.now);
const down = (model: AppModel) => connectionOf(model) === "down";
const incidentOf = (model: AppModel, id: string | null) => (id === null ? undefined : model.snapshot?.incidents.find((i) => i.id === id));
const rowsOf = (model: AppModel) => (model.shown ? m.order(model.shown, model.collapsed) : []);
/** The focused item in full, when it has been read. */
const detailOf = (model: AppModel, result: AsyncResult.AsyncResult<ItemDetail, unknown>): ItemDetail | null =>
  AsyncResult.isSuccess(result) && result.value.incident.id === model.focus ? result.value : null;

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

export const AppNoDeps = AppDef.make({
  init: ($) => ({
    snapshot: null,
    last: null,
    now: $.props.now,
    anchor: null,
    shown: null,
    collapsed: $.props.initialCollapsed,
    focus: null,
    overlay: null,
    opened: 0,
    actions: [],
    toast: { text: "", kind: "", shown: false, n: 0 },
    statusPending: false,
    theme: $.props.initialTheme,
  }),
  update: ($, message) => {
    const model = $.model;
    const detail = detailOf(model, $.queries.detail);

    /** A note in the corner, for a few seconds. */
    const say = (next: AppModel, text: string, kind = "") => {
      const n = next.toast.n + 1;
      return $.set({ ...next, toast: { text, kind, shown: true, n } }).run(WaitBeforeDismissal.make({ n }));
    };
    /** Puts a subject in focus: its item is read, and held for a moment it counts as seen. */
    const focusOn = (next: AppModel, subject: string | null) => {
      if (next.focus === subject) return $.set(next);
      const focused = { ...next, focus: subject };
      return m.isIncident(subject) ? $.set(focused).run(WaitBeforeSeen.make({ id: subject })) : $.set(focused);
    };
    const open = (overlay: Overlay) => $.set({ ...model, overlay, opened: model.opened + 1 });
    /** Done, Later or Never on the item in focus. */
    const wayOut = (body: WayOutBody, basis: number | null | undefined, next: AppModel = model) => {
      const id = next.focus;
      if (!m.isIncident(id) || down(next)) return $.set(next);
      return $.set(next).run(Act.make({ id, body, ...(basis === undefined ? {} : { basis }), before: [...rowsOf(next)] }));
    };
    const sheet = (kind: "later" | "never") => {
      const i = incidentOf(model, model.focus);
      if (!i || down(model)) return model;
      const basis = i.decidedSeq ?? null;
      return open(kind === "later" ? Overlay.Later({ title: i.title, basis }) : Overlay.Never({ title: i.title, basis }));
    };
    const undo = () => {
      if (down(model)) return model;
      const fallback = m.isIncident(model.focus) ? incidentOf(model, model.focus)?.way : undefined;
      const last = model.actions.at(-1) ?? (fallback && model.focus !== null ? { id: model.focus, seq: fallback.seq } : null);
      if (!last) return say(model, "Nothing to undo");
      return $.set({ ...model, actions: model.actions.slice(0, -1) }).run(Undo.make(last));
    };
    const latestDone = () => detail?.investigations.filter((x) => x.result).at(-1);
    const correct = () => {
      const i = incidentOf(model, model.focus);
      const job = latestDone();
      if (!i || !job?.result || down(model)) return say(model, job ? "Service not answering" : "Nothing investigated to correct yet");
      return open(Overlay.Correct({ id: i.id, title: i.title, verdict: m.verdictView(job.result).label, app: i.app, jobId: job.jobId }));
    };
    const investigate = () => (m.isIncident(model.focus) && !down(model) ? $.run(Investigate.make({ id: model.focus })) : model);
    const fix = () => {
      const job = latestDone();
      return m.isIncident(model.focus) && !down(model) && job ? $.run(RequestFix.make({ id: model.focus, jobId: job.jobId })) : model;
    };
    const publish = (fixId = detail?.fixes.find((f) => f.action)?.id) => {
      const id = model.focus;
      if (!fixId || !m.isIncident(id) || down(model)) return model;
      return say(model, "Opening the draft: protection, push, then the pull request, each read back…", "ok")
        .run(Publish.make({ id, fixId, basis: incidentOf(model, id)?.decidedSeq ?? null }));
    };
    const openInOpenCode = () => {
      if (!model.focus || down(model)) return say(model, model.focus ? "Service not answering" : "Put something in focus first");
      return $.run(OpenInOpenCode.make({ subject: model.focus }));
    };
    const toggleTheme = () => {
      const theme = model.theme === "light" ? "dark" : "light";
      return $.evolve({ theme }).run(Remember.make({ key: "ow-theme", value: theme }));
    };
    const refresh = () => (model.snapshot ? $.evolve({ shown: m.freeze(model.snapshot.inbox) }) : model);
    const close = () => $.evolve({ overlay: null });

    switch (message._tag) {
      case "ReceivedSnapshot":
        return $.set(apply({ ...model, last: message.at, now: message.at }, message.snapshot, message.at));
      case "ReceivedHeartbeat": {
        const at = message.atMs;
        const anchor = at !== null && (!model.anchor || at >= model.anchor.atMs) ? { atMs: at, monoMs: message.at.monoMs } : model.anchor;
        return $.evolve({ last: message.at, now: message.at, anchor });
      }
      case "LostChanges":
        // Ask for status once while the stream is away; its answer updates data only, never liveness.
        return model.statusPending ? model : $.evolve({ statusPending: true }).run(FetchStatus.make());
      case "Ticked":
        return $.evolve({ now: message.at });
      case "SucceededStatus":
        return $.set(apply({ ...model, statusPending: false }, message.snapshot, message.at));
      case "FailedStatus":
        return $.evolve({ statusPending: false });

      case "PressedKey": {
        const rows = rowsOf(model);
        switch (message.command) {
          case "escape": return model.overlay ? close() : model;
          case "search": return open(Overlay.Find({ q: "" }));
          case "next": return focusOn(model, m.step(rows, model.focus, 1));
          case "previous": return focusOn(model, m.step(rows, model.focus, -1));
          case "done": return wayOut({ action: "done" }, incidentOf(model, model.focus)?.decidedSeq);
          case "later": return sheet("later");
          case "never": return sheet("never");
          case "worse": return wayOut({ action: "later", when: "worse" }, incidentOf(model, model.focus)?.decidedSeq);
          case "undo": return undo();
          case "refresh": return refresh();
          case "prompt": return model.focus ? model : open(Overlay.Find({ q: "" }));
          case "theme": return toggleTheme();
          case "help": return open(Overlay.Keys());
          case "open": return openInOpenCode();
          case "brief": return open(Overlay.Brief());
          case "investigate": return investigate();
          case "correct": return correct();
          case "fix": return fix();
          case "publish": return publish();
        }
        return model;
      }
      case "ClickedTheme": return toggleTheme();
      case "ClickedHelp": return open(Overlay.Keys());

      case "PickedSubject": return focusOn(model, message.subject);
      case "PickedResult": return focusOn({ ...model, overlay: null }, message.id);
      case "ToggledGroup": {
        const collapsed = { ...model.collapsed, [message.group]: !message.open };
        return $.evolve({ collapsed }).run(Remember.make({ key: "ow-groups", value: JSON.stringify(collapsed) }));
      }
      case "RequestedRefresh": return refresh();
      case "RequestedInbox": return $.evolve({ focus: null }).run(ScrollToTop.make());
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
        return model;
      case "RequestedPublish": return publish(message.fixId);
      case "CopiedText": return say(model, `Copied ${message.text}`, "ok");
      case "FailedCopy": return say(model, `Copy failed: ${message.reason}`, "error");
      case "RequestedFind": return open(Overlay.Find({ q: message.text }));
      case "AskedAgent":
        return say(model, message.mode === "new" ? "Queued: an agent answers here, under Questions." : "Added to the queued request.", "ok");
      case "FailedAsk": return say(model, message.message, "error");
      case "SubmittedWayOut": {
        const basis = model.overlay?._tag === "Later" || model.overlay?._tag === "Never" ? model.overlay.basis : undefined;
        return wayOut(message.body, basis, { ...model, overlay: null });
      }
      case "SavedCorrection": return say({ ...model, overlay: null }, "Saved to the playbook.", "ok");
      case "CopiedBrief": return say(model, "Copied. Nothing was sent.", "ok");
      case "FailedBrief": return say(model, message.message, "error");
      case "ClosedOverlay": return close();

      case "SucceededAct": {
        const { id, before, decided, at } = message;
        const removed = { ...model, actions: [...model.actions, { id, seq: decided.action.seq }], shown: m.without(model.shown ?? {}, id) };
        const next = m.after(before, id, id);
        const applied = apply(removed, decided, at);
        const word = message.action === "done" ? "Done" : message.action === "never" ? "Never" : "Later";
        const said = say(next && next !== id ? { ...applied, focus: next } : applied, `${word}: ${incidentOf(applied, id)?.title ?? ""} · u puts it back`);
        return next && next !== id && m.isIncident(next) ? said.run(WaitBeforeSeen.make({ id: next })) : said;
      }
      case "FailedAct":
        return message.status === 409
          ? say(model, "This changed since you looked (another tab or a return). Look again, then decide.", "error").run(ReadItemAgain.make())
          : say(model, message.message, "error");
      case "SucceededUndo": {
        const restored = apply({ ...model, shown: m.restore(model.shown ?? {}, message.decided.inbox, message.id) }, message.decided, message.at);
        return say({ ...restored, focus: message.id }, "Put back").run(WaitBeforeSeen.make({ id: message.id }));
      }
      case "FailedUndo": return say(model, message.status === 409 ? "That changed since: nothing undone" : message.message, "error");
      case "SucceededMarkSeen": return $.set(apply(model, message.decided, message.at));
      case "FailedMarkSeen": return model;
      case "ElapsedSeenWait": {
        const i = incidentOf(model, message.id);
        if (model.focus !== message.id || !i || down(model) || i.lastSeq <= (i.seenSeq ?? 0) || !model.snapshot) return model;
        return $.run(MarkSeen.make({ id: message.id, throughSeq: model.snapshot.seq }));
      }
      case "ElapsedToast":
        return message.n === model.toast.n ? $.evolve({ toast: { ...model.toast, shown: false } }) : model;
      case "SucceededInvestigate": return say(model, "Investigation queued: independent readings, then a challenger if most say real.", "ok");
      case "SucceededRequestFix": return say(model, "Fix requested: every rule is checked before anything is proposed.", "ok");
      case "SucceededPublish": {
        const fixed = message.published.fix;
        return fixed?.pr ? say(model, `Draft #${fixed.pr.number} opened.`, "ok") : say(model, `Stopped: ${fixed?.reason ?? "see the item"}`, "error");
      }
      case "FailedRequest": return say(model, message.message, "error");
    }
  },
  head: ({ model }) => [
    Head.title("Overwatch"),
    HtmlHead.bodyData("data-link", connectionOf(model)),
    ...(model.theme === null ? [] : [HtmlHead.htmlData("data-theme", model.theme)]),
  ],
  subscriptions: ({ model }) => [
    Subscription.make("changes", Stream.unwrap(Effect.gen(function* () {
      return (yield* ServiceEvents).changes;
    })).pipe(
      Stream.mapEffect((event) =>
        Effect.map(sample, (at): AppMessage =>
          event._tag === "Snapshot" ? AppMessage.ReceivedSnapshot({ snapshot: event.snapshot, at })
            : event._tag === "Heartbeat" ? AppMessage.ReceivedHeartbeat({ atMs: event.atMs ?? null, at })
            : AppMessage.LostChanges())
      ),
    )),
    // The page's own clock: once a second, whatever any request is doing.
    Subscription.make("clock", Stream.tick(Duration.seconds(1)).pipe(Stream.mapEffect(() => Effect.map(sample, (at) => AppMessage.Ticked({ at }))))),
    HtmlSubscription.onDocument("keydown", ({ key, editable, shift, meta, ctrl }) => {
      const command = m.command(key, { typing: editable, overlay: model.overlay !== null, shift, meta: meta || ctrl });
      // With something in focus, p and Enter go to the bar, which takes them itself.
      return command === null || (command === "prompt" && model.focus !== null) ? undefined : AppMessage.PressedKey({ command });
    }, { preventDefault: true }),
  ],
  view: (h, model) => {
    const connection = connectionOf(model);
    const quiet = Math.round(silence(model.last, model.now) / 1000);
    const serverNow = m.serverNow(model.anchor, model.now.monoMs);
    const detail = detailOf(model, h.queries.detail);
    const focused = m.isIncident(model.focus) ? incidentOf(model, model.focus) ?? detail?.incident : undefined;
    const label = model.focus === null ? "" : focused ? `${focused.app}/${focused.environment} · ${focused.title}` : model.focus.slice(4).replaceAll("/", " / ");
    const isDown = connection === "down";
    const overlay = model.overlay;
    const key = String(model.opened);
    const closeSheet = { RequestedClose: () => AppMessage.ClosedOverlay() };
    return h.div.attr("style", "display: contents").children(
      h.header.class("topbar").children(
        h.a.class("brand").attrs({ href: "/", "aria-label": "Overwatch" }).children(
          h.img.attrs({ src: "logo.svg", alt: "", width: "28", height: "28" }),
          h.span.class("wordmark").children("Overwatch", h.i(".")),
        ),
        h.span.class("connection").attrs({ "data-connection": connection, "aria-live": "polite" }).children(
          h.span.class("pulse").attr("aria-hidden", "true"),
          h.span.class("connection-text").children(
            connection === "live" ? "Live" : connection === "stale" ? `Stale · ${quiet}s` : connection === "down" ? "Not answering" : "Connecting…",
          ),
        ),
        h.span.class("spacer"),
        h.div.class("tools").children(
          h.button.class("icon-button").attrs({ type: "button", "data-theme-toggle": "", title: "Theme (t)", "aria-label": "Toggle theme" })
            .on("click", AppMessage.ClickedTheme()).children(ThemeIcon(h)),
          h.button.class("icon-button").attrs({ type: "button", "data-help": "", title: "Keyboard (?)", "aria-label": "Keyboard shortcuts" })
            .on("click", AppMessage.ClickedHelp()).children(KeyboardIcon(h)),
        ),
      ),
      Banners(h, { props: { snapshot: model.snapshot, connection, silence: quiet } }),
      Strip(h, {
        props: { snapshot: model.snapshot, connection, serverNow, focus: model.focus },
        onEmit: { Picked: ({ subject }) => AppMessage.PickedSubject({ subject }) },
      }),
      h.main.class("deck").children(
        Inbox(h, {
          props: { snapshot: model.snapshot, shown: model.shown, collapsed: model.collapsed, focus: model.focus },
          onEmit: {
            Picked: ({ id }) => AppMessage.PickedSubject({ subject: id }),
            RequestedRefresh: () => AppMessage.RequestedRefresh(),
            Toggled: ({ group, open }) => AppMessage.ToggledGroup({ group, open }),
          },
        }),
        Stage(h, {
          props: { snapshot: model.snapshot, focus: model.focus, detail, connection, serverNow, wallNow: model.now.wallMs },
          onEmit: {
            RequestedInbox: () => AppMessage.RequestedInbox(),
            Picked: ({ subject }) => AppMessage.PickedSubject({ subject }),
            RequestedAction: ({ action }) => AppMessage.RequestedItemAction({ action }),
            RequestedPublish: ({ fixId }) => AppMessage.RequestedPublish({ fixId }),
            Copied: ({ text }) => AppMessage.CopiedText({ text }),
            FailedCopy: ({ reason }) => AppMessage.FailedCopy({ reason }),
          },
        }),
        Dock(h, {
          props: { focus: model.focus, label, down: isDown, overlay: overlay !== null },
          onEmit: {
            RequestedFind: ({ text }) => AppMessage.RequestedFind({ text }),
            Asked: ({ mode }) => AppMessage.AskedAgent({ mode }),
            FailedAsk: ({ message }) => AppMessage.FailedAsk({ message }),
          },
        }),
      ),
      h.div.class("toast", model.toast.shown && "show", model.toast.shown && model.toast.kind)
        .attrs({ "data-toast": "", role: "status", "aria-live": "polite" })
        .children(model.toast.text),
      h.div.attr("data-overlay", "").children(
        overlay === null ? null
          : overlay._tag === "Later" || overlay._tag === "Never"
          ? WayOutSheet(h, {
            key,
            props: { kind: overlay._tag === "Later" ? "later" : "never", title: overlay.title, nowMs: model.now.wallMs },
            onEmit: { ...closeSheet, Submitted: ({ body }) => AppMessage.SubmittedWayOut({ body }) },
          })
          : overlay._tag === "Correct"
          ? CorrectSheet(h, {
            key,
            props: { id: overlay.id, title: overlay.title, verdict: overlay.verdict, app: overlay.app, jobId: overlay.jobId },
            onEmit: { ...closeSheet, Saved: () => AppMessage.SavedCorrection() },
          })
          : overlay._tag === "Brief"
          ? BriefSheet(h, {
            key,
            onEmit: {
              ...closeSheet,
              Copied: () => AppMessage.CopiedBrief(),
              FailedCopy: ({ reason }) => AppMessage.FailedCopy({ reason }),
              Failed: ({ message }) => AppMessage.FailedBrief({ message }),
            },
          })
          : overlay._tag === "Find"
          ? Finder(h, {
            key,
            props: { initialQuery: overlay.q, incidents: model.snapshot?.incidents ?? [] },
            onEmit: { ...closeSheet, Picked: ({ id }) => AppMessage.PickedResult({ id }) },
          })
          : KeysSheet(h, { key, onEmit: closeSheet }),
      ),
    );
  },
});

/** The commands and services the page runs, over the HTTP client the entry provides. */
export const AppLayer = Layer.mergeAll(
  FetchStatus.layer,
  Act.layer,
  Undo.layer,
  MarkSeen.layer,
  OpenInOpenCode.layer,
  Investigate.layer,
  RequestFix.layer,
  Publish.layer,
  ScrollToTop.layer,
  Remember.layer,
  GetItem.layer,
  ServiceEvents.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(Overwatch.layer, PageWindow.layer, BrowserKeyValueStore.layerLocalStorage)));

export const App = AppNoDeps.pipe(Component.provide(AppLayer));
