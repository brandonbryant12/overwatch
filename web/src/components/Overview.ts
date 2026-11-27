/**
 * Calm "At a Glance" Situation Board shown on the Stage when nothing is focused.
 * Replaces empty void with scannable environment freshness pulses, ready-for-keypress highlights, recent rollouts and
 * watched commits, and a single-row keyboard legend.
 */
import type { Snapshot } from "../domain/Overwatch.ts";
import * as m from "../model.ts";
import { el, type H } from "../ui.ts";
import { CommitIcon, HealthGlyph, SeverityGlyph } from "./Glyphs.ts";
import { ahead } from "./Outlook.ts";

export interface OverviewProps {
  readonly snapshot: Snapshot;
  readonly connection: m.Connection;
  readonly serverNow: number | null;
  readonly caughtUp: m.CaughtUp | null;
  readonly whatsNewWindow: m.WhatsNewWindow;
}

export interface OverviewHandlers<M> {
  readonly onPick: (subject: string) => M;
  readonly onMarkCaughtUp: () => M;
  readonly onToggleWindow: () => M;
}

const freshnessPct = (readings: Snapshot["environments"][number]["readings"], freshForMs: number, now: number | null): number => {
  if (now === null || readings.length === 0 || freshForMs <= 0) return 0;
  let oldestAge = 0;
  for (const r of readings) {
    if (r.okMs === null) return 0;
    oldestAge = Math.max(oldestAge, Math.max(0, now - r.okMs));
  }
  return Math.max(0, Math.min(100, Math.round((1 - oldestAge / freshForMs) * 100)));
};

const WhatsNewRow = <M>(h: H<M>, item: m.WhatsNewItem, onPick: (subject: string) => M) =>
  el(
    h,
    "li",
    {},
    el(
      h,
      "button",
      {
        class: ["wn-item", `wn-${item.tone}`],
        attrs: { type: "button", "data-whats-new-item": item.id },
        on: [h.Key(item.id), h.OnClick(onPick(item.subject))],
      },
      el(
        h,
        "span",
        { class: "wn-body" },
        el(h, "b", {}, item.title),
        el(h, "span", { class: "wn-detail" }, item.detail),
      ),
      item.badge && el(h, "span", { class: ["wn-badge", `wn-badge-${item.tone}`] }, item.badge),
      el(h, "span", { class: "ready-go", attrs: { "aria-hidden": "true" } }, "→"),
    ),
  );

