/**
 * The stage: what is in focus, in full. A problem with its single-row triage bar, verdict vote meter, declarative
 * GenUI Visual Lens, verified fix diff, progressive-disclosure claims, questions, annotated deploy-onset counts and
 * history; an environment or source with readings, capacity bars and coverage; or the calm Situation Board overview.
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
  LensSpec,
  type Piece,
  Snapshot,
} from "../domain/Overwatch.ts";
import { knownHandles, type LensMode, selectActiveLens, synthesizeEnvLens, synthesizeIncidentLens, validateLensHandles } from "../lens.ts";
import * as m from "../model.ts";
import { Command, defineView, el, emit, type H as Builder, run, type Step, TaggedEnum } from "../ui.ts";
import { causeTitle } from "./Banners.ts";
import { AnnotatedSpark, CopyIcon, HealthGlyph, SeverityGlyph } from "./Glyphs.ts";
import { ahead, OutlookPanels } from "./Outlook.ts";
import { Overview } from "./Overview.ts";
import { VisualLens } from "./VisualLens.ts";

const LensModeSchema = Schema.Literals(["auto", "ai", "derived"]);
const CaughtUpSchema = Schema.Struct({ seq: Schema.Number, atMs: Schema.Number });
const WhatsNewWindowSchema = Schema.Literals(["since", "24h"]);

export const Props = Schema.Struct({
  snapshot: Schema.NullOr(Snapshot),
  focus: Schema.NullOr(Schema.String),
  /** The focused item in full, when it has been read. */
  detail: Schema.NullOr(ItemDetail),
  connection: Schema.Literals(["unknown", "live", "stale", "down"]),
  serverNow: Schema.NullOr(Schema.Number),
  wallNow: Schema.Number,
  lensMode: LensModeSchema,
  lensLoading: Schema.Boolean,
  cachedAiLens: Schema.NullOr(LensSpec),
  caughtUp: Schema.NullOr(CaughtUpSchema),
  whatsNewWindow: WhatsNewWindowSchema,
});
export type Props = typeof Props.Type;

/** What the item's buttons ask for; the page decides what each means. */
export const ItemAction = Schema.Literals(["done", "later", "worse", "never", "undo", "investigate", "open", "copyHandoff", "handoffSheet", "correct", "fix"]);
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
  ClickedLensMode: { mode: LensModeSchema },
  ClickedGenerateLens: {},
  ClickedMarkCaughtUp: {},
  ClickedToggleWhatsNewWindow: {},
  SucceededCopyHandle: { handle: Schema.String },
  FailedCopyHandle: { reason: Schema.String },
});
export type Message = typeof Message.Type;

