/**
 * The stage: what is in focus, in full. A problem with its verdict, fix, claims, questions, counts and history; an
 * environment or a source with its readings and coverage; or, with nothing in focus, the overview and its keys.
 */
import { Clipboard } from "@effect/platform-browser";
import { Effect, Predicate, Schema } from "effect";
import {
  type Finding,
  type Fix,
  type HistoryEvent,
  type Incident,
  InvestigationResult,
  ItemDetail,
  type Piece,
  Snapshot,
} from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { Command, defineView, el, emit, type H as Builder, run, type Step, TaggedEnum } from "../ui.ts";
import { causeTitle } from "./Banners.ts";
import { HealthGlyph, SeverityGlyph, Spark } from "./Glyphs.ts";
import { ahead, OutlookPanels } from "./Outlook.ts";

export const Props = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  focus: Schema.NullOr(Schema.String),
  /** The focused item in full, when it has been read. */
  detail: Schema.NullOr(ItemDetail),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  serverNow: Schema.NullOr(Schema.Number),
  wallNow: Schema.Number,
});
export type Props = typeof Props.Type;

/** What the item's buttons ask for; the page decides what each means. */
export const ItemAction = Schema.Literals(["done", "later", "worse", "never", "undo", "investigate", "open", "correct", "fix"]);
export type ItemAction = typeof ItemAction.Type;

export const Model = Schema.Struct({});
export type Model = typeof Model.Type;
export const init: Model = {};

export const Message = TaggedEnum({
  ClickedBack: {},
  ClickedSubject: { subject: Schema.String },
  ClickedAction: { action: ItemAction },
  ClickedPublish: { fixId: Schema.String },
  ClickedHandle: { handle: Schema.String },
  SucceededCopyHandle: { handle: Schema.String },
  FailedCopyHandle: { reason: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  RequestedInbox: {},
  Picked: { subject: Schema.String },
  RequestedAction: { action: ItemAction },
  RequestedPublish: { fixId: Schema.String },
  Copied: { text: Schema.String },
  FailedCopy: { reason: Schema.String },
});
export type Events = typeof Events.Type;

/** Copies an evidence handle; nothing is sent anywhere. */
export const CopyHandle = Command.define("CopyHandle", {
  args: { handle: Schema.String },
  messages: [Message.SucceededCopyHandle, Message.FailedCopyHandle],
  execute: ({ handle }) =>
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;
      yield* clipboard.writeString(handle);
    }).pipe(
      Effect.match({
        onSuccess: () => Message.SucceededCopyHandle({ handle }),
        onFailure: (error) => Message.FailedCopyHandle({ reason: Predicate.isError(error.cause) ? error.cause.message : error.message }),
      }),
    ),
});

export const update = (model: Model, message: Message): Step<Model, Message, Events> =>
  Message.match(message, {
    ClickedBack: () => emit(model, Events.RequestedInbox()),
    ClickedSubject: ({ subject }) => emit(model, Events.Picked({ subject })),
    ClickedAction: ({ action }) => emit(model, Events.RequestedAction({ action })),
    ClickedPublish: ({ fixId }) => emit(model, Events.RequestedPublish({ fixId })),
    ClickedHandle: ({ handle }) => run(model, CopyHandle({ handle })),
    SucceededCopyHandle: ({ handle }) => emit(model, Events.Copied({ text: handle })),
    FailedCopyHandle: ({ reason }) => emit(model, Events.FailedCopy({ reason })),
  });

type H = Builder<Message>;

const WAY_LABEL: Record<string, string> = { done: "Done", later: "Later", never: "Never" };
const VERDICT: Record<string, string> = { real: "Real", not_real: "Not real", unsure: "Unsure" };
const decodeResult = Schema.decodeUnknownOption(InvestigationResult);

