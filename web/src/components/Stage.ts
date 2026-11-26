/**
 * The stage: what is in focus, in full. A problem with its verdict, fix, claims, questions, counts and history; an
 * environment or a source with its readings and coverage; or, with nothing in focus, the overview and its keys.
 */
import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Clipboard } from "@effect/platform-browser";
import { Effect, Layer, Predicate, Schema } from "effect";
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
import { causeTitle } from "./Banners.ts";
import { HealthGlyph, SeverityGlyph, Spark } from "./Glyphs.ts";
import { ahead, OutlookPanels } from "./Outlook.ts";

type H = Html.H<StageMessage>;

export const StageProps = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  focus: Schema.NullOr(Schema.String),
  /** The focused item in full, when it has been read. */
  detail: Schema.NullOr(ItemDetail),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  serverNow: Schema.NullOr(Schema.Number),
  wallNow: Schema.Number,
});
export type StageProps = typeof StageProps.Type;

/** What the item's buttons ask for; the page decides what each means. */
export const ItemAction = Schema.Literals(["done", "later", "worse", "never", "undo", "investigate", "open", "correct", "fix"]);
export type ItemAction = typeof ItemAction.Type;

const StageMessage = UiSchema.TaggedEnum({
  ClickedBack: {},
  ClickedSubject: { subject: Schema.String },
  ClickedAction: { action: ItemAction },
  ClickedPublish: { fixId: Schema.String },
  ClickedHandle: { handle: Schema.String },
  SucceededCopyHandle: { handle: Schema.String },
  FailedCopyHandle: { reason: Schema.String },
});
type StageMessage = typeof StageMessage.Type;

export const StageEvents = UiSchema.TaggedEnum({
  RequestedInbox: {},
  Picked: { subject: Schema.String },
  RequestedAction: { action: ItemAction },
  RequestedPublish: { fixId: Schema.String },
  Copied: { text: Schema.String },
  FailedCopy: { reason: Schema.String },
});

/** Copies an evidence handle; nothing is sent anywhere. */
class CopyHandle extends Command.Service<CopyHandle>()("stage/CopyHandle", {
  args: { handle: Schema.String },
  success: StageMessage,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const clipboard = yield* Clipboard.Clipboard;
      return ({ handle }) =>
        clipboard.writeString(handle).pipe(
          Effect.match({
            onSuccess: () => StageMessage.SucceededCopyHandle({ handle }),
            onFailure: (error) => StageMessage.FailedCopyHandle({ reason: Predicate.isError(error.cause) ? error.cause.message : error.message }),
          }),
        );
    }),
  );
}

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

const StageDef = Html.component({
  name: "Stage",
  props: StageProps,
  model: Schema.Struct({}),
  message: StageMessage,
  events: StageEvents,
});

const Kbd = (h: H, key: string) => h.kbd(key);

const Pieces = (h: H, pieces: ReadonlyArray<Piece>) =>
  pieces.map((p) =>
    h.figure.class("evidence").children(
      h.figcaption(
        h.button.class("handle").attrs({ type: "button", "data-handle": p.handle, title: `${p.handle} · click to copy` })
          .on("click", StageMessage.ClickedHandle({ handle: p.handle }))
          .children(m.shortHandle(p.handle)),
        h.span(p.source),
      ),
      h.pre(p.text),
    )
  );

const SourceList = (h: H, snapshot: Snapshot, sources: Snapshot["sources"], state: (x: Snapshot["sources"][number]) => string, withFix: boolean) =>
  h.ul.class("sources").children(
    ...sources.map((x) =>
      h.li.key(x.subject).class(x.failure ? "failing" : "").attr("data-subject", x.subject)
        .on("click", StageMessage.ClickedSubject({ subject: x.subject }))
        .children(h.b.class("subject-link").children(x.id), h.span(state(x)), withFix && x.fix ? h.code(x.fix) : null)
    ),
  );

const Coverage = (h: H, snapshot: Snapshot, coverage: Snapshot["coverage"]) =>
  h.section.class("panel").children(
    h.h3("Coverage"),
    h.ol.class("history").children(
      ...(coverage.length
        ? coverage.map((c) =>
          h.li.class("cov", `cov-${c.state}`).children(
            h.span.class("ev-kind").children(`${c.reading}: ${c.state}${c.missed ? ` (${c.missed} missed)` : ""}`),
            h.time(m.ago(c.toMs, snapshot.atMs)),
          )
        )
        : [h.li("Nothing read yet")]),
    ),
  );