export const Overview = <M>(h: H<M>, { snapshot, connection, serverNow, caughtUp, whatsNewWindow }: OverviewProps, handlers: OverviewHandlers<M>) => {
  const { onPick, onMarkCaughtUp, onToggleWindow } = handlers;
  const g = snapshot.inbox.groups;
  const n = g.needsYou.length;
  const now = serverNow ?? snapshot.atMs;
  const regressions = (snapshot.outlook?.comparisons ?? []).filter((c) => c.state === "regression");
  const watchedCommits = (snapshot.outlook?.commits ?? []).slice(0, 4);
  const recentDeploys = [...snapshot.deploys].reverse().slice(0, 4);
  const wn = m.whatsNew(snapshot, caughtUp, now, whatsNewWindow);
  const hasCheckpoint = caughtUp !== null && caughtUp.seq <= snapshot.seq;

  // Keep Ready for your keypress strictly for active needsYou items so marking caught up never hides urgent errors.
  const urgent = g.needsYou
    .slice(0, 3)
    .map((id) => snapshot.incidents.find((x) => x.id === id))
    .filter((x): x is Snapshot["incidents"][number] => x !== undefined);

  const keyHint = (keys: string, label: string) =>
    el(h, "span", { class: "key-item" }, el(h, "kbd", {}, keys), " ", label);

  return el(
    h,
    "div",
    { class: "overview-board", attrs: { "data-overview": "" } },
    el(
      h,
      "header",
      { class: "board-head" },
      el(h, "img", { attrs: { src: "logo.svg", alt: "", width: "40", height: "40" } }),
      el(
        h,
        "div",
        { class: "board-title" },
        el(h, "h2", {}, n ? `${n} ${n === 1 ? "problem needs" : "problems need"} you` : "All clear — nothing needs you"),
        el(
          h,
          "p",
          {},
          `${g.new.length} new · ${g.working.length} with an agent · ${g.quiet.length} quiet`,
          regressions.length > 0 ? ` · ${regressions.length} staging check${regressions.length === 1 ? "" : "s"}` : "",
        ),
      ),
    ),
    // Environment Pulse Grid
    snapshot.environments.length > 0 &&
      el(
        h,
        "section",
        { class: "board-section" },
        el(h, "h3", {}, "Environment pulse"),
        el(
          h,
          "div",
          { class: "pulse-grid" },
          ...snapshot.environments.map((e) => {
            const health = m.cellHealth(e, connection, serverNow);
            const errors = snapshot.incidents.filter((i) => i.app === e.app && i.environment === e.environment && i.active && i.severity === "error").length;
            const latestDeploy = [...snapshot.deploys].reverse().find((d) => d.app === e.app && d.environment === e.environment);
            const pct = connection === "live" && health !== "signed_out" && health !== "stale" ? freshnessPct(e.readings, e.freshForMs, now) : 0;
            const { left, signal } = ahead(snapshot, e, now);
            const tags = m.policyTags(e);
            return el(
              h,
              "button",
              {
                class: ["pulse-card", health],
                attrs: { type: "button", "data-overview-env": e.subject },
                on: [h.Key(e.subject), h.OnClick(onPick(e.subject))],
              },
              el(
                h,
                "div",
                { class: "pulse-top" },
                el(h, "span", { class: "pulse-glyph" }, HealthGlyph(h, health)),
                el(h, "b", {}, e.environment),
                el(h, "span", { class: "pulse-app" }, e.app),
                latestDeploy && el(h, "code", { class: "pulse-sha" }, latestDeploy.revision.slice(0, 7)),
              ),
              el(
                h,
                "div",
                { class: "pulse-status" },
                el(h, "span", { class: "pulse-label" }, m.HEALTH_LABEL[health] ?? health),
                errors > 0 && el(h, "span", { class: "pulse-errors" }, `${errors} active`),
              ),
              el(
                h,
                "div",
                { class: "fresh-track", attrs: { title: pct > 0 ? `Readings ${pct}% fresh within window` : "Readings not fresh" } },
                el(h, "span", { class: ["fresh-fill", health], attrs: { style: `width:${pct}%` } }),
              ),
              (left !== null || signal?.state === "regression") &&
                el(
                  h,
                  "div",
                  { class: "pulse-ahead" },
                  left ? left.short : "staging check: new since release",
                ),
              tags.length > 0 &&
                el(
                  h,
                  "div",
                  { class: "pulse-policy" },
                  ...tags.map((t) => el(h, "span", { class: ["policy-pill", `policy-${t.tone}`], attrs: { title: t.title } }, t.label)),
                ),
            );
          }),
        ),
      ),
    // Calm What's New card
    el(
      h,
      "section",
      { class: ["board-section", "whats-new", wn.count === 0 && "whats-new-empty"], attrs: { "data-whats-new": "" } },
      wn.count === 0
        ? el(
          h,
          "div",
          { class: "whats-new-quiet" },
          el(
            h,
            "span",
            {},
            hasCheckpoint && wn.window === "since"
              ? `Caught up since ${m.ago(caughtUp.atMs, now)}`
              : "Nothing new in the last 24h",
          ),
          hasCheckpoint &&
            el(
              h,
              "button",
              { class: "wn-toggle", attrs: { type: "button", "data-whats-new-toggle": "" }, on: [h.OnClick(onToggleWindow())] },
              wn.window === "since" ? "Show last 24h" : "Since caught up",
            ),
        )
        : el(
          h,
          "div",
          { class: "whats-new-card" },
          el(
            h,
            "header",
            { class: "whats-new-head" },
            el(
              h,
              "h3",
              {},
              wn.window === "24h" ? "What's new · last 24h" : `What's new · since ${m.ago(wn.sinceAtMs, now)}`,
              el(h, "span", { class: "wn-count" }, ` (${wn.count})`),
            ),
            el(
              h,
              "div",
              { class: "whats-new-actions" },
              hasCheckpoint && wn.window === "24h" &&
                el(
                  h,
                  "button",
                  { class: "wn-toggle", attrs: { type: "button", "data-whats-new-toggle": "" }, on: [h.OnClick(onToggleWindow())] },
                  "Since caught up",
                ),
              el(
                h,
                "button",
                { class: "wn-mark", attrs: { type: "button", "data-mark-caught-up": "" }, on: [h.OnClick(onMarkCaughtUp())] },
                "Mark caught up",
              ),
            ),
          ),
          el(
            h,
            "div",
            { class: "wn-groups" },
            ...wn.groups.map((grp) =>
              el(
                h,
                "div",
                { class: "wn-group", on: [h.Key(grp.kind)] },
                el(h, "div", { class: "wn-group-label" }, grp.label),
                el(h, "ul", { class: "wn-list" }, ...grp.items.map((item) => WhatsNewRow(h, item, onPick))),
              )
            ),
          ),
          wn.overflow.length > 0 &&
            el(
              h,
              "details",
              { class: "disclosure" },
              el(h, "summary", {}, `Show ${wn.overflow.length} more`),
              el(h, "ul", { class: ["wn-list", "wn-overflow-list"] }, ...wn.overflow.map((item) => WhatsNewRow(h, item, onPick))),
            ),
        ),
    ),
    // Ready for your keypress
    urgent.length > 0 &&
      el(
        h,
        "section",
        { class: "board-section" },
        el(h, "h3", {}, "Ready for your keypress"),
        el(
          h,
          "ul",
          { class: "ready-list" },
          ...urgent.map((inc) =>
            el(
              h,
              "li",
              {},
              el(
                h,
                "button",
                {
                  class: ["ready-card", `sev-${inc.severity}`],
                  attrs: { type: "button" },
                  on: [h.Key(inc.id), h.OnClick(onPick(inc.id))],
                },
                el(h, "span", { class: "sev" }, SeverityGlyph(h, inc.severity)),
                el(
                  h,
                  "span",
                  { class: "ready-body" },
                  el(h, "b", {}, inc.title),
                  el(h, "span", { class: "ready-meta" }, `${inc.app} / ${inc.environment} · ${m.countText(inc.count, inc.exact)} · ${m.ago(inc.lastMs, snapshot.atMs)}`),
                ),
                el(h, "span", { class: "ready-go", attrs: { "aria-hidden": "true" } }, "→"),
              ),
            )
          ),
        ),
      ),
    // Recent commits (when commitWatch active) or recent rollouts
    (watchedCommits.length > 0 || recentDeploys.length > 0) &&
      el(
        h,
        "section",
        { class: "board-section" },
        el(h, "h3", {}, watchedCommits.length > 0 ? "Recent commits" : "Recent rollouts"),
        watchedCommits.length > 0
          ? el(
            h,
            "ul",
            { class: "commit-rows" },
            ...watchedCommits.map((c) =>
              el(
                h,
                "li",
                { class: "commit-row" },
                el(h, "span", { class: "commit-icon" }, CommitIcon(h)),
                el(h, "code", { class: "commit-sha" }, c.sha.slice(0, 8)),
                el(h, "span", { class: "commit-subject" }, c.subject),
                el(h, "span", { class: "commit-stat" }, el(h, "ins", {}, `+${c.insertions}`), " ", el(h, "del", {}, `-${c.deletions}`)),
                el(
                  h,
                  "span",
                  { class: "commit-flags" },
                  el(h, "span", { class: ["flag", c.deployedEnvs.length > 0 ? "flag-ok" : "flag-warn"] }, c.deployedEnvs.length > 0 ? c.deployedEnvs.join(", ") : "unreleased"),
                  ...c.flags.filter((f) => f !== "deployed" && f !== "unreleased").slice(0, 2).map((flag) => el(h, "span", { class: "flag" }, flag)),
                ),
              )
            ),
          )
          : el(
            h,
            "ul",
            { class: "rollout-strip" },
            ...recentDeploys.map((d) =>
              el(
                h,
                "li",
                { class: "rollout-item" },
                el(h, "span", { class: "commit-icon" }, CommitIcon(h)),
                el(h, "code", {}, d.revision.slice(0, 8)),
                d.previous && el(h, "span", { class: "rollout-prev" }, `← ${d.previous.slice(0, 8)}`),
                el(h, "span", { class: "place" }, `${d.app} / ${d.environment}`),
              )
            ),
          ),
      ),
    el(
      h,
      "footer",
      { class: "board-keys" },
      keyHint("j / k", "focus"),
      keyHint("d", "done"),
      keyHint("/", "find"),
      keyHint("c", "copy for OpenCode"),
      keyHint("b", "brief"),
      keyHint("?", "all keys"),
    ),
  );
};
