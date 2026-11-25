/**
 * Presentation layer for the Overwatch command center.
 * Pure functions from Model -> Foldkit Html. Every style lives in `style.css`.
 */
import * as Option from "effect/Option";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import type { Finding } from "../../src/domain/finding.ts";
import type { SearchHit } from "../../src/domain/search.ts";
import type { IncidentPageState, InboxItem, ThreadPageState } from "../../src/domain/views.ts";
import {
  draftOf,
  environmentChips,
  type EnvState,
  isProdEnv,
  isSending,
  Message,
  visibleInbox,
  type EnvFilter,
  type Model,
  type Override,
  type SortOrder,
} from "./app.ts";
import {
  iconArchive,
  iconClose,
  iconCopy,
  iconKeyboard,
  iconLive,
  iconMoon,
  iconOffline,
  iconPromptStatus,
  iconReticle,
  iconSearch,
  iconSend,
  iconSeverity,
  iconSun,
  iconTerminal,
  iconUnverified,
  iconVerified,
  logoMark,
  logoWordmark,
} from "./icons.ts";

type H = HtmlBuilder<Message>;

const utcStamp = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";

function relativeAge(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function verdictLabel(verdict: string): string {
  if (verdict === "not_real") return "not real";
  return verdict;
}

function promptStatusLabel(status: string): string {
  switch (status) {
    case "sent":
      return "Running";
    case "queued":
      return "Queued";
    case "answered":
      return "Answered";
    case "failed":
      return "Failed";
    default:
      return "Held";
  }
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}...${id.slice(-4)}` : id;
}

export function renderDocument(model: Model, h: H, routePreview: string): Document {
  return {
    title: model.inbox.length ? `Overwatch (${model.inbox.length})` : "Overwatch",
    body: h.div(
      [h.Class("app"), h.DataAttribute("theme", model.theme)],
      [
        headerView(model, h),
        ...(model.status ? [fleetStripView(model, h)] : []),
        ...(model.notice ? [noticeBarView(model.notice, h)] : []),
        ...(model.connection === "offline" && !model.notice
          ? [noticeBarView("Service connection lost. Waiting to reconnect.", h)]
          : []),
        h.div(
          [h.Class("deck")],
          [
            inboxRailView(model, h),
            h.div(
              [h.Class("stage")],
              [
                h.main([h.Class("focus-pane"), h.Id("focus-pane")], focusView(model, h)),
                promptBarView(model, h, routePreview),
              ],
            ),
          ],
        ),
        ...(model.searchOpen ? [searchModalView(model, h)] : []),
        ...(model.statusOpen ? [statusDrawerView(model, h)] : []),
        ...(model.shortcutsOpen ? [shortcutsModalView(h)] : []),
      ],
    ),
  };
}

const ENV_GLYPH: Record<EnvState, string> = { failing: "◆", attention: "▲", unchecked: "?", stale: "?", quiet: "●" };

/** Each watched environment, compact: its state in words and a glyph, how fresh its last check is, readiness and memory. */
function fleetStripView(model: Model, h: H): Html {
  const chips = environmentChips(model);
  return h.nav(
    [h.Class("fleet-strip"), h.AriaLabel("Environments")],
    chips.length === 0
      ? [h.span([h.Class("fleet-empty")], ["No watchers configured."])]
      : chips.map((chip) =>
          h.div(
            [h.Key(chip.key), h.Class(`env-chip state-${chip.state} tier-${chip.tier}`), h.Title(`${chip.key} (${chip.tier}): ${chip.label}`)],
            [
              h.div(
                [h.Class("env-chip-top")],
                [
                  h.span([h.Class("env-chip-name")], [chip.key]),
                  h.span([h.Class("env-chip-state")], [h.span([h.Class("env-chip-glyph"), h.AriaHidden(true)], [ENV_GLYPH[chip.state]]), chip.label]),
                ],
              ),
              ...(chip.details.length ? [h.div([h.Class("env-chip-details")], [chip.details.join(" · ")])] : []),
            ],
          ),
        ),
  );
}

function headerView(model: Model, h: H): Html {
  const oc = model.status?.opencode;
  const ocConnected = oc?.connected === true;
  const waiting = oc?.waitingRuns ?? 0;
  const running = oc?.runningRuns ?? 0;
  const watcherErrors = model.status?.watchers.filter((w) => w.last_error !== null).length ?? 0;
  const configErrors = model.status?.configErrors.length ?? 0;

  let statusClass = "status-trigger";
  let statusIcon: Html = iconUnverified(h);
  let statusText = "Checking status";

  if (model.statusError) {
    statusClass = "status-trigger offline";
    statusIcon = iconOffline(h);
    statusText = "Service offline";
  } else if (oc) {
    if (ocConnected) {
      statusClass = running > 0 ? "status-trigger active" : "status-trigger ok";
      statusIcon = running > 0 ? iconPromptStatus(h, "sent") : iconLive(h);
      statusText = running > 0 ? `OpenCode · ${running} running` : "OpenCode connected";
    } else {
      statusClass = "status-trigger suspended";
      statusIcon = iconOffline(h);
      statusText = waiting > 0 ? `OpenCode offline · ${waiting} queued` : "OpenCode offline";
    }
    if (watcherErrors > 0 || configErrors > 0) {
      statusClass = "status-trigger warn";
    }
  }

  return h.header(
    [h.Class("topbar")],
    [
      h.div(
        [h.Class("brand-group")],
        [
          h.div([h.Class("brand"), h.Role("banner")], [logoMark(h, 28), logoWordmark(h), h.span([h.Class("sr-only")], ["Overwatch"])]),
          h.span(
            [h.Class(`stream-state ${model.connection}`), h.AriaLive("polite")],
            [
              model.connection === "live"
                ? iconLive(h)
                : model.connection === "offline"
                  ? iconOffline(h)
                  : iconPromptStatus(h, "queued"),
              h.span([], [model.connection === "live" ? "Live" : model.connection === "offline" ? "Disconnected" : "Connecting"]),
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Class("search-trigger"),
          h.Type("button"),
          h.OnClick(Message.OpenedSearch()),
          h.AriaLabel("Search incidents, findings, prompts, and threads"),
        ],
        [
          iconSearch(h),
          h.span([h.Class("search-trigger-label")], ["Search incidents, findings, archived..."]),
          h.kbd([h.Class("kbd")], ["/"]),
        ],
      ),
      h.div(
        [h.Class("topbar-actions")],
        [
          h.button(
            [
              h.Class(statusClass),
              h.Type("button"),
              h.OnClick(Message.ToggledStatusPanel()),
              h.AriaExpanded(model.statusOpen),
              h.Title("Inspect OpenCode connection and watchers"),
            ],
            [statusIcon, h.span([], [statusText])],
          ),
          h.button(
            [
              h.Class("icon-btn"),
              h.Type("button"),
              h.OnClick(Message.ToggledTheme()),
              h.AriaLabel(model.theme === "dark" ? "Switch to Daylight Chart light theme" : "Switch to Night Watch dark theme"),
              h.Title(model.theme === "dark" ? "Daylight theme (t)" : "Night Watch theme (t)"),
            ],
            [model.theme === "dark" ? iconSun(h) : iconMoon(h)],
          ),
          h.button(
            [
              h.Class("icon-btn"),
              h.Type("button"),
              h.OnClick(Message.ToggledShortcuts()),
              h.AriaExpanded(model.shortcutsOpen),
              h.AriaLabel("Keyboard shortcuts"),
              h.Title("Keyboard shortcuts (?)"),
            ],
            [iconKeyboard(h)],
          ),
        ],
      ),
    ],
  );
}

function noticeBarView(text: string, h: H): Html {
  return h.div(
    [h.Class("notice-bar"), h.Role("alert")],
    [
      iconSeverity(h, "error"),
      h.span([h.Class("notice-text")], [text]),
      h.button(
        [h.Class("notice-dismiss"), h.Type("button"), h.OnClick(Message.DismissedNotice()), h.AriaLabel("Dismiss notice")],
        [iconClose(h)],
      ),
    ],
  );
}

function inboxRailView(model: Model, h: H): Html {
  const items = visibleInbox(model);
  const prodCount = model.inbox.filter((i) => isProdEnv(i.environment)).length;
  const preprodCount = model.inbox.length - prodCount;

  const filterOption = (value: EnvFilter, label: string, count?: number): Html =>
    h.button(
      [
        h.Class(model.envFilter === value ? "seg-option active" : "seg-option"),
        h.Type("button"),
        h.Role("radio"),
        h.AriaChecked(model.envFilter === value),
        h.OnClick(Message.ChangedEnvFilter({ filter: value })),
      ],
      [label, ...(count !== undefined ? [h.span([h.Class("seg-count")], [String(count)])] : [])],
    );

  const sortOption = (value: SortOrder, label: string): Html =>
    h.button(
      [
        h.Class(model.sortOrder === value ? "seg-option active" : "seg-option"),
        h.Type("button"),
        h.Role("radio"),
        h.AriaChecked(model.sortOrder === value),
        h.OnClick(Message.ChangedSortOrder({ order: value })),
      ],
      [label],
    );

  return h.aside(
    [h.Class("inbox-rail"), h.AriaLabel("Incident inbox")],
    [
      h.div(
        [h.Class("rail-header")],
        [
          h.div(
            [h.Class("rail-title-row")],
            [
              h.h2([h.Class("rail-heading")], ["Inbox"]),
              h.span([h.Class("rail-total")], [String(model.inbox.length)]),
            ],
          ),
          h.div(
            [h.Class("rail-controls")],
            [
              h.div(
                [h.Class("segmented"), h.Role("radiogroup"), h.AriaLabel("Filter by environment tier")],
                [
                  filterOption("all", "All", model.inbox.length),
                  filterOption("prod", "Prod", prodCount),
                  filterOption("preprod", "Pre-prod", preprodCount),
                ],
              ),
              h.div(
                [h.Class("segmented"), h.Role("radiogroup"), h.AriaLabel("Sort order")],
                [sortOption("priority", "Priority"), sortOption("recent", "Recent")],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("inbox-scroll")],
        [
          model.connection === "connecting" && model.inbox.length === 0
            ? inboxConnectingView(h)
            : model.inbox.length === 0
              ? inboxEmptyView(model, h)
              : items.length === 0
                ? h.div(
                    [h.Class("rail-empty")],
                    [
                      h.p([h.Class("empty-title")], ["No incidents match this filter."]),
                      h.button(
                        [h.Class("text-action"), h.Type("button"), h.OnClick(Message.ChangedEnvFilter({ filter: "all" }))],
                        ["Show all environments"],
                      ),
                    ],
                  )
                : h.ul(
                    [h.Class("inbox-list"), h.Role("listbox"), h.AriaLabel("Incidents")],
                    items.map((item) => inboxItemView(item, item.incidentId === model.focus, h)),
                  ),
        ],
      ),
      h.div(
        [h.Class("rail-footer")],
        [
          h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["j"]), h.kbd([h.Class("kbd")], ["k"]), " move"]),
          h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["a"]), " archive"]),
          h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["p"]), " prompt"]),
        ],
      ),
    ],
  );
}

function inboxConnectingView(h: H): Html {
  return h.div(
    [h.Class("rail-loading"), h.AriaBusy(true)],
    [
      h.div([h.Class("skel-row")], [h.div([h.Class("skel-line wide")]), h.div([h.Class("skel-line narrow")])]),
      h.div([h.Class("skel-row")], [h.div([h.Class("skel-line wide")]), h.div([h.Class("skel-line mid")])]),
      h.div([h.Class("skel-row")], [h.div([h.Class("skel-line wide")]), h.div([h.Class("skel-line narrow")])]),
    ],
  );
}

function inboxEmptyView(model: Model, h: H): Html {
  const watcherCount = model.status?.watchers.length ?? 0;
  return h.div(
    [h.Class("rail-empty all-clear")],
    [
      h.div([h.Class("empty-icon")], [iconVerified(h)]),
      h.p([h.Class("empty-title")], ["Inbox clear"]),
      h.p(
        [h.Class("empty-copy")],
        [
          watcherCount > 0
            ? `${watcherCount} watchers polling on schedule. Archived incidents stay quiet unless something new breaks.`
            : "Nothing needs your decision right now. New incidents appear live without reload.",
        ],
      ),
      h.button(
        [h.Class("text-action"), h.Type("button"), h.OnClick(Message.OpenedSearch())],
        ["Search archived history"],
      ),
    ],
  );
}

function inboxItemView(item: InboxItem, focused: boolean, h: H): Html {
  const prod = isProdEnv(item.environment);
  return h.li(
    [
      h.Key(item.incidentId),
      h.Class(`inbox-item sev-${item.severity}${focused ? " focused" : ""}${prod ? " tier-prod" : ""}`),
      h.DataAttribute("incident", item.incidentId),
      h.Role("option"),
      h.AriaSelected(focused),
      h.Tabindex(0),
      h.OnClick(Message.ClickedItem({ incidentId: item.incidentId })),
      h.OnKeyDownPreventDefault((key) =>
        key === "Enter" || key === " " ? Option.some(Message.ClickedItem({ incidentId: item.incidentId })) : Option.none(),
      ),
    ],
    [
      h.div(
        [h.Class("item-top")],
        [
          h.span([h.Class(`sev-glyph sev-${item.severity}`), h.Title(`Severity: ${item.severity}`)], [iconSeverity(h, item.severity)]),
          h.span([h.Class("item-title")], [item.title]),
          h.button(
            [
              h.Class("item-archive-btn"),
              h.Type("button"),
              h.Title("Archive incident (a)"),
              h.AriaLabel(`Archive ${item.title}`),
              h.OnClick(Message.ClickedArchive({ incidentId: item.incidentId }), { propagation: "Stop" }),
            ],
            [iconArchive(h)],
          ),
        ],
      ),
      h.div(
        [h.Class("item-meta")],
        [
          h.span([h.Class(prod ? "env-ref prod" : "env-ref")], [`${item.app} / ${item.environment}`]),
          h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
          h.span([h.Class("meta-count")], [`${item.occurrences}×`]),
          h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
          h.time([h.Class("meta-time"), h.Title(utcStamp(item.lastAt))], [relativeAge(item.lastAt)]),
        ],
      ),
      ...(item.verdict
        ? [
            h.div(
              [h.Class(`item-verdict verdict-${item.verdict}`)],
              [
                h.span([h.Class("verdict-tag")], [verdictLabel(item.verdict)]),
                h.span([h.Class("verdict-cause")], [item.cause ?? ""]),
              ],
            ),
          ]
        : []),
    ],
  );
}

function focusView(model: Model, h: H): ReadonlyArray<Html> {
  if (!model.focus) {
    return [emptyFocusView(model, h)];
  }
  const page = model.page;
  if (!page) {
    return [focusLoadingView(h)];
  }
  return [
    focusHeaderView(page, h),
    signalEvidenceView(page, model.copiedQuery, h),
    findingsSectionView(page, h),
    threadSectionView(model.thread, model.status?.opencode.connected ?? null, h),
    timelineSectionView(page, h),
  ];
}

function emptyFocusView(model: Model, h: H): Html {
  const hasItems = model.inbox.length > 0;
  return h.div(
    [h.Class("empty-focus")],
    [
      h.div([h.Class("empty-focus-reticle")], [logoMark(h, 52)]),
      h.h2([h.Class("empty-focus-title")], [hasItems ? "Put an incident in focus" : "All environments quiet"]),
      h.p(
        [h.Class("empty-focus-copy")],
        [
          hasItems
            ? "Select any incident on the left to inspect its telemetry, checked citations, and agent thread, or prompt directly with it locked in focus."
            : "Every watcher is on schedule and nothing is waiting for a decision. Press / to search past incidents, findings, and archived threads.",
        ],
      ),
      h.div(
        [h.Class("key-summary")],
        [
          h.div([h.Class("key-pair")], [h.kbd([h.Class("kbd")], ["j / k"]), h.span([], ["Step through inbox"])]),
          h.div([h.Class("key-pair")], [h.kbd([h.Class("kbd")], ["p"]), h.span([], ["Focus prompt bar"])]),
          h.div([h.Class("key-pair")], [h.kbd([h.Class("kbd")], ["a"]), h.span([], ["Archive focused item"])]),
          h.div([h.Class("key-pair")], [h.kbd([h.Class("kbd")], ["/"]), h.span([], ["Search everything"])]),
        ],
      ),
    ],
  );
}

function focusLoadingView(h: H): Html {
  return h.div(
    [h.Class("focus-loading"), h.AriaBusy(true)],
    [
      h.div([h.Class("skel-line wide tall")]),
      h.div([h.Class("skel-line mid")]),
      h.div([h.Class("skel-block")]),
      h.div([h.Class("skel-block")]),
    ],
  );
}

function focusHeaderView(page: IncidentPageState, h: H): Html {
  const archived = page.disposition === "archived";
  const prod = isProdEnv(page.environment);
  return h.header(
    [h.Class("focus-header")],
    [
      h.div(
        [h.Class("focus-anchor-row")],
        [
          h.div(
            [h.Class("focus-lock")],
            [
              iconReticle(h),
              h.span([h.Class(prod ? "focus-target prod" : "focus-target")], [`${page.app} / ${page.environment}`]),
              h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
              h.span([h.Class("focus-source")], [page.source]),
              h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
              h.code([h.Class("mono-id")], [page.incidentId]),
            ],
          ),
          archived
            ? h.span([h.Class("disposition-state archived")], [iconArchive(h), "Archived"])
            : h.button(
                [
                  h.Class("archive-action"),
                  h.Type("button"),
                  h.OnClick(Message.ClickedArchive({ incidentId: page.incidentId })),
                ],
                [iconArchive(h), h.span([], ["Archive"]), h.kbd([h.Class("kbd")], ["a"])],
              ),
        ],
      ),
      h.div(
        [h.Class("focus-title-row")],
        [
          h.span([h.Class(`sev-glyph large sev-${page.severity}`)], [iconSeverity(h, page.severity)]),
          h.h2([h.Class("focus-title")], [page.title]),
        ],
      ),
      h.dl(
        [h.Class("focus-facts")],
        [
          h.div([h.Class("fact")], [h.dt([], ["Severity"]), h.dd([h.Class(`fact-sev-${page.severity}`)], [page.severity])]),
          h.div([h.Class("fact")], [h.dt([], ["Occurrences"]), h.dd([], [`${page.occurrences}×`])]),
          h.div(
            [h.Class("fact")],
            [h.dt([], ["First seen"]), h.dd([h.Title(utcStamp(page.firstAt))], [`${relativeAge(page.firstAt)} (${utcStamp(page.firstAt)})`])],
          ),
          h.div(
            [h.Class("fact")],
            [h.dt([], ["Last seen"]), h.dd([h.Title(utcStamp(page.lastAt))], [`${relativeAge(page.lastAt)} (${utcStamp(page.lastAt)})`])],
          ),
          h.div([h.Class("fact")], [h.dt([], ["Fingerprint"]), h.dd([h.Class("mono")], [page.fingerprint])]),
        ],
      ),
    ],
  );
}

function signalEvidenceView(page: IncidentPageState, copiedQuery: boolean, h: H): Html {
  if (!page.sample && !page.query) return h.div([h.Class("sr-only")], []);
  return h.section(
    [h.Class("detail-section")],
    [
      h.h3([h.Class("section-heading")], ["Observed signal"]),
      ...(page.sample ? [h.pre([h.Class("code-well sample-well")], [h.code([], [page.sample])])] : []),
      ...(page.query
        ? [
            h.div(
              [h.Class("query-row")],
              [
                h.span([h.Class("query-icon")], [iconTerminal(h)]),
                h.code([h.Class("query-cmd")], [page.query]),
                h.button(
                  [
                    h.Class(copiedQuery ? "copy-btn copied" : "copy-btn"),
                    h.Type("button"),
                    h.OnClick(Message.ClickedCopyQuery({ query: page.query })),
                  ],
                  [copiedQuery ? iconVerified(h) : iconCopy(h), h.span([], [copiedQuery ? "Copied" : "Copy"])],
                ),
              ],
            ),
          ]
        : []),
    ],
  );
}

function findingsSectionView(page: IncidentPageState, h: H): Html {
  const ordered = [...page.findings].reverse();
  return h.section(
    [h.Class("detail-section")],
    [
      h.div(
        [h.Class("section-header-row")],
        [
          h.h3([h.Class("section-heading")], ["Findings"]),
          h.span([h.Class("section-count")], [String(page.findings.length)]),
        ],
      ),
      ordered.length === 0
        ? h.p([h.Class("section-empty")], ["No finding filed yet. Citations are checked by code before any finding appears here."])
        : h.div(
            [h.Class("findings-list")],
            ordered.map((entry, index) => findingView(entry.finding, entry.at, entry.sessionId, ordered.length - index, h)),
          ),
    ],
  );
}

function findingView(finding: Finding, at: number, sessionId: string, num: number, h: H): Html {
  const eng = finding.engineering;
  const prod = finding.product;
  const verdictIcon =
    eng.verdict === "real"
      ? iconSeverity(h, "error")
      : eng.verdict === "not_real"
        ? iconVerified(h)
        : iconUnverified(h);

  return h.article(
    [h.Class(`finding-block verdict-${eng.verdict}`)],
    [
      h.div(
        [h.Class("finding-head")],
        [
          h.span([h.Class(`verdict-cell verdict-${eng.verdict}`)], [verdictIcon, h.span([], [verdictLabel(eng.verdict)])]),
          h.span([h.Class("finding-meta-item")], [`${eng.confidence} confidence`]),
          h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
          h.span([h.Class("finding-meta-item")], [eng.causeBasis]),
          ...(eng.codeLocation
            ? [h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]), h.code([h.Class("code-loc")], [eng.codeLocation])]
            : []),
          h.span([h.Class("finding-time"), h.Title(`${utcStamp(at)} · session ${sessionId}`)], [`#${num} · ${relativeAge(at)}`]),
        ],
      ),
      h.p([h.Class("finding-cause")], [eng.cause]),
      h.dl(
        [h.Class("product-grid")],
        [
          h.div([h.Class("product-cell wide")], [h.dt([], ["Impact"]), h.dd([], [prod.impact])]),
          h.div([h.Class("product-cell")], [h.dt([], ["Affected"]), h.dd([], [prod.affected])]),
          h.div([h.Class("product-cell")], [h.dt([], ["Since"]), h.dd([], [prod.since])]),
          h.div([h.Class("product-cell")], [h.dt([], ["Status"]), h.dd([], [prod.status])]),
        ],
      ),
      h.div(
        [h.Class("next-check-row")],
        [h.span([h.Class("next-check-label")], ["Next check"]), h.span([h.Class("next-check-text")], [eng.nextCheck])],
      ),
      ...(eng.evidence.length > 0
        ? [
            h.div(
              [h.Class("citations-block")],
              [
                h.h4([h.Class("sub-heading")], ["Citations"]),
                h.ul(
                  [h.Class("citation-list")],
                  eng.evidence.map((ev) =>
                    h.li(
                      [h.Class(ev.verified ? "citation verified" : "citation unverified")],
                      [
                        h.div(
                          [h.Class("citation-head")],
                          [
                            h.span(
                              [h.Class(ev.verified ? "citation-status verified" : "citation-status unverified")],
                              [
                                ev.verified ? iconVerified(h) : iconUnverified(h),
                                h.span([], [ev.verified ? "Verified by code" : "Unverifiable"]),
                              ],
                            ),
                            h.code([h.Class("citation-source")], [ev.source]),
                          ],
                        ),
                        h.blockquote([h.Class("citation-quote")], [ev.quote]),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ]
        : []),
      ...(finding.ruledOut.length > 0 || eng.notChecked.length > 0
        ? [
            h.div(
              [h.Class("finding-notes-grid")],
              [
                ...(finding.ruledOut.length > 0
                  ? [
                      h.div(
                        [h.Class("note-column")],
                        [
                          h.h4([h.Class("sub-heading")], ["Ruled out"]),
                          h.ul(
                            [h.Class("note-list")],
                            finding.ruledOut.map((item) => h.li([], [item])),
                          ),
                        ],
                      ),
                    ]
                  : []),
                ...(eng.notChecked.length > 0
                  ? [
                      h.div(
                        [h.Class("note-column not-checked")],
                        [
                          h.h4([h.Class("sub-heading")], ["Not checked"]),
                          h.ul(
                            [h.Class("note-list")],
                            eng.notChecked.map((item) => h.li([], [item])),
                          ),
                        ],
                      ),
                    ]
                  : []),
              ],
            ),
          ]
        : []),
    ],
  );
}

function threadSectionView(thread: ThreadPageState | null, opencodeConnected: boolean | null, h: H): Html {
  return h.section(
    [h.Class("detail-section")],
    [
      h.div(
        [h.Class("section-header-row")],
        [
          h.h3([h.Class("section-heading")], ["Thread"]),
          h.span([h.Class("section-count")], [String(thread?.prompts.length ?? 0)]),
          ...(thread && thread.sessions.length > 0
            ? [
                h.div(
                  [h.Class("sessions-inline")],
                  thread.sessions.map((s) =>
                    h.span(
                      [h.Class(`session-item session-${s.status}`), h.Title(`${s.sessionId} (${s.mode}, ${s.status})`)],
                      [
                        s.status === "running"
                          ? iconPromptStatus(h, "sent")
                          : s.status === "failed"
                            ? iconPromptStatus(h, "failed")
                            : s.status === "idle"
                              ? iconVerified(h)
                              : iconPromptStatus(h, "queued"),
                        h.code([], [shortId(s.sessionId)]),
                        h.span([h.Class("session-status-word")], [s.status]),
                      ],
                    ),
                  ),
                ),
              ]
            : []),
        ],
      ),
      ...(thread?.handoff
        ? [
            h.div(
              [h.Class("handoff-box")],
              [
                h.div(
                  [h.Class("handoff-head")],
                  [
                    h.span([h.Class("handoff-title")], ["Latest handoff for fresh sessions"]),
                    h.time([h.Class("mono-time"), h.Title(utcStamp(thread.handoff.at))], [relativeAge(thread.handoff.at)]),
                  ],
                ),
                h.p([h.Class("handoff-concluded")], [thread.handoff.concluded]),
                ...(thread.handoff.ruledOut.length > 0
                  ? [h.p([h.Class("handoff-detail")], [h.strong([], ["Ruled out: "]), thread.handoff.ruledOut.join("; ")])]
                  : []),
                ...(thread.handoff.open.length > 0
                  ? [h.p([h.Class("handoff-detail")], [h.strong([], ["Still open: "]), thread.handoff.open.join("; ")])]
                  : []),
              ],
            ),
          ]
        : []),
      !thread || thread.prompts.length === 0
        ? h.p([h.Class("section-empty")], ["No prompts on this thread yet. Use the prompt bar below to ask an agent."])
        : h.ol(
            [h.Class("prompt-list")],
            thread.prompts.map((p) =>
              h.li(
                [h.Class(`prompt-entry status-${p.status}`)],
                [
                  h.div(
                    [h.Class("prompt-entry-head")],
                    [
                      h.span([h.Class(`status-cell status-${p.status}`)], [iconPromptStatus(h, p.status), h.span([], [promptStatusLabel(p.status)])]),
                      h.span([h.Class("prompt-origin")], [p.origin === "opencode" ? "from OpenCode" : p.origin === "system" ? "automatic triage" : "from page"]),
                      h.span([h.Class("meta-sep"), h.AriaHidden(true)], ["·"]),
                      h.code([h.Class("mono-id")], [shortId(p.sessionId)]),
                      h.time([h.Class("prompt-time"), h.Title(utcStamp(p.at))], [relativeAge(p.at)]),
                    ],
                  ),
                  h.p([h.Class("prompt-entry-text")], [p.text]),
                  h.div(
                    [h.Class("prompt-entry-route")],
                    [
                      h.span([], [p.reason]),
                      ...(p.status === "queued" && opencodeConnected === false
                        ? [h.span([h.Class("queued-offline-note")], ["Waiting for OpenCode to connect"])]
                        : []),
                    ],
                  ),
                  ...(p.failure
                    ? [h.div([h.Class("prompt-failure")], [iconPromptStatus(h, "failed"), h.span([], [p.failure])])]
                    : []),
                ],
              ),
            ),
          ),
    ],
  );
}

function timelineSectionView(page: IncidentPageState, h: H): Html {
  const entries = [...page.timeline].reverse();
  return h.section(
    [h.Class("detail-section")],
    [
      h.div(
        [h.Class("section-header-row")],
        [
          h.h3([h.Class("section-heading")], ["Timeline"]),
          h.span([h.Class("section-count")], [String(page.timeline.length)]),
        ],
      ),
      h.ol(
        [h.Class("timeline-list")],
        entries.map((entry) =>
          h.li(
            [h.Class(`timeline-entry kind-${entry.kind}`)],
            [
              h.span([h.Class("timeline-dot"), h.AriaHidden(true)], []),
              h.time([h.Class("timeline-time"), h.Title(utcStamp(entry.at))], [utcStamp(entry.at)]),
              h.span([h.Class("timeline-kind")], [entry.kind]),
              h.span([h.Class("timeline-text")], [entry.text]),
            ],
          ),
        ),
      ),
    ],
  );
}

function promptBarView(model: Model, h: H, routePreview: string): Html {
  const archived = model.page?.disposition === "archived";
  const disabled = !model.focus || archived;
  const focusedItem = model.page ?? model.inbox.find((i) => i.incidentId === model.focus) ?? null;
  const ocOffline = model.status !== null && !model.status.opencode.connected;

  const overrideOption = (value: Override, label: string, title: string): Html =>
    h.button(
      [
        h.Class(model.override === value ? "seg-option active" : "seg-option"),
        h.Type("button"),
        h.Role("radio"),
        h.AriaChecked(model.override === value),
        h.Disabled(disabled),
        h.Title(title),
        h.OnClick(Message.ChangedOverride({ override: value })),
      ],
      [label],
    );

  return h.form(
    [h.Class(`prompt-dock${model.focus ? " locked" : ""}`), h.OnSubmit(Message.SubmittedPrompt())],
    [
      h.div(
        [h.Class("prompt-context-strip")],
        [
          h.div(
            [h.Class("focus-chip")],
            focusedItem
              ? [
                  iconReticle(h),
                  h.span([h.Class("focus-chip-env")], [`${focusedItem.app}/${focusedItem.environment}`]),
                  h.span([h.Class("focus-chip-title")], [focusedItem.title]),
                ]
              : [iconReticle(h), h.span([h.Class("focus-chip-none")], ["No focus selected"])],
          ),
          h.div(
            [h.Class("route-preview")],
            [
              h.span([h.Class("route-text")], [routePreview]),
              ...(ocOffline && !disabled ? [h.span([h.Class("route-offline")], ["OpenCode offline (will queue)"])] : []),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("prompt-input-row")],
        [
          h.label([h.Class("sr-only"), h.For("prompt-input")], ["Prompt about the incident in focus"]),
          h.input([
            h.Id("prompt-input"),
            h.Class("prompt-input"),
            h.Type("text"),
            h.Placeholder(
              archived
                ? "Archived thread is closed"
                : model.focus
                  ? "Ask about this incident (e.g. compare with staging, check recent deploys, draft next step)..."
                  : "Select an incident first to lock it in focus",
            ),
            h.Value(draftOf(model)),
            h.OnInput((text) => Message.ChangedDraft({ text })),
            h.Disabled(disabled),
            h.Autocomplete("off"),
          ]),
          h.div(
            [h.Class("segmented session-selector"), h.Role("radiogroup"), h.AriaLabel("Session routing override")],
            [
              overrideOption("auto", "Auto", "Let Overwatch decide: continue idle session, queue behind running, or start fresh"),
              overrideOption("new", "New", "Start a new session from the thread handoff"),
              overrideOption("here", "Here", "Send to the latest session on this thread"),
            ],
          ),
          h.button(
            [h.Class("send-btn"), h.Type("submit"), h.Disabled(disabled || isSending(model) || !draftOf(model).trim())],
            [h.span([], ["Send"]), iconSend(h)],
          ),
        ],
      ),
    ],
  );
}

function searchModalView(model: Model, h: H): Html {
  return h.div(
    [h.Class("overlay-backdrop"), h.OnClick(Message.ClosedOverlays())],
    [
      h.div(
        [
          h.Class("search-palette"),
          h.Role("dialog"),
          h.AriaModal(true),
          h.AriaLabel("Search Overwatch"),
          h.OnClick(Message.CompletedDomEffect(), { propagation: "Stop" }),
        ],
        [
          h.div(
            [h.Class("palette-input-row")],
            [
              iconSearch(h),
              h.label([h.Class("sr-only"), h.For("search-input")], ["Search incidents, findings, prompts, and threads"]),
              h.input([
                h.Id("search-input"),
                h.Class("palette-input"),
                h.Type("search"),
                h.Placeholder("Search incidents, findings, archived items, or exact ID..."),
                h.Value(model.searchQuery),
                h.OnInput((query) => Message.ChangedSearchQuery({ query })),
                h.Autocomplete("off"),
              ]),
              h.kbd([h.Class("kbd")], ["Esc"]),
            ],
          ),
          h.div(
            [h.Class("palette-body")],
            [
              model.searchError
                ? h.p([h.Class("palette-state error")], [model.searchError])
                : model.searchLoading
                  ? h.p([h.Class("palette-state")], ["Searching event log..."])
                  : !model.searchQuery.trim()
                    ? h.p([h.Class("palette-state")], ["Type keywords (like stripe, oom, archived, jwks) or an incident ID. Archived incidents are included."])
                    : model.searchHits.length === 0
                      ? h.p([h.Class("palette-state")], [`No matches for "${model.searchQuery.trim()}".`])
                      : h.ul(
                          [h.Class("palette-results"), h.Role("listbox")],
                          model.searchHits.map((hit, idx) => searchHitView(hit, idx === model.searchSelected, h)),
                        ),
            ],
          ),
          h.div(
            [h.Class("palette-footer")],
            [
              h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["↑ / ↓"]), " navigate"]),
              h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["Enter"]), " focus incident"]),
              h.span([h.Class("hint-item")], [h.kbd([h.Class("kbd")], ["Esc"]), " close"]),
            ],
          ),
        ],
      ),
    ],
  );
}