export const Events = TaggedEnum({
  RequestedInbox: {},
  Picked: { subject: Schema.String },
  RequestedAction: { action: ItemAction },
  RequestedPublish: { fixId: Schema.String },
  ChangedLensMode: { mode: LensModeSchema },
  RequestedGenerateLens: {},
  RequestedMarkCaughtUp: {},
  RequestedToggleWhatsNewWindow: {},
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
    ClickedLensMode: ({ mode }) => emit(model, Events.ChangedLensMode({ mode })),
    ClickedGenerateLens: () => emit(model, Events.RequestedGenerateLens()),
    ClickedMarkCaughtUp: () => emit(model, Events.RequestedMarkCaughtUp()),
    ClickedToggleWhatsNewWindow: () => emit(model, Events.RequestedToggleWhatsNewWindow()),
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

const DB_TABLE_MAX_ROWS = 8;

const DbTableView = (h: H, columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
  el(
    h,
    "div",
    { class: "db-table-wrap" },
    el(
      h,
      "table",
      { class: "db-table" },
      el(h, "thead", {}, el(h, "tr", {}, ...columns.map((col) => el(h, "th", { attrs: { scope: "col" } }, col)))),
      el(
        h,
        "tbody",
        {},
        ...rows.map((row) => el(h, "tr", {}, ...columns.map((_, idx) => el(h, "td", {}, row[idx] ?? "")))),
      ),
    ),
  );

const PolicyPills = (h: H, tags: ReadonlyArray<m.PolicyTag>) =>
  tags.map((t) => el(h, "span", { class: ["pill", "policy-pill", `policy-${t.tone}`], attrs: { title: t.title } }, t.label));

const Pieces = (h: H, pieces: ReadonlyArray<Piece>) =>
  pieces.map((p) => {
    const isDb = m.isDbPiece(p);
    const table = isDb ? m.parseDbEvidence(p.text) : null;
    const caption = el(
      h,
      "figcaption",
      {},
      el(
        h,
        "button",
        { class: "handle", attrs: { type: "button", "data-handle": p.handle, title: `${p.handle} · click to copy` }, on: [h.OnClick(Message.ClickedHandle({ handle: p.handle }))] },
        m.shortHandle(p.handle),
      ),
      isDb && el(h, "span", { class: ["pill", "policy-pill", "policy-cyan", "db-badge"], attrs: { title: "Read-only SQL query output" } }, "DB ro"),
      el(h, "span", {}, p.source),
    );
    if (isDb && table !== null) {
      const shown = table.rows.slice(0, DB_TABLE_MAX_ROWS);
      const hidden = table.rows.slice(DB_TABLE_MAX_ROWS);
      return el(
        h,
        "figure",
        { class: ["evidence", "evidence-db"] },
        caption,
        table.query ? el(h, "code", { class: "db-query", attrs: { title: table.query } }, table.query) : null,
        DbTableView(h, table.columns, shown),
        hidden.length > 0 &&
          el(
            h,
            "details",
            { class: ["disclosure", "db-overflow"] },
            el(h, "summary", {}, `Show ${hidden.length} more row${hidden.length === 1 ? "" : "s"} (${table.rows.length} total)`),
            DbTableView(h, table.columns, hidden),
          ),
      );
    }
    return el(
      h,
      "figure",
      { class: ["evidence", isDb && "evidence-db"] },
      caption,
      el(h, "pre", {}, p.text),
    );
  });

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

const Coverage = (h: H, snapshot: Snapshot, coverage: Snapshot["coverage"]) => {
  const recent = coverage.slice(0, 4);
  const older = coverage.slice(4);
  const item = (c: Snapshot["coverage"][number]) =>
    el(
      h,
      "li",
      { class: ["cov", `cov-${c.state}`] },
      el(h, "span", { class: "ev-kind" }, `${c.reading}: ${c.state}${c.missed ? ` (${c.missed} missed)` : ""}`),
      el(h, "time", {}, m.ago(c.toMs, snapshot.atMs)),
    );
  return el(
    h,
    "section",
    { class: "panel" },
    el(h, "h3", {}, "Coverage"),
    el(h, "ol", { class: "history" }, ...(recent.length ? recent.map(item) : [el(h, "li", {}, "Nothing read yet")])),
    older.length > 0 &&
      el(
        h,
        "details",
        { class: "disclosure" },
        el(h, "summary", {}, `Show ${older.length} earlier coverage reading${older.length === 1 ? "" : "s"}`),
        el(h, "ol", { class: "history" }, ...older.map(item)),
      ),
  );
};

/** The latest investigation: verdict header, visual vote-pip meter, individual readings and challenger. */
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
    // Tactile vote-pip bar so unanimous vs split dissent reads in a glance.
    el(
      h,
      "div",
      { class: "vote-meter", attrs: { "aria-hidden": "true" } },
      ...r.readings.map((x) =>
        el(
          h,
          "span",
          { class: ["vote-pip", x.verdict ?? "missing"], attrs: { title: `Slot ${x.slot}: ${x.verdict ? VERDICT[x.verdict] ?? x.verdict : "no filing"}` } },
          el(h, "span", { class: "pip-dot" }),
          `#${x.slot} ${x.verdict ? VERDICT[x.verdict] ?? x.verdict : "missing"}`,
        )
      ),
      r.challenge != null &&
        el(
          h,
          "span",
          { class: ["vote-pip", "pip-challenge", r.challenge.outcome ?? "missing"] },
          `Challenger · ${r.challenge.outcome ?? "no filing"}`,
        ),
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
        (r.challenge.pieces?.length ?? 0) > 0 &&
          el(
            h,
            "details",
            { class: "disclosure" },
            el(
              h,
              "summary",
              {},
              `Challenger evidence (${r.challenge.pieces!.length} cited ${r.challenge.pieces!.length === 1 ? "excerpt" : "excerpts"})`,
            ),
            ...Pieces(h, r.challenge.pieces ?? []),
          ),
      ),
  );
};

/** A unified diff with crisp addition/deletion surface washes and file/hunk headers. */
const Diff = (h: H, text: string) =>
  el(
    h,
    "pre",
    { class: "diff" },
    ...text.split("\n").slice(0, 60).map((l) => {
      if (l.startsWith("+") && !l.startsWith("+++")) return el(h, "ins", { class: "diff-line" }, l);
      if (l.startsWith("-") && !l.startsWith("---")) return el(h, "del", { class: "diff-line" }, l);
      if (l.startsWith("@@") || l.startsWith("diff --git")) return el(h, "span", { class: "diff-line diff-meta" }, l);
      return el(h, "span", { class: "diff-line" }, l);
    }),
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
              "Eligible: unanimous real + upheld + observed after rollout ",
              el(h, "code", {}, String(f.deployed).slice(0, 12)),
              " (was ",
              el(h, "code", {}, String(f.previous).slice(0, 12)),
              "). Derived from Git & verified.",
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

/** The claims behind the verdict, each with its evidence; secondary Ruled out / Not checked fold cleanly into disclosures. */
const ClaimsPanel = (h: H, d: ItemDetail | null) => {
  const inv = d?.investigations.filter((x) => x.result).at(-1)?.result ?? null;
  const ids = inv
    ? new Set(inv.readings.filter((x) => x.verdict === inv.verdict || inv.verdict === "unsure").flatMap((x) => (x.findingId ? [x.findingId] : [])))
    : null;
  const findings = (d?.findings ?? []).filter((f) => (!ids || ids.has(f.id)) && !f.body?.challenge);
  if (!findings.length) return null;
  const list = (title: string, items: ReadonlyArray<string>) =>
    items.length ? el(h, "div", { class: "aside" }, el(h, "h4", {}, title), el(h, "ul", {}, ...items.map((t) => el(h, "li", {}, t)))) : null;
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
      const ruledOut = [...new Set(g.flatMap((x) => x.body?.ruled_out ?? []))];
      const notChecked = [...new Set(g.flatMap((x) => x.body?.not_checked ?? []))];
      const asideCount = ruledOut.length + notChecked.length;
      const asideLabel = [
        ruledOut.length > 0 ? `Ruled out (${ruledOut.length})` : null,
        notChecked.length > 0 ? `Not checked (${notChecked.length})` : null,
      ].filter(Boolean).join(" · ");
      return el(
        h,
        "article",
        { class: ["finding", f.verdict] },
        el(h, "header", {}, el(h, "b", {}, VERDICT[f.verdict] ?? f.verdict), el(h, "span", {}, f.body?.cause ?? ""), g.length > 1 && el(h, "em", { class: "said" }, `${g.length} readings said this`)),
        ...claims.flatMap((c) => [el(h, "p", { class: "claim" }, c.statement), ...Pieces(h, unseen(c.pieces ?? []))]),
        asideCount > 0 &&
          el(
            h,
            "details",
            { class: "disclosure" },
            el(h, "summary", {}, asideLabel),
            el(h, "div", { class: "asides" }, list("Ruled out", ruledOut), list("Not checked", notChecked)),
          ),
      );
    }),
  );
};

