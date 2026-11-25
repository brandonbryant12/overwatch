/**
 * The Overwatch page: the inbox, the thing in focus, archive, and the prompt bar. Live: every read is a `watch`.
 *
 * View logic only. Elements carry semantic class names (`inbox`, `item`, `focus`, `prompt-bar`...) and every style
 * lives in style.css, so a design pass can change how it looks without touching this file.
 */
import * as DomainFoldkit from "@alchemy.run/domain/Foldkit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Subscription, type Update } from "foldkit";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { IncidentId, ThreadId, threadIdOf } from "../../src/domain/ids.ts";
import { OverwatchApi } from "../../src/domain/model.ts";
import { routePrompt } from "../../src/domain/route.ts";
import { IncidentPageState, InboxItem, ThreadPageState } from "../../src/domain/views.ts";

export const Client = DomainFoldkit.make(OverwatchApi);
/** What the page's Commands and Subscriptions need: the typed client. */
export type Services = (typeof OverwatchApi)["Client"]["Identifier"];
type Return = Update.Return<Model, Message, Services>;

export const Override = Schema.Literals(["auto", "new", "here"]);

export const Model = Schema.Struct({
  commandIds: DomainFoldkit.CommandIds,
  live: Schema.Boolean,
  inbox: Schema.Array(InboxItem),
  focus: Schema.NullOr(IncidentId),
  page: Schema.NullOr(IncidentPageState),
  thread: Schema.NullOr(ThreadPageState),
  draft: Schema.String,
  override: Override,
  notice: Schema.NullOr(Schema.String),
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ReceivedInbox: { items: Schema.Array(InboxItem) },
  ReceivedPage: { page: Schema.NullOr(IncidentPageState) },
  ReceivedThread: { thread: Schema.NullOr(ThreadPageState) },
  FailedRead: { reason: Schema.String },
  ClickedItem: { incidentId: IncidentId },
  ClickedArchive: { incidentId: IncidentId },
  ChangedDraft: { text: Schema.String },
  ChangedOverride: { override: Override },
  SubmittedPrompt: {},
  ReceivedResult: { result: Client.Message },
});
export type Message = typeof Message.Type;

export const Flags = Schema.Struct({ session: Schema.String });
export type Flags = typeof Flags.Type;

export const init = (flags: Flags): Return => ({
  model: {
    commandIds: { session: flags.session, sent: 0 },
    live: false,
    inbox: [],
    focus: null,
    page: null,
    thread: null,
    draft: "",
    override: "auto",
    notice: null,
  },
});

/** What the prompt bar will do if sent now: the same pure function the Thread aggregate applies. */
export function preview(model: Model): string {
  if (!model.focus) return "Put something in focus to prompt on it.";
  const sessions = (model.thread?.sessions ?? []).map((s) => ({
    sessionId: s.sessionId,
    mode: "investigate" as const,
    status: s.status as "pending" | "running" | "idle" | "failed",
  }));
  const route = routePrompt(sessions, "investigate", model.override);
  return route.kind === "new" ? `new session: ${route.reason}` : `continues ${route.sessionId}: ${route.reason}`;
}

const failureText = (failure: { readonly _tag: string }) => (failure._tag === "Rejected" ? "refused" : failure._tag === "Denied" ? "not allowed" : "not confirmed; try again");

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedInbox: ({ items }) => ({ model: { ...model, inbox: items, live: true } }),
    ReceivedPage: ({ page }) => ({ model: { ...model, page } }),
    ReceivedThread: ({ thread }) => ({ model: { ...model, thread } }),
    FailedRead: ({ reason }) => ({ model: { ...model, live: false, notice: `Live updates stopped: ${reason}` } }),
    ClickedItem: ({ incidentId }) => ({ model: { ...model, focus: incidentId, page: null, thread: null } }),
    ClickedArchive: ({ incidentId }) => {
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      return {
        model: { ...model, commandIds, focus: model.focus === incidentId ? null : model.focus, notice: null },
        commands: [Command.mapMessage(Client.ArchiveIncident({ target: incidentId, input: { actor: "owner (page)" }, commandId }), (result) => Message.ReceivedResult({ result }))],
      };
    },
    ChangedDraft: ({ text }) => ({ model: { ...model, draft: text } }),
    ChangedOverride: ({ override }) => ({ model: { ...model, override } }),
    SubmittedPrompt: () => {
      if (!model.focus || !model.draft.trim()) return { model };
      const { commandId, commandIds } = DomainFoldkit.next(model.commandIds);
      const title = model.page?.title ?? model.inbox.find((i) => i.incidentId === model.focus)?.title ?? model.focus;
      return {
        model: { ...model, commandIds, draft: "", notice: null },
        commands: [
          Command.mapMessage(
            Client.AskThread({
              target: threadIdOf(model.focus),
              input: { subject: model.focus, title, promptId: commandId, text: model.draft.trim(), mode: "investigate", origin: "page", override: model.override },
              commandId,
            }),
            (result) => Message.ReceivedResult({ result }),
          ),
        ],
      };
    },
    ReceivedResult: ({ result }) =>
      Client.Message.match(result, {
        SucceededArchiveIncident: () => ({ model }),
        FailedArchiveIncident: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, notice: `Archive ${failureText(failure)}` } }),
        SucceededAskThread: () => ({ model }),
        FailedAskThread: ({ failure }: { failure: { readonly _tag: string } }) => ({ model: { ...model, notice: `Prompt ${failureText(failure)}` } }),
        SucceededSearch: () => ({ model }),
        FailedSearch: () => ({ model }),
      } as never) as Return,
  });