function searchHitView(hit: SearchHit, selected: boolean, h: H): Html {
  return h.li(
    [
      h.Class(selected ? "palette-hit selected" : "palette-hit"),
      h.Role("option"),
      h.AriaSelected(selected),
      h.OnClick(Message.SelectedSearchHit({ hit })),
    ],
    [
      h.div(
        [h.Class("hit-top")],
        [
          h.span([h.Class(`hit-kind kind-${hit.kind}`)], [hit.kind]),
          h.span([h.Class("hit-title")], [hit.title]),
          ...(hit.state ? [h.span([h.Class(`hit-state state-${hit.state}`)], [hit.state])] : []),
        ],
      ),
      h.div(
        [h.Class("hit-meta")],
        [
          ...(hit.app && hit.environment ? [h.span([], [`${hit.app} / ${hit.environment}`]), h.span([h.Class("meta-sep")], ["·"])] : []),
          h.code([h.Class("mono-id")], [hit.id]),
          h.span([h.Class("meta-sep")], ["·"]),
          h.time([h.Title(utcStamp(hit.at))], [relativeAge(hit.at)]),
        ],
      ),
      ...(hit.snippet ? [h.p([h.Class("hit-snippet")], [hit.snippet])] : []),
    ],
  );
}

function statusDrawerView(model: Model, h: H): Html {
  const st = model.status;
  return h.div(
    [h.Class("overlay-backdrop"), h.OnClick(Message.ClosedOverlays())],
    [
      h.div(
        [
          h.Class("status-sheet"),
          h.Role("dialog"),
          h.AriaModal(true),
          h.AriaLabel("Service and OpenCode status"),
          h.OnClick(Message.CompletedDomEffect(), { propagation: "Stop" }),
        ],
        [
          h.div(
            [h.Class("sheet-head")],
            [
              h.h2([h.Class("sheet-title")], ["Service & OpenCode status"]),
              h.button(
                [h.Class("icon-btn"), h.Type("button"), h.OnClick(Message.ClosedOverlays()), h.AriaLabel("Close status")],
                [iconClose(h)],
              ),
            ],
          ),
          model.statusError
            ? h.div([h.Class("sheet-alert error")], [iconOffline(h), h.span([], [`Could not read /status: ${model.statusError}`])])
            : !st
              ? h.p([h.Class("section-empty")], ["Loading service status..."])
              : h.div(
                  [h.Class("sheet-body")],
                  [
                    ...(st.configErrors.length > 0
                      ? [
                          h.div(
                            [h.Class("sheet-alert error")],
                            [iconSeverity(h, "error"), h.div([], [h.strong([], ["Configuration errors"]), ...st.configErrors.map((e) => h.p([], [e]))])],
                          ),
                        ]
                      : []),
                    h.section(
                      [h.Class("sheet-section")],
                      [
                        h.h3([h.Class("sub-heading")], ["OpenCode"]),
                        h.div(
                          [h.Class(`oc-summary ${st.opencode.connected ? "connected" : "disconnected"}`)],
                          [
                            st.opencode.connected ? iconVerified(h) : iconOffline(h),
                            h.div(
                              [],
                              [
                                h.p([h.Class("oc-state-title")], [st.opencode.connected ? "Connected" : "Not connected"]),
                                h.p(
                                  [h.Class("oc-state-detail")],
                                  [
                                    st.opencode.connected
                                      ? st.opencode.url ?? "Local OpenCode server"
                                      : "Polling, inbox, archive, and search keep working. Prompts queue until OpenCode starts.",
                                  ],
                                ),
                              ],
                            ),
                          ],
                        ),
                        h.dl(
                          [h.Class("sheet-metrics")],
                          [
                            h.div([h.Class("fact")], [h.dt([], ["Waiting runs"]), h.dd([], [String(st.opencode.waitingRuns)])]),
                            h.div([h.Class("fact")], [h.dt([], ["Running runs"]), h.dd([], [String(st.opencode.runningRuns)])]),
                            h.div([h.Class("fact")], [h.dt([], ["Service version"]), h.dd([h.Class("mono")], [`v${st.version} (API ${st.apiVersion})`])]),
                          ],
                        ),
                      ],
                    ),
                    h.section(
                      [h.Class("sheet-section")],
                      [
                        h.h3([h.Class("sub-heading")], [`Watchers (${st.watchers.length})`]),
                        st.watchers.length === 0
                          ? h.p([h.Class("section-empty")], ["No watchers configured."])
                          : h.ul(
                              [h.Class("watcher-list")],
                              st.watchers.map((w) => {
                                const state = w.last_error ? "error" : w.last_finished === null ? "unknown" : "ok";
                                return h.li(
                                  [h.Class(`watcher-row state-${state}`)],
                                  [
                                    h.div(
                                      [h.Class("watcher-main")],
                                      [
                                        state === "error"
                                          ? iconSeverity(h, "error")
                                          : state === "unknown"
                                            ? iconUnverified(h)
                                            : iconVerified(h),
                                        h.span([h.Class("watcher-name")], [w.watcher]),
                                        h.span([h.Class("watcher-state-label")], [state === "error" ? "Failing" : state === "unknown" ? "Not checked yet" : "Checked"]),
                                      ],
                                    ),
                                    h.div(
                                      [h.Class("watcher-meta")],
                                      [
                                        w.last_error
                                          ? h.span([h.Class("watcher-error")], [w.last_error])
                                          : h.span([], [w.last_finished ? `Last checked ${relativeAge(w.last_finished)}` : "Awaiting first poll"]),
                                      ],
                                    ),
                                  ],
                                );
                              }),
                            ),
                      ],
                    ),
                  ],
                ),
        ],
      ),
    ],
  );
}