/** The latest investigation: the verdict, how the readings voted, what the challenger did; disagreement shows. */
const VerdictPanel = (h: H, d: ItemDetail | null) => {
  const inv = d?.investigations.at(-1);
  if (!inv || (!inv.result && inv.state !== "queued" && inv.state !== "running")) return null;
  if (!inv.result) {
    return h.section.class("verdict", "working").children(
      h.span.class("orbit").attr("aria-hidden", "true"),
      h.div(h.b("Investigating"), h.span(inv.state === "queued" ? "queued for the next free agent" : "independent readings under way")),
    );
  }
  const r = inv.result, v = m.verdictView(r);
  return h.section.class("verdict", v.tone).attrs({ "data-verdict": r.verdict, "data-tone": v.tone }).children(
    h.header(
      h.span.class("verdict-label").children(v.label),
      h.span.class("verdict-label", "votes").children(v.votes),
      v.challenge !== null && h.span.class("challenge-word").children(v.challenge),
      v.evidence !== null && h.span.class("pill", v.observed ? "observed" : "unobserved").children(v.evidence),
    ),
    v.tone === "undecided" ? h.p.class("note").children("The readings could not settle it. It stays with you; look at what each one saw.")
      : v.tone === "disagreed" ? h.p.class("note").children("Not unanimous: the dissent is below, as filed.")
      : null,
    h.ol.class("readings").children(
      ...r.readings.map((x) => {
        const f = d!.findings.find((g) => g.id === x.findingId);
        return h.li.class("reading", x.verdict ?? "missing").children(
          h.span.class("slot").children(String(x.slot)),
          h.b(x.verdict ? VERDICT[x.verdict] ?? "" : "No filing"),
          h.span(f?.body?.cause ?? x.reason ?? ""),
        );
      }),
    ),
    r.challenge != null &&
      h.div.class("challenge").children(h.b(`Challenger: ${r.challenge.outcome ?? "did not file"}`), h.p(r.challenge.reason ?? ""), ...Pieces(h, r.challenge.pieces ?? [])),
  );
};

/** A diff, its additions and removals marked. */
const Diff = (h: H, text: string) =>
  h.pre.class("diff").children(
    ...text.split("\n").slice(0, 60).flatMap((l, n) => [
      n > 0 ? "\n" : null,
      l.startsWith("+") && !l.startsWith("+++") ? h.ins(l) : l.startsWith("-") && !l.startsWith("---") ? h.del(l) : l,
    ]),
  );