/** An event in an item's history, in words. */
export function eventText(e: HistoryEvent): string {
  const d = e.data;
  const text = (key: string) => String(d[key] ?? "");
  switch (e.kind) {
    case "action": {
      const worse = Predicate.hasProperty(d.way, "when") && Boolean(d.way.when);
      return d.action === "undo" ? "Put back (undo)" : `Put away: ${WAY_LABEL[text("action")] ?? text("action")}${worse ? " until worse" : ""}`;
    }
    case "returned": return `${m.RETURN_LABEL[text("code")] ?? "Back"} — ${text("reason")}`;
    case "asked": return `Asked: “${text("text")}”`;
    case "finding": return `Finding filed: ${text("verdict").replace("_", " ")}`;
    case "quieted": return "Went quiet";
    case "deadline": return "Later's time came";
    case "seen": return "Seen";
    case "investigation_queued": return `Investigation queued (${d.origin == null ? "manual" : text("origin")})`;
    case "adjudicated": {
      const v = decodeResult(d.result).pipe((o) => (o._tag === "Some" ? m.verdictView(o.value) : null));
      return v ? `Investigated: ${v.label} (${v.votes})` : "Investigated";
    }
    case "answered": return d.failed ? "A question went unanswered" : "A question was answered";
    case "corrected": return `Corrected: “${text("text")}”`;
    case "opened": return "Opened in OpenCode";
    case "incident": return d.metric ? `Gauge ${text("state")}` : "First counted";
    case "fix": return `Fix: ${m.FIX_LABEL[text("state")] ?? text("state")}${d.reason ? ` — ${text("reason")}` : ""}`;
    case "comparison": return d.regression ? `Staging regression: ${text("regression")}` : `Staging comparison: ${text("state")}`;
    default: return e.kind;
  }
}

const Kbd = (h: H, key: string) => el(h, "kbd", {}, key);

const Pieces = (h: H, pieces: ReadonlyArray<Piece>) =>
  pieces.map((p) =>
    el(
      h,
      "figure",
      { class: "evidence" },
      el(
        h,
        "figcaption",
        {},
        el(
          h,
          "button",
          { class: "handle", attrs: { type: "button", "data-handle": p.handle, title: `${p.handle} · click to copy` }, on: [h.OnClick(Message.ClickedHandle({ handle: p.handle }))] },
          m.shortHandle(p.handle),
        ),
        el(h, "span", {}, p.source),
      ),
      el(h, "pre", {}, p.text),
    )
  );

const SourceList = (h: H, sources: Snapshot["sources"], state: (x: Snapshot["sources"][number]) => string, withFix: boolean) =>
  el(
    h,
    "ul",
    { class: "sources" },
    ...sources.map((x) =>
      el(
        h,
        "li",
        { class: x.failure ? "failing" : "", attrs: { "data-subject": x.subject }, on: [h.Key(x.subject), h.OnClick(Message.ClickedSubject({ subject: x.subject }))] },
        el(h, "b", { class: "subject-link" }, x.id),
        el(h, "span", {}, state(x)),
        withFix && x.fix ? el(h, "code", {}, x.fix) : null,
      )
    ),
  );

const Coverage = (h: H, snapshot: Snapshot, coverage: Snapshot["coverage"]) =>
  el(
    h,
    "section",
    { class: "panel" },
    el(h, "h3", {}, "Coverage"),
    el(
      h,
      "ol",
      { class: "history" },
      ...(coverage.length
        ? coverage.map((c) =>
          el(
            h,
            "li",
            { class: ["cov", `cov-${c.state}`] },
            el(h, "span", { class: "ev-kind" }, `${c.reading}: ${c.state}${c.missed ? ` (${c.missed} missed)` : ""}`),
            el(h, "time", {}, m.ago(c.toMs, snapshot.atMs)),
          )
        )
        : [el(h, "li", {}, "Nothing read yet")]),
    ),
  );