function shortcutsModalView(h: H): Html {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["j / ↓", "Focus next incident in inbox"],
    ["k / ↑", "Focus previous incident in inbox"],
    ["p / Enter", "Jump into the prompt bar for the focused incident"],
    ["a / e", "Archive focused incident"],
    ["/ or ⌘K", "Search incidents, findings, prompts, and archived threads"],
    ["1 / 2 / 3", "Filter inbox: All / Prod / Pre-prod"],
    ["t", "Toggle Night Watch / Daylight Chart theme"],
    ["?", "Toggle this keyboard reference"],
    ["Esc", "Close dialog or leave prompt input"],
  ];

  return h.div(
    [h.Class("overlay-backdrop"), h.OnClick(Message.ClosedOverlays())],
    [
      h.div(
        [
          h.Class("shortcuts-sheet"),
          h.Role("dialog"),
          h.AriaModal(true),
          h.AriaLabel("Keyboard shortcuts"),
          h.OnClick(Message.CompletedDomEffect(), { propagation: "Stop" }),
        ],
        [
          h.div(
            [h.Class("sheet-head")],
            [
              h.h2([h.Class("sheet-title")], ["Keyboard shortcuts"]),
              h.button(
                [h.Class("icon-btn"), h.Type("button"), h.OnClick(Message.ClosedOverlays()), h.AriaLabel("Close shortcuts")],
                [iconClose(h)],
              ),
            ],
          ),
          h.dl(
            [h.Class("shortcuts-list")],
            rows.map(([keys, desc]) =>
              h.div([h.Class("shortcut-row")], [h.dt([], [h.kbd([h.Class("kbd")], [keys])]), h.dd([], [desc])]),
            ),
          ),
        ],
      ),
    ],
  );
}