/** Estimate which 24h spark bucket marks the incident's onset after its deploy. */
const onsetBucketIndex = (spark: ReadonlyArray<number | null>): number | null => {
  const firstPositive = spark.findIndex((v) => typeof v === "number" && v > 0);
  return firstPositive >= 0 ? firstPositive : null;
};

const IncidentView = (h: H, i: Incident, d: ItemDetail | null, props: Props, snapshot: Snapshot) => {
  const now = snapshot.atMs;
  const off = props.connection === "down";
  const button = (action: ItemAction, label: string, key: string, title?: string) =>
    el(
      h,
      "button",
      { attrs: { type: "button", "data-action": action, title }, on: [h.Disabled(off), h.OnClick(Message.ClickedAction({ action }))] },
      `${label} `,
      Kbd(h, key),
    );
  const way = i.way;
  const until = way?.when ? " until it gets worse"
    : way?.untilMs ? ` until ${new Date(way.untilMs).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : way?.kind === "later" ? " until something changes"
    : "";
  const history = (d?.history ?? []).slice(-12).reverse();
  const started = [...snapshot.deploys].reverse().find((x) => x.app === i.app && x.environment === i.environment && x.seq < i.firstSeq);
  const sources = snapshot.sources.filter((x) => x.app === i.app && x.environment === i.environment);
  const env = snapshot.environments.find((x) => x.app === i.app && x.environment === i.environment);
  const highPolicy = env ? m.policyTags(env).filter((t) => t.highSignal) : [];
  const done = d?.investigations.filter((x) => x.result).at(-1);
  const left = ahead(snapshot, i, props.serverNow ?? snapshot.atMs).left;
  const fixing = (d?.fixes ?? []).some((f) => ["queued", "proposing", "verifying", "verified", "published", "draft"].includes(f.state));

  // Declarative GenUI Visual Lens: deterministic instant synthesis + AI lens switching when available.
  const derivedLens = synthesizeIncidentLens(snapshot, i, d, props.serverNow ?? snapshot.atMs);
  const { lens, hasAi, validation } = selectActiveLens(d, props.lensMode, props.cachedAiLens, derivedLens);
  const validHandles = knownHandles(d);

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
          ...PolicyPills(h, highPolicy),
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
    // Single-row triage + work + OpenCode split handoff bar
    el(
      h,
      "div",
      { class: "actions" },
      el(
        h,
        "div",
        { class: ["segmented", "triage-group"], attrs: { role: "group", "aria-label": "Triage" } },
        button("done", "Done", "d", "Mark dealt with; returns if it happens again (d)"),
        button("later", "Later", "l", "Snooze until something changes or a time (l)"),
        button("worse", "Worse", "w", "Snooze until it gets worse (w)"),
        button("never", "Never", "n", "Mute unless much worse or more severe (n)"),
      ),
      way != null && button("undo", "Put back", "u"),
      el(h, "span", { class: "sep", attrs: { "aria-hidden": "true" } }),
      button("investigate", "Investigate", "i"),
      el(
        h,
        "div",
        { class: ["segmented", "handoff-group"], attrs: { role: "group", "aria-label": "OpenCode handoff" } },
        button("open", "OpenCode", "o", "Open in an interactive OpenCode browser tab (o)"),
        el(
          h,
          "button",
          {
            class: "copy-handoff-btn",
            attrs: { type: "button", "data-action": "copyHandoff", title: "Copy structured OpenCode prompt with handles & MCP instructions (c · ⇧O for presets)" },
            on: [h.Disabled(off), h.OnClick(Message.ClickedAction({ action: "copyHandoff" }))],
          },
          CopyIcon(h),
          " Copy ",
          Kbd(h, "c"),
        ),
        el(
          h,
          "button",
          {
            class: "handoff-more-btn",
            attrs: { type: "button", "data-action": "handoffSheet", title: "Choose OpenCode handoff preset (⇧O)", "aria-label": "OpenCode handoff presets" },
            on: [h.Disabled(off), h.OnClick(Message.ClickedAction({ action: "handoffSheet" }))],
          },
          "⇧O",
        ),
      ),
      done !== undefined && button("correct", "Right?", "y", "Was this right? Save a correction to the app's playbook (y)"),
      done !== undefined && d?.fixable === true && !fixing && button("fix", "Fix", "f", "Propose a verified fix candidate (f)"),
    ),
    d?.comparison != null &&
      el(h, "section", { class: "panel" }, el(h, "h3", {}, "Staging against production"), el(h, "p", { class: ["note", "warn"] }, m.comparisonText(d.comparison) ?? "")),
    VerdictPanel(h, d),
    VisualLens(
      h,
      {
        lens,
        validation,
        validHandles,
        hasAi,
        mode: props.lensMode,
        loading: props.lensLoading,
        canGenerate: !off,
      },
      {
        onCopyHandle: (handle) => Message.ClickedHandle({ handle }),
        onSwitchMode: (mode: LensMode) => Message.ClickedLensMode({ mode }),
        onGenerateAi: () => Message.ClickedGenerateLens(),
      },
    ),
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
      AnnotatedSpark(h, i.spark, { deploySha: started?.revision ?? null, onsetIndex: started ? onsetBucketIndex(i.spark) : null }),
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
  const envLens = synthesizeEnvLens(snapshot, e, props.serverNow ?? snapshot.atMs);
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
        el(
          h,
          "div",
          { class: "meta" },
          el(h, "span", {}, m.HEALTH_LABEL[health] ?? ""),
          e.excluded.length > 0 && el(h, "span", {}, `not measured here: ${e.excluded.join(", ")}`),
          ...PolicyPills(h, m.policyTags(e)),
        ),
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
    envLens &&
      VisualLens(
        h,
        {
          lens: envLens,
          validation: validateLensHandles(envLens, new Set()),
          validHandles: new Set(),
          hasAi: false,
          mode: "derived",
          loading: false,
          canGenerate: false,
        },
        { onCopyHandle: (handle) => Message.ClickedHandle({ handle }) },
      ),
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
            el(h, r.state === "ok" ? "span" : "em", { class: r.state === "ok" ? "gauge-note" : "" }, r.okMs === null ? "never measured" : `measured ${m.ago(r.okMs, props.serverNow ?? snapshot.atMs)}`),
          )
        ),
      ),
    ),
    Coverage(h, snapshot, coverage),
  );
};

export const view = defineView<Model, Message, Props>((_model, props, h) => {
  const { snapshot, focus } = props;
  const stage = { class: "stage", attrs: { "data-stage": "", "aria-live": "polite", "data-focus-id": focus ?? undefined } };
  if (focus === null) {
    return el(
      h,
      "section",
      stage,
      snapshot === null
        ? null
        : Overview(
          h,
          { snapshot, connection: props.connection, serverNow: props.serverNow, caughtUp: props.caughtUp, whatsNewWindow: props.whatsNewWindow },
          {
            onPick: (subject) => Message.ClickedSubject({ subject }),
            onMarkCaughtUp: () => Message.ClickedMarkCaughtUp(),
            onToggleWindow: () => Message.ClickedToggleWhatsNewWindow(),
          },
        ),
    );
  }
  const back = el(h, "button", { class: "stage-back", attrs: { type: "button", "data-back": "" }, on: [h.OnClick(Message.ClickedBack())] }, "← Inbox");
  if (snapshot !== null && focus.startsWith("env:")) return el(h, "section", stage, back, EnvironmentView(h, focus, props, snapshot));
  if (snapshot !== null && focus.startsWith("src:")) return el(h, "section", stage, back, SourceView(h, focus, props, snapshot));
  const d = props.detail?.incident.id === focus ? props.detail : null;
  const i = snapshot?.incidents.find((x) => x.id === focus) ?? d?.incident;
  if (snapshot === null || i === undefined) return el(h, "section", stage, el(h, "div", { class: "stage-empty" }, el(h, "b", {}, "Loading…")));
  return el(h, "section", stage, back, IncidentView(h, i, d, props, snapshot));
});