/** The latest investigation: the verdict, how the readings voted, what the challenger did; disagreement shows. */
const VerdictPanel = (h: H, d: ItemDetail | null) => {
  const inv = d?.investigations.at(-1);
  if (!inv || (!inv.result && inv.state !== "queued" && inv.state !== "running")) return null;
  if (!inv.result) {
    return el(
      h,
      "section",
      { class: ["verdict", "working"] },
      el(h, "span", { class: "orbit", attrs: { "aria-hidden": "true" } }),
      el(h, "div", {}, el(h, "b", {}, "Investigating"), el(h, "span", {}, inv.state === "queued" ? "queued for the next free agent" : "independent readings under way")),
    );
  }
  const r = inv.result, v = m.verdictView(r);
  return el(
    h,
    "section",
    { class: ["verdict", v.tone], attrs: { "data-verdict": r.verdict, "data-tone": v.tone } },
    el(
      h,
      "header",
      {},
      el(h, "span", { class: "verdict-label" }, v.label),
      el(h, "span", { class: ["verdict-label", "votes"] }, v.votes),
      v.challenge !== null && el(h, "span", { class: "challenge-word" }, v.challenge),
      v.evidence !== null && el(h, "span", { class: ["pill", v.observed ? "observed" : "unobserved"] }, v.evidence),
    ),
    v.tone === "undecided" ? el(h, "p", { class: "note" }, "The readings could not settle it. It stays with you; look at what each one saw.")
      : v.tone === "disagreed" ? el(h, "p", { class: "note" }, "Not unanimous: the dissent is below, as filed.")
      : null,
    el(
      h,
      "ol",
      { class: "readings" },
      ...r.readings.map((x) => {
        const f = d!.findings.find((g) => g.id === x.findingId);
        return el(
          h,
          "li",
          { class: ["reading", x.verdict ?? "missing"] },
          el(h, "span", { class: "slot" }, String(x.slot)),
          el(h, "b", {}, x.verdict ? VERDICT[x.verdict] ?? "" : "No filing"),
          el(h, "span", {}, f?.body?.cause ?? x.reason ?? ""),
        );
      }),
    ),
    r.challenge != null &&
      el(
        h,
        "div",
        { class: "challenge" },
        el(h, "b", {}, `Challenger: ${r.challenge.outcome ?? "did not file"}`),
        el(h, "p", {}, r.challenge.reason ?? ""),
        ...Pieces(h, r.challenge.pieces ?? []),
      ),
  );
};

/** A diff, its additions and removals marked. */
const Diff = (h: H, text: string) =>
  el(
    h,
    "pre",
    { class: "diff" },
    ...text.split("\n").slice(0, 60).flatMap((l, n) => [
      n > 0 ? "\n" : null,
      l.startsWith("+") && !l.startsWith("+++") ? el(h, "ins", {}, l) : l.startsWith("-") && !l.startsWith("---") ? el(h, "del", {}, l) : l,
    ]),
  );

/** A fix attempt: its state, the one rule that stopped it or why it is eligible, the change, its verification, the draft. */
const FixPanel = (h: H, d: ItemDetail | null, wallNow: number) => {
  const list: ReadonlyArray<Fix> = [...(d?.fixes ?? [])].reverse();
  if (!list.length) {
    return d?.fixable && d.investigations.some((x) => x.result?.verdict === "real")
      ? el(
        h,
        "section",
        { class: ["panel", "fixes"] },
        el(h, "h3", {}, "Fix"),
        el(h, "p", { class: "note" }, "No proposal yet. ", Kbd(h, "f"), " asks for one: it is made only when every rule holds."),
      )
      : null;
  }
  return el(
    h,
    "section",
    { class: ["panel", "fixes"] },
    el(h, "h3", {}, "Fix proposal"),
    ...list.map((f, n) =>
      el(
        h,
        "article",
        { class: ["fix", m.fixTone(f.state)], attrs: { "data-fix": f.id }, on: [h.Key(f.id)] },
        el(
          h,
          "header",
          {},
          el(h, "b", {}, m.FIX_LABEL[f.state] ?? f.state),
          ...(f.pr
            ? [
              el(h, "a", { attrs: { href: f.pr.url, target: "_blank", rel: "noopener" } }, `Draft #${f.pr.number}`),
              f.publishedMs ? el(h, "span", {}, `opened ${m.ago(f.publishedMs, wallNow)}`) : null,
            ]
            : []),
        ),
        f.reason ? el(h, "p", { class: ["note", f.state === "verified" && "warn"] }, f.reason) : null,
        f.action
          ? el(
            h,
            "div",
            { class: "publish" },
            el(h, "button", { attrs: { type: "button", "data-publish": f.id }, on: [h.OnClick(Message.ClickedPublish({ fixId: f.id }))] }, `${f.action.label} `, Kbd(h, "⇧P")),
            el(h, "p", { class: "note" }, `Pressing it ${f.action.effect}. Never merged, never forced.`),
          )
          : el(h, "p", { class: ["note", "next"] }, m.FIX_NEXT[f.state] ?? ""),
        f.host && f.state !== "published" ? el(h, "p", { class: ["note", "warn"] }, `On the host: ${f.host}`) : null,
        ...(n === 0 && f.diff
          ? [
            el(
              h,
              "p",
              { class: "eligible" },
              "Eligible: three of three readings said real, the challenger upheld it, it was observed in telemetry, and it began strictly after the rollout of ",
              el(h, "code", {}, String(f.deployed).slice(0, 12)),
              " (previously ",
              el(h, "code", {}, String(f.previous).slice(0, 12)),
              "). A model selected this change; Overwatch derived it from Git and checked it.",
            ),
            Diff(h, f.diff),
          ]
          : []),
        f.verification.length > 0 &&
          el(
            h,
            "ul",
            { class: "verification" },
            ...f.verification.map((v) =>
              el(
                h,
                "li",
                { class: v.exitCode === 0 ? "ok" : "failed" },
                el(h, "code", {}, v.argv.join(" ")),
                el(h, "span", {}, `${v.exitCode === null ? "did not finish" : `exit ${v.exitCode}`} · ${v.elapsedMs} ms`),
              )
            ),
          ),
      )
    ),
  );
};