/** A fix attempt: its state, the one rule that stopped it or why it is eligible, the change, its verification, the draft. */
const FixPanel = (h: H, d: ItemDetail | null, wallNow: number) => {
  const list: ReadonlyArray<Fix> = [...(d?.fixes ?? [])].reverse();
  if (!list.length) {
    return d?.fixable && d.investigations.some((x) => x.result?.verdict === "real")
      ? h.section.class("panel", "fixes").children(h.h3("Fix"), h.p.class("note").children("No proposal yet. ", Kbd(h, "f"), " asks for one: it is made only when every rule holds."))
      : null;
  }
  return h.section.class("panel", "fixes").children(
    h.h3("Fix proposal"),
    ...list.map((f, n) =>
      h.article.key(f.id).class("fix", m.fixTone(f.state)).attr("data-fix", f.id).children(
        h.header(
          h.b(m.FIX_LABEL[f.state] ?? f.state),
          ...(f.pr
            ? [
              h.a.attrs({ href: f.pr.url, target: "_blank", rel: "noopener" }).children(`Draft #${f.pr.number}`),
              f.publishedMs ? h.span(`opened ${m.ago(f.publishedMs, wallNow)}`) : null,
            ]
            : []),
        ),
        f.reason ? h.p.class("note", f.state === "verified" && "warn").children(f.reason) : null,
        f.action
          ? h.div.class("publish").children(
            h.button.attrs({ type: "button", "data-publish": f.id }).on("click", StageMessage.ClickedPublish({ fixId: f.id })).children(`${f.action.label} `, Kbd(h, "⇧P")),
            h.p.class("note").children(`Pressing it ${f.action.effect}. Never merged, never forced.`),
          )
          : h.p.class("note", "next").children(m.FIX_NEXT[f.state] ?? ""),
        f.host && f.state !== "published" ? h.p.class("note", "warn").children(`On the host: ${f.host}`) : null,
        ...(n === 0 && f.diff
          ? [
            h.p.class("eligible").children(
              "Eligible: three of three readings said real, the challenger upheld it, it was observed in telemetry, and it began strictly after the rollout of ",
              h.code(String(f.deployed).slice(0, 12)),
              " (previously ",
              h.code(String(f.previous).slice(0, 12)),
              "). A model selected this change; Overwatch derived it from Git and checked it.",
            ),
            Diff(h, f.diff),
          ]
          : []),
        f.verification.length > 0 &&
          h.ul.class("verification").children(
            ...f.verification.map((v) =>
              h.li.class(v.exitCode === 0 ? "ok" : "failed").children(
                h.code(v.argv.join(" ")),
                h.span(`${v.exitCode === null ? "did not finish" : `exit ${v.exitCode}`} · ${v.elapsedMs} ms`),
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
    items.length ? h.div.class("aside").children(h.h4(title), h.ul.children(...items.map((t) => h.li(t)))) : null;
  // Readings that say the same thing are one entry: how many said it, the claims once, each piece of evidence once.
  const groups = new Map<string, Array<Finding>>();
  for (const f of findings) {
    const key = `${f.verdict}|${f.body?.cause ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const seen = new Set<string>();
  const unseen = (pieces: ReadonlyArray<Piece>) => pieces.filter((p) => !seen.has(p.handle) && Boolean(seen.add(p.handle)));
  return h.section.class("panel").children(
    h.h3(!inv ? "Findings" : inv.verdict === "unsure" ? "What each reading claimed" : "Why"),
    ...[...groups.values()].map((g) => {
      const f = g[0]!;
      const claims = [...new Map(g.flatMap((x) => x.claims ?? []).map((c) => [c.statement, c])).values()];
      return h.article.class("finding", f.verdict).children(
        h.header(h.b(VERDICT[f.verdict] ?? f.verdict), h.span(f.body?.cause ?? ""), g.length > 1 && h.em.class("said").children(`${g.length} readings said this`)),
        ...claims.flatMap((c) => [h.p.class("claim").children(c.statement), ...Pieces(h, unseen(c.pieces ?? []))]),
        h.div.class("asides").children(
          list("Ruled out", [...new Set(g.flatMap((x) => x.body?.ruled_out ?? []))]),
          list("Not checked", [...new Set(g.flatMap((x) => x.body?.not_checked ?? []))]),
        ),
      );
    }),
  );
};

const IncidentView = (h: H, i: Incident, d: ItemDetail | null, props: StageProps, snapshot: Snapshot) => {
  const now = snapshot.atMs;
  const off = props.connection === "down";
  const button = (action: ItemAction, label: string, key: string) =>
    h.button.attrs({ type: "button", "data-action": action }).disabled(off).on("click", StageMessage.ClickedAction({ action })).children(`${label} `, Kbd(h, key));
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
  return h.article.class("incident", `sev-${i.severity}`).children(
    h.header.class("incident-head").children(
      h.span.class("sev").children(SeverityGlyph(h, i.severity)),
      h.div(
        h.h2(i.title),
        h.div.class("meta").children(
          h.span.class("place").children(`${i.app} / ${i.environment}`),
          h.span(i.severity),
          h.span.class("count", !i.exact && "bound").children(`${m.countText(i.count, i.exact)}${i.exact ? "" : " (at least)"}`),
          h.span(`last ${m.ago(i.lastMs, now)}`),
          !i.active && h.span.class("pill", "quiet").children("quiet"),
        ),
      ),
    ),
    i.returned != null && !way && h.div.class("back-note").children(h.b(m.RETURN_LABEL[i.returned.code] ?? "Back"), i.returned.reason),
    way != null &&
      h.div.class("way-note").children(
        "Put away with ",
        h.b(WAY_LABEL[way.kind] ?? ""),
        `${until}${way.reason ? ` · ${way.reason}` : ""}. `,
        Kbd(h, "u"),
        " puts it back.",
      ),
    h.div.class("actions").children(
      button("done", "Done", "d"),
      button("later", "Later", "l"),
      button("worse", "Until worse", "w"),
      button("never", "Never", "n"),
      way != null && button("undo", "Put back", "u"),
      h.span.class("sep").attr("aria-hidden", "true"),
      button("investigate", "Investigate", "i"),
      button("open", "Open in OpenCode", "o"),
      done !== undefined && button("correct", "Was this right?", "y"),
      done !== undefined && d?.fixable === true && !fixing && button("fix", "Propose fix", "f"),
    ),
    d?.comparison != null &&
      h.section.class("panel").children(h.h3("Staging against production"), h.p.class("note", "warn").children(m.comparisonText(d.comparison) ?? "")),
    VerdictPanel(h, d),
    FixPanel(h, d, props.wallNow),
    ClaimsPanel(h, d),
    d !== null && d.corrections.length > 0 &&
      h.section.class("panel").children(
        h.h3(`Your corrections (in ${i.app}'s playbook)`),
        h.ul.class("corrections").children(...d.corrections.map((c) => h.li(h.time(c.date), c.text))),
      ),
    d !== null && d.turns.length > 0 &&
      h.section.class("panel").children(
        h.h3("Questions"),
        h.ul.class("turns").children(
          ...d.turns.map((t) =>
            h.li.class("turn", t.state).children(
              h.p.class("question").children(t.text),
              ...(t.state === "answered"
                ? [h.div.class("answer").children(t.answer ?? ""), h.p.class("note", "basis").children(m.answerBasis(t))]
                : t.state === "failed"
                ? [h.p.class("note", "bound").children(`No answer: ${t.reason ?? ""}`)]
                : [h.p.class("request-state").children(h.span.class("orbit").attr("aria-hidden", "true"), t.state === "running" ? "an agent is answering" : "queued, waiting for an agent")]),
            )
          ),
        ),
      ),
    h.section.class("panel").children(
      h.h3("Counts"),
      started !== undefined && h.p.class("started").children("Started after deploy ", h.code(started.revision.slice(0, 12)), ` to ${i.app}/${i.environment}.`),
      left !== null && h.p.class("note", "warn").children(left.long),
      Spark(h, i.spark, 560, 64),
      h.div.class("axis").children(h.span("24h ago"), h.span("now")),
      h.p.class("note", !i.exact && "bound").children(
        `${i.exact ? `Exact: ${i.count.toLocaleString("en-US")} occurrences, every reading fully measured while it was active.` : "A lower bound: part of the time was not fully read (a gap, a cap, or lines that rotated away)."} First seen ${m.ago(i.firstMs, now)}.`,
      ),
      SourceList(h, snapshot, sources, (x) => (x.failure ? causeTitle(x.failure) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, now)}` : "not read yet"), false),
    ),
    h.section.class("panel").children(
      h.h3("History"),
      history.length
        ? h.ol.class("history").children(
          ...history.map((e) => h.li.class("ev", `ev-${e.kind}`).children(h.span.class("ev-kind").children(eventText(e)), h.time(m.ago(e.atMs, now)))),
        )
        : h.p.class("note").children("Loading history…"),
    ),
  );
};

const EnvironmentView = (h: H, subject: string, props: StageProps, snapshot: Snapshot) => {
  const e = snapshot.environments.find((x) => x.subject === subject);
  if (!e) return h.div.class("stage-empty").children(h.b("Unknown environment"));
  const health = m.cellHealth(e, props.connection, props.serverNow);
  const sources = snapshot.sources.filter((x) => x.app === e.app && x.environment === e.environment);
  const coverage = snapshot.coverage.filter((c) => sources.some((x) => x.id === c.source)).slice(-12).reverse();
  const metrics = snapshot.metrics.filter((x) => sources.some((y) => y.id === x.source));
  return h.article.class("environment", health).children(
    h.header.class("incident-head").children(
      h.span.class("glyph").children(HealthGlyph(h, health)),
      h.div(
        h.h2(`${e.app} / ${e.environment}`),
        h.div.class("meta").children(h.span(m.HEALTH_LABEL[health] ?? ""), e.excluded.length > 0 && h.span(`not measured here: ${e.excluded.join(", ")}`)),
      ),
    ),
    h.section.class("panel").children(
      h.h3("Sources"),
      SourceList(
        h,
        snapshot,
        sources,
        (x) => x.failure ? `${causeTitle(x.failure)}${x.suspended ? " · suspended, probing every five minutes" : ""}` : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, snapshot.atMs)}` : "not read yet",
        true,
      ),
    ),
    ...OutlookPanels(h, snapshot, e, props.serverNow ?? snapshot.atMs),
    metrics.length > 0 &&
      h.section.class("panel").children(
        h.h3("Gauges"),
        h.ul.class("gauges").children(...metrics.map((x) => h.li.class(x.breach ? "breach" : "").children(h.span(x.name), h.b(String(x.value)), x.breach && h.em("over its limit")))),
      ),
    Coverage(h, snapshot, coverage),
  );
};

const SourceView = (h: H, subject: string, props: StageProps, snapshot: Snapshot) => {
  const x = snapshot.sources.find((y) => y.subject === subject);
  if (!x) return h.div.class("stage-empty").children(h.b("Unknown source"));
  const e = snapshot.environments.find((y) => y.app === x.app && y.environment === x.environment);
  const coverage = snapshot.coverage.filter((c) => c.source === x.id).slice(-12).reverse();
  const readings = (e?.readings ?? []).filter((r) => r.source === x.id);
  return h.article.class("environment", "source").children(
    h.header.class("incident-head").children(
      h.span.class("glyph").children(HealthGlyph(h, x.failure ? "signed_out" : "quiet")),
      h.div(
        h.h2(x.id),
        h.div.class("meta").children(
          h.span(x.kind),
          h.span(x.failure ? causeTitle(x.failure) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, snapshot.atMs)}` : "not read yet"),
          x.suspended && h.span("suspended, probing every five minutes"),
        ),
      ),
    ),
    x.fix ? h.div.class("back-note").children(h.b("Repair"), h.code(x.fix)) : null,
    h.section.class("panel").children(
      h.h3("Readings"),
      h.ul.class("gauges").children(
        ...readings.map((r) =>
          h.li.class(r.state === "ok" ? "" : "breach").children(
            h.span(r.reading),
            h.b(r.state ?? "never read"),
            h.em(r.okMs === null ? "never measured" : `measured ${m.ago(r.okMs, props.serverNow ?? snapshot.atMs)}`),
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
  const key = (keys: ReadonlyArray<string>, text: string) => h.div(h.dt(...keys.map((k) => Kbd(h, k))), h.dd(text));
  return h.div.class("overview").children(
    h.img.attrs({ src: "logo.svg", alt: "", width: "56", height: "56" }),
    h.h2(n ? `${n} ${n === 1 ? "problem needs" : "problems need"} you` : "Nothing needs you"),
    h.p(`${g.new.length} new · ${g.working.length} with an agent · ${g.quiet.length} quiet. Put anything in focus with `, Kbd(h, "j"), " or a click, then ask about it below."),
    h.dl.class("keys").children(
      key(["j", "k"], "Move through the inbox"),
      key(["d"], "Done: back if it happens again"),
      key(["l"], "Later: until something changes"),
      key(["n"], "Never: only if it gets much worse"),
      key(["/"], "Find anything, even put away"),
      key(["p"], "Ask about what is in focus"),
    ),
  );
};

export const Stage = StageDef.make({
  init: () => ({}),
  update: {
    ClickedBack: ($) => $.emit(StageEvents.RequestedInbox()),
    ClickedSubject: ($, { subject }) => $.emit(StageEvents.Picked({ subject })),
    ClickedAction: ($, { action }) => $.emit(StageEvents.RequestedAction({ action })),
    ClickedPublish: ($, { fixId }) => $.emit(StageEvents.RequestedPublish({ fixId })),
    ClickedHandle: ($, { handle }) => $.run(CopyHandle.make({ handle })),
    SucceededCopyHandle: ($, { handle }) => $.emit(StageEvents.Copied({ text: handle })),
    FailedCopyHandle: ($, { reason }) => $.emit(StageEvents.FailedCopy({ reason })),
  },
  view: (h) => {
    const props = h.props;
    const { snapshot, focus } = props;
    const stage = h.section.class("stage").attrs({ "data-stage": "", "aria-live": "polite", "data-focus-id": focus ?? undefined });
    if (focus === null) return stage.children(snapshot === null ? null : Overview(h, snapshot));
    const back = h.button.class("stage-back").attrs({ type: "button", "data-back": "" }).on("click", StageMessage.ClickedBack()).children("← Inbox");
    if (snapshot !== null && focus.startsWith("env:")) return stage.children(back, EnvironmentView(h, focus, props, snapshot));
    if (snapshot !== null && focus.startsWith("src:")) return stage.children(back, SourceView(h, focus, props, snapshot));
    const d = props.detail?.incident.id === focus ? props.detail : null;
    const i = snapshot?.incidents.find((x) => x.id === focus) ?? d?.incident;
    if (snapshot === null || i === undefined) return stage.children(h.div.class("stage-empty").children(h.b("Loading…")));
    return stage.children(back, IncidentView(h, i, d, props, snapshot));
  },
}).pipe(Component.provide(CopyHandle.layer.pipe(Layer.provide(Clipboard.layer))));