export const subscriptions = Subscription.make<Model, Message, Services>()(() => ({
  inbox: Client.Inbox.watch({
    key: () => "inbox",
    toMessage: ({ state }): Message => Message.ReceivedInbox({ items: Option.match(state, { onNone: () => [], onSome: (s) => s.items }) }),
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
}));

const time = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.inbox.length ? `Overwatch (${model.inbox.length})` : "Overwatch",
  body: h.div(
    [h.Class("app")],
    [
      h.header([h.Class("top")], [h.h1([], ["Overwatch"]), h.span([h.Class(model.live ? "live on" : "live off")], [model.live ? "live" : "connecting"])]),
      ...(model.notice ? [h.p([h.Class("notice")], [model.notice])] : []),
      h.main(
        [h.Class("columns")],
        [
          h.section(
            [h.Class("inbox")],
            [
              h.h2([], [`Inbox (${model.inbox.length})`]),
              model.inbox.length === 0
                ? h.p([h.Class("empty")], ["Nothing needs a look."])
                : h.ul(
                    [],
                    model.inbox.map((item) =>
                      h.li(
                        [h.Class(item.incidentId === model.focus ? "item focused" : "item"), h.OnClick(Message.ClickedItem({ incidentId: item.incidentId }))],
                        [
                          h.span([h.Class(`severity ${item.severity}`)], [item.severity]),
                          h.span([h.Class("title")], [item.title]),
                          h.span([h.Class("where")], [`${item.app}/${item.environment}`]),
                          h.span([h.Class("count")], [`${item.occurrences}×, last ${time(item.lastAt)}`]),
                          ...(item.verdict ? [h.span([h.Class("verdict")], [`${item.verdict}: ${item.cause ?? ""}`])] : []),
                          h.button([h.Class("archive"), h.OnClick(Message.ClickedArchive({ incidentId: item.incidentId }))], ["Archive"]),
                        ],
                      ),
                    ),
                  ),
            ],
          ),
          h.section([h.Class("focus")], focusView(model, h)),
        ],
      ),
      h.form(
        [h.Class("prompt-bar"), h.OnSubmit(Message.SubmittedPrompt())],
        [
          h.input([h.Class("prompt"), h.Placeholder(model.focus ? "Ask about the incident in focus" : "Select an incident first"), h.Value(model.draft), h.OnInput((text) => Message.ChangedDraft({ text })), h.Disabled(!model.focus)]),
          h.select(
            [h.Class("override"), h.OnChange((value) => Message.ChangedOverride({ override: value as "auto" | "new" | "here" }))],
            (["auto", "new", "here"] as const).map((value) => h.option([h.Value(value), ...(model.override === value ? [h.Selected(true)] : [])], [value])),
          ),
          h.button([h.Class("send"), h.Disabled(!model.focus || !model.draft.trim())], ["Send"]),
          h.span([h.Class("route")], [preview(model)]),
        ],
      ),
    ],
  ),
});

function focusView(model: Model, h: HtmlBuilder<Message>) {
  if (!model.focus) return [h.p([h.Class("empty")], ["Select an incident to see it here and prompt on it."])];
  const page = model.page;
  if (!page) return [h.p([h.Class("empty")], ["Loading…"])];
  return [
    h.h2([], [page.title]),
    h.p([h.Class("meta")], [`${page.app}/${page.environment} · ${page.source} · ${page.occurrences} occurrence(s) · ${page.disposition}`]),
    ...(page.sample ? [h.pre([h.Class("sample")], [page.sample])] : []),
    h.h3([], ["Timeline"]),
    h.ul([h.Class("timeline")], page.timeline.map((entry) => h.li([], [`${time(entry.at)} ${entry.kind}: ${entry.text}`]))),
    h.h3([], ["Findings"]),
    page.findings.length === 0
      ? h.p([h.Class("empty")], ["None yet."])
      : h.ul(
          [h.Class("findings")],
          page.findings.map(({ finding, at }) =>
            h.li(
              [],
              [
                h.p([h.Class("verdict")], [`${time(at)} ${finding.engineering.verdict} (${finding.engineering.confidence}): ${finding.engineering.cause}`]),
                h.p([], [finding.product.impact]),
                h.ul(
                  [h.Class("evidence")],
                  finding.engineering.evidence.map((e) => h.li([h.Class(e.verified ? "verified" : "unverified")], [`${e.verified ? "✓" : "?"} ${e.source}: ${e.quote}`])),
                ),
              ],
            ),
          ),
        ),
    h.h3([], ["Thread"]),
    model.thread
      ? h.ul(
          [h.Class("prompts")],
          model.thread.prompts.map((p) => h.li([h.Class(`prompt-status ${p.status}`)], [`${time(p.at)} [${p.status}] ${p.origin}: ${p.text} (${p.reason}${p.failure ? `; ${p.failure}` : ""})`])),
        )
      : h.p([h.Class("empty")], ["No prompts yet."]),
  ];
}