/** The claims behind the verdict, each with the evidence it cites, readable in place; what was ruled out and not checked. */
const ClaimsPanel = (h: H, d: ItemDetail | null) => {
  const inv = d?.investigations.filter((x) => x.result).at(-1)?.result ?? null;
  // Without an adjudicated investigation, every finding filed on it is shown as filed.
  const ids = inv
    ? new Set(inv.readings.filter((x) => x.verdict === inv.verdict || inv.verdict === "unsure").flatMap((x) => (x.findingId ? [x.findingId] : [])))
    : null;
  const findings = (d?.findings ?? []).filter((f) => (!ids || ids.has(f.id)) && !f.body?.challenge);
  if (!findings.length) return null;
  const list = (title: string, items: ReadonlyArray<string>) =>
    items.length ? el(h, "div", { class: "aside" }, el(h, "h4", {}, title), el(h, "ul", {}, ...items.map((t) => el(h, "li", {}, t)))) : null;
  // Readings that say the same thing are one entry: how many said it, the claims once, each piece of evidence once.
  const groups = new Map<string, Array<Finding>>();
  for (const f of findings) {
    const key = `${f.verdict}|${f.body?.cause ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const seen = new Set<string>();
  const unseen = (pieces: ReadonlyArray<Piece>) => pieces.filter((p) => !seen.has(p.handle) && Boolean(seen.add(p.handle)));
  return el(
    h,
    "section",
    { class: "panel" },
    el(h, "h3", {}, !inv ? "Findings" : inv.verdict === "unsure" ? "What each reading claimed" : "Why"),
    ...[...groups.values()].map((g) => {
      const f = g[0]!;
      const claims = [...new Map(g.flatMap((x) => x.claims ?? []).map((c) => [c.statement, c])).values()];
      return el(
        h,
        "article",
        { class: ["finding", f.verdict] },
        el(h, "header", {}, el(h, "b", {}, VERDICT[f.verdict] ?? f.verdict), el(h, "span", {}, f.body?.cause ?? ""), g.length > 1 && el(h, "em", { class: "said" }, `${g.length} readings said this`)),
        ...claims.flatMap((c) => [el(h, "p", { class: "claim" }, c.statement), ...Pieces(h, unseen(c.pieces ?? []))]),
        el(
          h,
          "div",
          { class: "asides" },
          list("Ruled out", [...new Set(g.flatMap((x) => x.body?.ruled_out ?? []))]),
          list("Not checked", [...new Set(g.flatMap((x) => x.body?.not_checked ?? []))]),
        ),
      );
    }),
  );
};

const IncidentView = (h: H, i: Incident, d: ItemDetail | null, props: Props, snapshot: Snapshot) => {
  const now = snapshot.atMs;
  const off = props.connection === "down";
  const button = (action: ItemAction, label: string, key: string) =>
    el(h, "button", { attrs: { type: "button", "data-action": action }, on: [h.Disabled(off), h.OnClick(Message.ClickedAction({ action }))] }, `${label} `, Kbd(h, key));
  const way = i.way;
  const until = way?.when ? " until it gets worse"
    : way?.untilMs ? ` until ${new Date(way.untilMs).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : way?.kind === "later" ? " until something changes"
    : "";
  const history = (d?.history ?? []).slice(-12).reverse();
  const started = [...snapshot.deploys].reverse().find((x) => x.app === i.app && x.environment === i.environment && x.seq < i.firstSeq);
  const sources = snapshot.sources.filter((x) => x.app === i.app && x.environment === i.environment);
  const done = d?.investigations.filter((x) => x.result).at(-1);
  const left = ahead(snapshot, i, props.serverNow ?? snapshot.atMs).left;
  const fixing = (d?.fixes ?? []).some((f) => ["queued", "proposing", "verifying", "verified", "published"].includes(f.state));
  return el(
    h,
    "article",
    { class: ["incident", `sev-${i.severity}`] },
    el(
      h,
      "header",
      { class: "incident-head" },
      el(h, "span", { class: "sev" }, SeverityGlyph(h, i.severity)),
      el(
        h,
        "div",
        {},
        el(h, "h2", {}, i.title),
        el(
          h,
          "div",
          { class: "meta" },
          el(h, "span", { class: "place" }, `${i.app} / ${i.environment}`),
          el(h, "span", {}, i.severity),
          el(h, "span", { class: ["count", !i.exact && "bound"] }, `${m.countText(i.count, i.exact)}${i.exact ? "" : " (at least)"}`),
          el(h, "span", {}, `last ${m.ago(i.lastMs, now)}`),
          !i.active && el(h, "span", { class: ["pill", "quiet"] }, "quiet"),
        ),
      ),
    ),
    i.returned != null && !way && el(h, "div", { class: "back-note" }, el(h, "b", {}, m.RETURN_LABEL[i.returned.code] ?? "Back"), i.returned.reason),
    way != null &&
      el(
        h,
        "div",
        { class: "way-note" },
        "Put away with ",
        el(h, "b", {}, WAY_LABEL[way.kind] ?? ""),
        `${until}${way.reason ? ` · ${way.reason}` : ""}. `,
        Kbd(h, "u"),
        " puts it back.",
      ),
    el(
      h,
      "div",
      { class: "actions" },
      button("done", "Done", "d"),
      button("later", "Later", "l"),
      button("worse", "Until worse", "w"),
      button("never", "Never", "n"),
      way != null && button("undo", "Put back", "u"),
      el(h, "span", { class: "sep", attrs: { "aria-hidden": "true" } }),
      button("investigate", "Investigate", "i"),
      button("open", "Open in OpenCode", "o"),
      done !== undefined && button("correct", "Was this right?", "y"),
      done !== undefined && d?.fixable === true && !fixing && button("fix", "Propose fix", "f"),
    ),
    d?.comparison != null &&
      el(h, "section", { class: "panel" }, el(h, "h3", {}, "Staging against production"), el(h, "p", { class: ["note", "warn"] }, m.comparisonText(d.comparison) ?? "")),
    VerdictPanel(h, d),
    FixPanel(h, d, props.wallNow),
    ClaimsPanel(h, d),
    d !== null && d.corrections.length > 0 &&
      el(
        h,
        "section",
        { class: "panel" },
        el(h, "h3", {}, `Your corrections (in ${i.app}'s playbook)`),
        el(h, "ul", { class: "corrections" }, ...d.corrections.map((c) => el(h, "li", {}, el(h, "time", {}, c.date), c.text))),
      ),
    d !== null && d.turns.length > 0 &&
      el(
        h,
        "section",
        { class: "panel" },
        el(h, "h3", {}, "Questions"),
        el(
          h,
          "ul",
          { class: "turns" },
          ...d.turns.map((t) =>
            el(
              h,
              "li",
              { class: ["turn", t.state] },
              el(h, "p", { class: "question" }, t.text),
              ...(t.state === "answered"
                ? [el(h, "div", { class: "answer" }, t.answer ?? ""), el(h, "p", { class: ["note", "basis"] }, m.answerBasis(t))]
                : t.state === "failed"
                ? [el(h, "p", { class: ["note", "bound"] }, `No answer: ${t.reason ?? ""}`)]
                : [
                  el(
                    h,
                    "p",
                    { class: "request-state" },
                    el(h, "span", { class: "orbit", attrs: { "aria-hidden": "true" } }),
                    t.state === "running" ? "an agent is answering" : "queued, waiting for an agent",
                  ),
                ]),
            )
          ),
        ),
      ),
    el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "Counts"),
      started !== undefined && el(h, "p", { class: "started" }, "Started after deploy ", el(h, "code", {}, started.revision.slice(0, 12)), ` to ${i.app}/${i.environment}.`),
      left !== null && el(h, "p", { class: ["note", "warn"] }, left.long),
      Spark(h, i.spark, 560, 64),
      el(h, "div", { class: "axis" }, el(h, "span", {}, "24h ago"), el(h, "span", {}, "now")),
      el(
        h,
        "p",
        { class: ["note", !i.exact && "bound"] },
        `${i.exact ? `Exact: ${i.count.toLocaleString("en-US")} occurrences, every reading fully measured while it was active.` : "A lower bound: part of the time was not fully read (a gap, a cap, or lines that rotated away)."} First seen ${m.ago(i.firstMs, now)}.`,
      ),
      SourceList(h, sources, (x) => (x.failure ? causeTitle(x.failure) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, now)}` : "not read yet"), false),
    ),
    el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "History"),
      history.length
        ? el(
          h,
          "ol",
          { class: "history" },
          ...history.map((e) => el(h, "li", { class: ["ev", `ev-${e.kind}`] }, el(h, "span", { class: "ev-kind" }, eventText(e)), el(h, "time", {}, m.ago(e.atMs, now)))),
        )
        : el(h, "p", { class: "note" }, "Loading history…"),
    ),
  );
};

const EnvironmentView = (h: H, subject: string, props: Props, snapshot: Snapshot) => {
  const e = snapshot.environments.find((x) => x.subject === subject);
  if (!e) return el(h, "div", { class: "stage-empty" }, el(h, "b", {}, "Unknown environment"));
  const health = m.cellHealth(e, props.connection, props.serverNow);
  const sources = snapshot.sources.filter((x) => x.app === e.app && x.environment === e.environment);
  const coverage = snapshot.coverage.filter((c) => sources.some((x) => x.id === c.source)).slice(-12).reverse();
  const metrics = snapshot.metrics.filter((x) => sources.some((y) => y.id === x.source));
  return el(
    h,
    "article",
    { class: ["environment", health] },
    el(
      h,
      "header",
      { class: "incident-head" },
      el(h, "span", { class: "glyph" }, HealthGlyph(h, health)),
      el(
        h,
        "div",
        {},
        el(h, "h2", {}, `${e.app} / ${e.environment}`),
        el(h, "div", { class: "meta" }, el(h, "span", {}, m.HEALTH_LABEL[health] ?? ""), e.excluded.length > 0 && el(h, "span", {}, `not measured here: ${e.excluded.join(", ")}`)),
      ),
    ),
    el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "Sources"),
      SourceList(
        h,
        sources,
        (x) => x.failure ? `${causeTitle(x.failure)}${x.suspended ? " · suspended, probing every five minutes" : ""}` : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, snapshot.atMs)}` : "not read yet",
        true,
      ),
    ),
    ...OutlookPanels(h, snapshot, e, props.serverNow ?? snapshot.atMs),
    metrics.length > 0 &&
      el(
        h,
        "section",
        { class: "panel" },
        el(h, "h3", {}, "Gauges"),
        el(h, "ul", { class: "gauges" }, ...metrics.map((x) => el(h, "li", { class: x.breach ? "breach" : "" }, el(h, "span", {}, x.name), el(h, "b", {}, String(x.value)), x.breach && el(h, "em", {}, "over its limit")))),
      ),
    Coverage(h, snapshot, coverage),
  );
};

const SourceView = (h: H, subject: string, props: Props, snapshot: Snapshot) => {
  const x = snapshot.sources.find((y) => y.subject === subject);
  if (!x) return el(h, "div", { class: "stage-empty" }, el(h, "b", {}, "Unknown source"));
  const e = snapshot.environments.find((y) => y.app === x.app && y.environment === x.environment);
  const coverage = snapshot.coverage.filter((c) => c.source === x.id).slice(-12).reverse();
  const readings = (e?.readings ?? []).filter((r) => r.source === x.id);
  return el(
    h,
    "article",
    { class: ["environment", "source"] },
    el(
      h,
      "header",
      { class: "incident-head" },
      el(h, "span", { class: "glyph" }, HealthGlyph(h, x.failure ? "signed_out" : "quiet")),
      el(
        h,
        "div",
        {},
        el(h, "h2", {}, x.id),
        el(
          h,
          "div",
          { class: "meta" },
          el(h, "span", {}, x.kind),
          el(h, "span", {}, x.failure ? causeTitle(x.failure) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, snapshot.atMs)}` : "not read yet"),
          x.suspended && el(h, "span", {}, "suspended, probing every five minutes"),
        ),
      ),
    ),
    x.fix ? el(h, "div", { class: "back-note" }, el(h, "b", {}, "Repair"), el(h, "code", {}, x.fix)) : null,
    el(
      h,
      "section",
      { class: "panel" },
      el(h, "h3", {}, "Readings"),
      el(
        h,
        "ul",
        { class: "gauges" },
        ...readings.map((r) =>
          el(
            h,
            "li",
            { class: r.state === "ok" ? "" : "breach" },
            el(h, "span", {}, r.reading),
            el(h, "b", {}, r.state ?? "never read"),
            el(h, "em", {}, r.okMs === null ? "never measured" : `measured ${m.ago(r.okMs, props.serverNow ?? snapshot.atMs)}`),
          )
        ),
      ),
    ),
    Coverage(h, snapshot, coverage),
  );
};

const Overview = (h: H, snapshot: Snapshot) => {
  const g = snapshot.inbox.groups;
  const n = g.needsYou.length;
  const key = (keys: ReadonlyArray<string>, text: string) => el(h, "div", {}, el(h, "dt", {}, ...keys.map((k) => Kbd(h, k))), el(h, "dd", {}, text));
  return el(
    h,
    "div",
    { class: "overview" },
    el(h, "img", { attrs: { src: "logo.svg", alt: "", width: "56", height: "56" } }),
    el(h, "h2", {}, n ? `${n} ${n === 1 ? "problem needs" : "problems need"} you` : "Nothing needs you"),
    el(h, "p", {}, `${g.new.length} new · ${g.working.length} with an agent · ${g.quiet.length} quiet. Put anything in focus with `, Kbd(h, "j"), " or a click, then ask about it below."),
    el(
      h,
      "dl",
      { class: "keys" },
      key(["j", "k"], "Move through the inbox"),
      key(["d"], "Done: back if it happens again"),
      key(["l"], "Later: until something changes"),
      key(["n"], "Never: only if it gets much worse"),
      key(["/"], "Find anything, even put away"),
      key(["p"], "Ask about what is in focus"),
    ),
  );
};

export const view = defineView<Model, Message, Props>((_model, props, h) => {
  const { snapshot, focus } = props;
  const stage = { class: "stage", attrs: { "data-stage": "", "aria-live": "polite", "data-focus-id": focus ?? undefined } };
  if (focus === null) return el(h, "section", stage, snapshot === null ? null : Overview(h, snapshot));
  const back = el(h, "button", { class: "stage-back", attrs: { type: "button", "data-back": "" }, on: [h.OnClick(Message.ClickedBack())] }, "← Inbox");
  if (snapshot !== null && focus.startsWith("env:")) return el(h, "section", stage, back, EnvironmentView(h, focus, props, snapshot));
  if (snapshot !== null && focus.startsWith("src:")) return el(h, "section", stage, back, SourceView(h, focus, props, snapshot));
  const d = props.detail?.incident.id === focus ? props.detail : null;
  const i = snapshot?.incidents.find((x) => x.id === focus) ?? d?.incident;
  if (snapshot === null || i === undefined) return el(h, "section", stage, el(h, "div", { class: "stage-empty" }, el(h, "b", {}, "Loading…")));
  return el(h, "section", stage, back, IncidentView(h, i, d, props, snapshot));
});
