/**
 * The page: renders what the service decided and sends the owner's commands. It keeps its own clock for staleness
 * (a one-second timer comparing wall and monotonic time with the last time it heard the service), freezes row
 * positions while the owner looks, and never generates identifiers or decides groups.
 */
import { freshness, silence } from "./freshness.mjs";
import * as m from "./model.mjs";

const $ = (s, root = document) => root.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sample = () => ({ wallMs: Date.now(), monoMs: performance.now() });

const remembered = (() => {
  try {
    return JSON.parse(localStorage.getItem("ow-groups") ?? "null");
  } catch {
    return null;
  }
})();

const state = {
  snap: null,
  last: null,
  /** The service's clock as last stated (a snapshot or heartbeat), against the page's monotonic clock. */
  anchor: null,
  connection: "unknown",
  shown: null,
  collapsed: { needsYou: false, new: false, working: true, quiet: true, ...(remembered && typeof remembered === "object" ? remembered : {}) },
  sending: false,
  seenTimer: 0,
  detailSeq: 0,
  sheetBasis: null,
  results: null,
  focus: null,
  detail: null,
  actions: [],
  overlay: null,
  key: null,
  statusPending: false,
};

// ---------------------------------------------------------------- talking to the service

async function call(path, body, headers = {}) {
  const r = await fetch("/v2/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(value?.error?.message ?? `HTTP ${r.status}`), { status: r.status });
  return value;
}

/** A snapshot newer than the one shown replaces it; an older one is ignored. */
function apply(snap) {
  if (state.snap && snap.seq < state.snap.seq) return;
  state.snap = snap;
  if (!state.anchor || snap.atMs >= state.anchor.atMs) state.anchor = { atMs: snap.atMs, monoMs: performance.now() };
  if (!state.shown) state.shown = m.freeze(snap.inbox);
  render();
  // Anything committed since the open detail was read may belong to it (a question, a finding, a return).
  if (isIncident(state.focus) && snap.seq > state.detailSeq) loadDetail(state.focus);
}

function heard(e) {
  state.last = sample();
  try {
    const at = JSON.parse(e?.data ?? "null")?.atMs;
    if (typeof at === "number" && (!state.anchor || at >= state.anchor.atMs)) state.anchor = { atMs: at, monoMs: performance.now() };
  } catch {
    // A heartbeat without a time still says the service is there.
  }
  tick();
}

function connect() {
  const stream = new EventSource("/v2/changes");
  const onSnap = (e) => {
    state.last = sample();
    apply(JSON.parse(e.data));
    tick();
  };
  stream.addEventListener("snapshot", onSnap);
  stream.addEventListener("change", onSnap);
  stream.addEventListener("heartbeat", heard);
  stream.onerror = () => {
    // Ask for status once while the stream is away; its answer updates data only, never liveness.
    if (!state.statusPending) {
      state.statusPending = true;
      call("status").then(apply, () => undefined).finally(() => (state.statusPending = false));
    }
    if (stream.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  };
}

/** The page's own clock: once a second, whatever any request is doing. */
function tick() {
  const next = freshness(state.last, sample());
  if (next !== state.connection) {
    state.connection = next;
    render();
  } else {
    renderConnection();
    renderStrip(); // measurements age on this clock too, whatever the transport says
  }
}

const serverNow = () => m.serverNow(state.anchor, performance.now());

// ---------------------------------------------------------------- lookups

const incident = (id) => state.snap?.incidents.find((i) => i.id === id);
const rows = () => (state.shown ? m.order(state.shown, state.collapsed) : []);
const down = () => state.connection === "down";
const isIncident = (s) => s && !s.startsWith("env:") && !s.startsWith("src:");

// ---------------------------------------------------------------- rendering

function render() {
  renderConnection();
  renderBanners();
  renderStrip();
  renderGroups();
  renderStage();
  renderDock();
}

function renderConnection() {
  const el = $(".connection");
  const quiet = silence(state.last, sample());
  el.dataset.connection = state.connection;
  const s = Math.round(quiet / 1000);
  el.querySelector(".connection-text").textContent =
    state.connection === "live" ? "Live" : state.connection === "stale" ? `Stale · ${s}s` : state.connection === "down" ? "Not answering" : "Connecting…";
  document.body.dataset.link = state.connection;
  const banner = $("[data-age]");
  if (banner) banner.textContent = `${s}s ago`;
}

function renderBanners() {
  const out = [];
  if (state.connection === "stale") {
    out.push(`<div class="banner stale" role="status"><b>Stale</b><span>Last heard <span data-age>${Math.round(silence(state.last, sample()) / 1000)}s ago</span>. Health unknown until the service answers again.</span></div>`);
  }
  if (state.connection === "down") {
    out.push(`<div class="banner down" role="alert"><b>Service not answering</b><span>Last heard <span data-age></span>. Actions are off; your draft is kept. Start it again with</span><code>bin/overwatch serve</code></div>`);
  }
  const s = state.snap;
  if (s?.paused === "disk") out.push(`<div class="banner paused" role="status"><b>Collection paused for disk space</b><span>${esc(s.pausedFix)}</span></div>`);
  for (const c of s?.causes ?? []) {
    out.push(`<div class="banner cause ${esc(c.kind)}"><b>${esc(causeTitle(c))}</b><span>${esc(c.sources.join(", "))}</span>${c.fix ? `<code>${esc(c.fix)}</code>` : ""}</div>`);
  }
  $("[data-banners]").innerHTML = out.join("");
  renderConnection();
}

const causeTitle = (c) => ({ signin: "Signed out", permission: "Permission refused", rate: "Rate limited", unreachable: "Unreachable", config: "Configuration", offline: "Offline" })[c.kind] ?? c.kind;

const GLYPH = {
  quiet: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l2 2 3.8-4"/></svg>',
  attention: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z"/><path d="M8 5v3.6M8 10.6v.4"/></svg>',
  partial: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke-dasharray="3 2.2"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" class="fill"/></svg>',
  stale: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke-dasharray="2 2"/><path d="M8 4.6V8l2.4 1.6"/></svg>',
  signed_out: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M3.6 12.4l8.8-8.8"/></svg>',
  unknown: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke-dasharray="2 2"/><path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1M8 11v.3"/></svg>',
};

function renderStrip() {
  const s = state.snap;
  const strip = $("[data-strip]");
  if (!s) {
    strip.innerHTML = `<div class="strip-empty">Waiting for the first snapshot…</div>`;
    return;
  }
  strip.innerHTML = s.environments
    .map((e) => {
      const h = m.cellHealth(e, state.connection, serverNow());
      const errors = s.incidents.filter((i) => i.app === e.app && i.environment === e.environment && i.active && i.severity === "error").length;
      const detail = h === "attention" ? `${errors} active error${errors === 1 ? "" : "s"}` : h === "unknown" ? "until the service answers" : h === "signed_out" ? "sign in again" : h === "stale" ? "readings are old" : h === "partial" ? "not every reading" : "every reading fresh";
      const { left, signal } = ahead(e);
      return `<button type="button" class="env ${h}${state.focus === e.subject ? " focused" : ""}" data-env="${esc(e.environment)}" data-app="${esc(e.app)}" data-health="${h}" data-subject="${esc(e.subject)}">
        <span class="glyph">${GLYPH[h] ?? GLYPH.unknown}</span>
        <span class="env-name"><b>${esc(e.environment)}</b><span>${esc(e.app)}</span></span>
        <span class="env-state"><b>${esc(m.HEALTH_LABEL[h])}</b><span>${esc(detail)}</span>${left ? `<span class="ahead" title="${esc(left.long)}">${esc(left.short)}</span>` : ""}${signal?.state === "regression" ? `<span class="ahead warn">new problem in staging</span>` : ""}</span>
      </button>`;
    })
    .join("");
}

/** What lies ahead for an environment: time left on its capacity sources, and its staging comparison. */
function ahead(e) {
  const o = state.snap.outlook ?? { forecasts: [], comparisons: [] }, now = serverNow() ?? state.snap.atMs;
  const forecasts = o.forecasts.filter((f) => f.source.startsWith(`${e.app}/${e.environment}/`));
  return { forecasts, left: forecasts.map((f) => m.timeLeft(f, now)).find(Boolean) ?? null, signal: o.comparisons.find((c) => c.app === e.app && c.staging === e.environment) ?? null };
}
function outlookPanels(e) {
  const { forecasts, signal } = ahead(e), now = serverNow() ?? state.snap.atMs;
  const lines = forecasts.map((f) => { const t = m.timeLeft(f, now); return `<li class="${t ? "breach" : ""}"><span>${esc(f.source)} · ${esc(f.resource)}</span><b>${t ? esc(t.short) : "no estimate"}</b><em>${esc(t ? t.long : f.reason ?? "")}</em></li>`; }).join("");
  return `${lines ? `<section class="panel"><h3>Time left</h3><ul class="gauges">${lines}</ul></section>` : ""}${signal ? `<section class="panel"><h3>Staging against production</h3><p class="note${signal.state === "regression" ? " warn" : ""}">${esc(m.comparisonText(signal))}</p></section>` : ""}`;
}

/** A fix attempt: its state, the one rule that stopped it or why it is eligible, the change, its verification, the draft. */
function fixPanel(i, d) {
  const list = [...(d?.fixes ?? [])].reverse();
  if (!list.length) return d?.fixable && (d?.investigations ?? []).some((x) => x.result?.verdict === "real") ? `<section class="panel fixes"><h3>Fix</h3><p class="note">No proposal yet. <kbd>f</kbd> asks for one: it is made only when every rule holds.</p></section>` : "";
  const diff = (text) => text.split("\n").slice(0, 60).map((l) => (l.startsWith("+") && !l.startsWith("+++") ? `<ins>${esc(l)}</ins>` : l.startsWith("-") && !l.startsWith("---") ? `<del>${esc(l)}</del>` : esc(l))).join("\n");
  return `<section class="panel fixes"><h3>Fix proposal</h3>${list.map((f, n) => `<article class="fix ${m.fixTone(f.state)}" data-fix="${esc(f.id)}">
    <header><b>${esc(m.FIX_LABEL[f.state] ?? f.state)}</b>${f.pr ? `<a href="${esc(f.pr.url)}" target="_blank" rel="noopener">#${f.pr.number}${f.pr.draft ? " · draft" : ""} · ${esc(String(f.pr.state).toLowerCase())}</a>` : ""}${m.fixTone(f.state) === "working" ? `<button type="button" data-decline="${esc(f.id)}">Decline</button>` : ""}</header>
    ${f.reason ? `<p class="note">${esc(f.reason)}</p>` : ""}
    ${n === 0 && f.diff ? `<p class="eligible">Eligible: three of three readings said real, the challenger upheld it, it was observed in telemetry, and it began strictly after the rollout of <code>${esc(String(f.deployed).slice(0, 12))}</code> (previously <code>${esc(String(f.previous).slice(0, 12))}</code>). A model selected this change; Overwatch derived it from Git and checked it.</p>
      <pre class="diff">${diff(f.diff)}</pre>` : ""}
    ${f.verification.length ? `<ul class="verification">${f.verification.map((v) => `<li class="${v.exitCode === 0 ? "ok" : "failed"}"><code>${esc(v.argv.join(" "))}</code><span>${v.exitCode === null ? "did not finish" : `exit ${v.exitCode}`} · ${v.elapsedMs} ms</span></li>`).join("")}</ul>` : ""}
    ${f.state === "draft" ? `<p class="note">To decline, close the pull request; the problem stays open and this finding is not proposed again.</p>` : ""}
  </article>`).join("")}</section>`;
}

function spark(values, w = 72, h = 18) {
  const max = Math.max(1, ...values);
  const bw = w / values.length;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${values
    .map((v, i) => (v ? `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - Math.max(1.5, (v / max) * h)).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(1.5, (v / max) * h).toFixed(1)}" rx="0.8"/>` : `<rect class="zero" x="${(i * bw + 0.5).toFixed(1)}" y="${h - 1}" width="${(bw - 1).toFixed(1)}" height="1"/>`))
    .join("")}</svg>`;
}

const SEVERITY_GLYPH = {
  error: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.2 6.2L8 14.2 1.8 8z"/><path d="M8 5v3.6M8 10.6v.4"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.3v3.2M8 11.4v.3"/></svg>',
  info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 7.2V11M8 5v.3"/></svg>',
};

function row(id) {
  const i = incident(id);
  if (!i) return "";
  const now = state.snap.atMs;
  const unseen = i.lastSeq > i.seenSeq && i.group !== "quiet";
  const why = i.returned && !i.way ? `<div class="why back">${esc(i.returned.reason)}</div>` : i.group === "working" ? `<div class="why working"><span class="orbit" aria-hidden="true"></span>Queued for an agent</div>` : i.group === "quiet" ? `<div class="why quiet">Quiet: nothing new for three checked intervals</div>` : "";
  const left = !(state.snap.inbox.groups[i.group ?? ""] ?? []).includes(id);
  return `<div class="row sev-${esc(i.severity)}${state.focus === id ? " focused" : ""}${unseen ? " unseen" : ""}${left ? " left" : ""}" data-item-id="${esc(id)}" role="option" aria-selected="${state.focus === id}">
    <span class="sev" title="${esc(i.severity)}">${SEVERITY_GLYPH[i.severity] ?? ""}</span>
    <div class="row-body">
      <div class="title">${esc(i.title)}</div>
      <div class="meta"><span class="place">${esc(i.app)} / ${esc(i.environment)}</span><span class="count${i.exact ? "" : " bound"}" title="${i.exact ? "exact" : "at least: part of the time was not fully read"}">${m.countText(i.count, i.exact)}</span><span>${m.ago(i.lastMs, now)}</span></div>
      ${why}
    </div>
    ${spark(i.spark)}
  </div>`;
}

function renderGroups() {
  const el = $("[data-groups]");
  const s = state.snap;
  if (!s) {
    el.innerHTML = `<div class="loading"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>`;
    return;
  }
  const pending = m.pendingLabel(m.staged(state.shown, s.inbox));
  const pend = $("[data-pending]");
  pend.dataset.pendingCount = String(pending.count);
  pend.hidden = pending.count === 0;
  pend.classList.toggle("moves", !pending.attention);
  pend.innerHTML = `${esc(pending.text)} <kbd>r</kbd>`;
  const total = m.GROUPS.reduce((n, g) => n + state.shown[g].length, 0);
  if (total === 0) {
    el.innerHTML = `<div class="empty-inbox"><svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18"/><path d="M16 24.5l5.5 5.5L32.5 19"/></svg><b>Nothing needs you</b><span>New problems appear here as they are counted. The strip above says what was checked.</span></div>`;
    return;
  }
  el.innerHTML = m.GROUPS.map((g) => {
    const ids = state.shown[g];
    const collapsed = state.collapsed[g];
    return `<section class="group ${g}" data-group="${g}">
      <button type="button" class="group-head" data-toggle="${g}" aria-expanded="${!collapsed}">
        <span class="caret" aria-hidden="true"></span><span class="group-name">${m.GROUP_LABEL[g]}</span><span class="group-count">${ids.length}</span>
      </button>
      <div class="group-rows"${collapsed ? " hidden" : ""}>${ids.length ? ids.map(row).join("") : `<div class="group-empty">${g === "needsYou" ? "No production error waits for you" : g === "working" ? "No agent work queued" : g === "quiet" ? "Nothing has gone quiet" : "Nothing new"}</div>`}</div>
    </section>`;
  }).join("");
}

function renderStage() {
  const stage = $("[data-stage]");
  const f = state.focus;
  if (!f) {
    stage.removeAttribute("data-focus-id");
    stage.innerHTML = state.snap ? overview() : "";
    return;
  }
  stage.dataset.focusId = f;
  if (f.startsWith("env:")) return void (stage.innerHTML = back + environmentView(f));
  if (f.startsWith("src:")) return void (stage.innerHTML = back + sourceView(f));
  const d = state.detail?.incident?.id === f ? state.detail : null;
  const i = incident(f) ?? d?.incident;
  if (!i) return void (stage.innerHTML = `<div class="stage-empty"><b>Loading…</b></div>`);
  stage.innerHTML = back + incidentView(i, d);
}

const back = `<button type="button" class="stage-back" data-back>← Inbox</button>`;

function overview() {
  const s = state.snap;
  const g = s.inbox.groups;
  const n = g.needsYou.length;
  return `<div class="overview">
    <img src="logo.svg" alt="" width="56" height="56">
    <h2>${n ? `${n} ${n === 1 ? "problem needs" : "problems need"} you` : "Nothing needs you"}</h2>
    <p>${g.new.length} new · ${g.working.length} with an agent · ${g.quiet.length} quiet. Put anything in focus with <kbd>j</kbd> or a click, then ask about it below.</p>
    <dl class="keys">
      <div><dt><kbd>j</kbd><kbd>k</kbd></dt><dd>Move through the inbox</dd></div>
      <div><dt><kbd>d</kbd></dt><dd>Done: back if it happens again</dd></div>
      <div><dt><kbd>l</kbd></dt><dd>Later: until something changes</dd></div>
      <div><dt><kbd>n</kbd></dt><dd>Never: only if it gets much worse</dd></div>
      <div><dt><kbd>/</kbd></dt><dd>Find anything, even put away</dd></div>
      <div><dt><kbd>p</kbd></dt><dd>Ask about what is in focus</dd></div>
    </dl>
  </div>`;
}

const WAY_LABEL = { done: "Done", later: "Later", never: "Never" };

const VERDICT = { real: "Real", not_real: "Not real", unsure: "Unsure" };
const piecesHtml = (pieces) => (pieces ?? []).map((p) => `<figure class="evidence"><figcaption><button type="button" class="handle" data-handle="${esc(p.handle)}" title="${esc(p.handle)} · click to copy">${esc(m.shortHandle(p.handle))}</button><span>${esc(p.source)}</span></figcaption><pre>${esc(p.text)}</pre></figure>`).join("");

/** The latest investigation: the verdict, how the readings voted, what the challenger did; disagreement shows. */
function verdictPanel(d) {
  const inv = (d?.investigations ?? []).at(-1);
  if (!inv || (!inv.result && inv.state !== "queued" && inv.state !== "running")) return "";
  if (!inv.result) return `<section class="verdict working"><span class="orbit" aria-hidden="true"></span><div><b>Investigating</b><span>${inv.state === "queued" ? "queued for the next free agent" : "independent readings under way"}</span></div></section>`;
  const v = m.verdictView(inv.result), r = inv.result;
  const readings = r.readings.map((x) => {
    const f = (d.findings ?? []).find((g) => g.id === x.findingId);
    return `<li class="reading ${esc(x.verdict ?? "missing")}"><span class="slot">${x.slot}</span><b>${esc(x.verdict ? VERDICT[x.verdict] : "No filing")}</b><span>${esc(f?.body?.cause ?? x.reason ?? "")}</span></li>`;
  }).join("");
  return `<section class="verdict ${v.tone}" data-verdict="${esc(r.verdict)}" data-tone="${v.tone}">
    <header><span class="verdict-label">${esc(v.label)}</span><span class="verdict-label votes">${esc(v.votes)}</span>${v.challenge ? `<span class="challenge-word">${esc(v.challenge)}</span>` : ""}${v.evidence ? `<span class="pill ${v.observed ? "observed" : "unobserved"}">${esc(v.evidence)}</span>` : ""}</header>
    ${v.tone === "undecided" ? `<p class="note">The readings could not settle it. It stays with you; look at what each one saw.</p>` : v.tone === "disagreed" ? `<p class="note">Not unanimous: the dissent is below, as filed.</p>` : ""}
    <ol class="readings">${readings}</ol>
    ${r.challenge ? `<div class="challenge"><b>Challenger: ${esc(r.challenge.outcome ?? "did not file")}</b><p>${esc(r.challenge.reason ?? "")}</p>${piecesHtml(r.challenge.pieces)}</div>` : ""}
  </section>`;
}

/** The claims behind the verdict, each with the evidence it cites, readable in place; what was ruled out and not checked. */
function claimsPanel(d) {
  const inv = (d?.investigations ?? []).filter((x) => x.result).at(-1)?.result;
  // Without an adjudicated investigation, every finding filed on it is shown as filed.
  const ids = inv ? new Set(inv.readings.filter((x) => x.verdict === inv.verdict || inv.verdict === "unsure").map((x) => x.findingId).filter(Boolean)) : null;
  const findings = (d?.findings ?? []).filter((f) => (!ids || ids.has(f.id)) && !f.body?.challenge);
  if (!findings.length) return "";
  const list = (title, items) => (items?.length ? `<div class="aside"><h4>${title}</h4><ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : "");
  return `<section class="panel"><h3>${!inv ? "Findings" : inv.verdict === "unsure" ? "What each reading claimed" : "Why"}</h3>${findings.map((f) => `<article class="finding ${esc(f.verdict)}">
      <header><b>${esc(VERDICT[f.verdict] ?? f.verdict)}</b><span>${esc(f.body?.cause ?? "")}</span></header>
      ${(f.claims ?? []).map((c) => `<p class="claim">${esc(c.statement)}</p>${piecesHtml(c.pieces)}`).join("")}
      <div class="asides">${list("Ruled out", f.body?.ruled_out)}${list("Not checked", f.body?.not_checked)}</div>
    </article>`).join("")}</section>`;
}

function incidentView(i, d) {
  const now = state.snap.atMs;
  const off = down() ? " disabled" : "";
  const way = i.way
    ? `<div class="way-note">Put away with <b>${WAY_LABEL[i.way.kind]}</b>${i.way.when ? " until it gets worse" : i.way.untilMs ? ` until ${new Date(i.way.untilMs).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : i.way.kind === "later" ? " until something changes" : ""}${i.way.reason ? ` · ${esc(i.way.reason)}` : ""}. <kbd>u</kbd> puts it back.</div>`
    : "";
  const back = i.returned && !i.way ? `<div class="back-note"><b>${esc(m.RETURN_LABEL[i.returned.code] ?? "Back")}</b>${esc(i.returned.reason)}</div>` : "";
  const history = (d?.history ?? []).slice(-12).reverse().map((e) => `<li class="ev ev-${esc(e.kind)}"><span class="ev-kind">${esc(eventText(e))}</span><time>${m.ago(e.atMs, now)}</time></li>`).join("");
  const turns = (d?.turns ?? []).map((t) => `<li class="turn ${esc(t.state)}"><p class="question">${esc(t.text)}</p>${
    t.state === "answered" ? `<div class="answer">${esc(t.answer)}</div><p class="note basis">${esc(m.answerBasis(t))}</p>` : t.state === "failed" ? `<p class="note bound">No answer: ${esc(t.reason ?? "")}</p>` : `<p class="request-state"><span class="orbit" aria-hidden="true"></span>${t.state === "running" ? "an agent is answering" : "queued, waiting for an agent"}</p>`}</li>`).join("");
  const started = [...(state.snap.deploys ?? [])].reverse().find((x) => x.app === i.app && x.environment === i.environment && x.seq < i.firstSeq);
  const sources = state.snap.sources.filter((x) => x.app === i.app && x.environment === i.environment);
  const corrections = (d?.corrections ?? []).map((c) => `<li><time>${esc(c.date)}</time>${esc(c.text)}</li>`).join("");
  const done = (d?.investigations ?? []).filter((x) => x.result).at(-1);
  return `<article class="incident sev-${esc(i.severity)}">
    <header class="incident-head">
      <span class="sev">${SEVERITY_GLYPH[i.severity] ?? ""}</span>
      <div>
        <h2>${esc(i.title)}</h2>
        <div class="meta"><span class="place">${esc(i.app)} / ${esc(i.environment)}</span><span>${esc(i.severity)}</span><span class="count${i.exact ? "" : " bound"}">${m.countText(i.count, i.exact)}${i.exact ? "" : " (at least)"}</span><span>last ${m.ago(i.lastMs, now)}</span>${i.active ? "" : '<span class="pill quiet">quiet</span>'}</div>
      </div>
    </header>
    ${back}${way}
    <div class="actions">
      <button type="button" data-action="done"${off}>Done <kbd>d</kbd></button>
      <button type="button" data-action="later"${off}>Later <kbd>l</kbd></button>
      <button type="button" data-action="worse"${off}>Until worse <kbd>w</kbd></button>
      <button type="button" data-action="never"${off}>Never <kbd>n</kbd></button>
      ${i.way ? `<button type="button" data-action="undo"${off}>Put back <kbd>u</kbd></button>` : ""}
      <span class="sep" aria-hidden="true"></span>
      <button type="button" data-action="investigate"${off}>Investigate <kbd>i</kbd></button>
      <button type="button" data-action="open"${off}>Open in OpenCode <kbd>o</kbd></button>
      ${done ? `<button type="button" data-action="correct"${off}>Was this right? <kbd>y</kbd></button>` : ""}
      ${done && d?.fixable ? `<button type="button" data-action="fix"${off}>Propose fix <kbd>f</kbd></button>` : ""}
    </div>
    ${d?.comparison ? `<section class="panel"><h3>Staging against production</h3><p class="note warn">${esc(m.comparisonText(d.comparison))}</p></section>` : ""}
    ${verdictPanel(d)}
    ${fixPanel(i, d)}
    ${claimsPanel(d)}
    ${corrections ? `<section class="panel"><h3>Your corrections (in ${esc(i.app)}'s playbook)</h3><ul class="corrections">${corrections}</ul></section>` : ""}
    ${turns ? `<section class="panel"><h3>Questions</h3><ul class="turns">${turns}</ul></section>` : ""}
    <section class="panel">
      <h3>Counts</h3>
      ${started ? `<p class="started">Started after deploy <code>${esc(started.revision.slice(0, 12))}</code> to ${esc(i.app)}/${esc(i.environment)}.</p>` : ""}
      ${(() => { const l = ahead({ app: i.app, environment: i.environment }).left; return l ? `<p class="note warn">${esc(l.long)}</p>` : ""; })()}
      ${spark(i.spark, 560, 64)}
      <div class="axis"><span>24h ago</span><span>now</span></div>
      <p class="note${i.exact ? "" : " bound"}">${i.exact ? `Exact: ${i.count.toLocaleString("en-US")} occurrences, every reading fully measured while it was active.` : "A lower bound: part of the time was not fully read (a gap, a cap, or lines that rotated away)."} First seen ${m.ago(i.firstMs, now)}.</p>
      <ul class="sources">${sources.map((x) => `<li class="${x.failure ? "failing" : ""}" data-subject="${esc(x.subject)}"><b class="subject-link">${esc(x.id)}</b><span>${x.failure ? esc(causeTitle({ kind: x.failure })) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, now)}` : "not read yet"}</span></li>`).join("")}</ul>
    </section>
    <section class="panel"><h3>History</h3>${history ? `<ol class="history">${history}</ol>` : `<p class="note">Loading history…</p>`}</section>
  </article>`;
}

function eventText(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case "action": return d.action === "undo" ? "Put back (undo)" : `Put away: ${WAY_LABEL[d.action] ?? d.action}${d.way?.when ? " until worse" : ""}`;
    case "returned": return `${m.RETURN_LABEL[d.code] ?? "Back"} — ${d.reason}`;
    case "asked": return `Asked: “${d.text}”`;
    case "finding": return `Finding filed: ${String(d.verdict ?? "").replace("_", " ")}`;
    case "quieted": return "Went quiet";
    case "deadline": return "Later's time came";
    case "seen": return "Seen";
    case "investigation_queued": return `Investigation queued (${d.origin ?? "manual"})`;
    case "adjudicated": return `Investigated: ${m.verdictView(d.result).label} (${m.verdictView(d.result).votes})`;
    case "answered": return d.failed ? "A question went unanswered" : "A question was answered";
    case "corrected": return `Corrected: “${d.text}”`;
    case "opened": return "Opened in OpenCode";
    case "incident": return d.metric ? `Gauge ${d.state}` : "First counted";
    case "fix": return d.declined ? "Fix declined" : `Fix: ${m.FIX_LABEL[d.state] ?? d.state}${d.reason ? ` — ${d.reason}` : ""}`;
    case "comparison": return d.regression ? `Staging regression: ${d.regression}` : `Staging comparison: ${d.state}`;
    default: return e.kind;
  }
}

function environmentView(subject) {
  const s = state.snap;
  const e = s.environments.find((x) => x.subject === subject);
  if (!e) return `<div class="stage-empty"><b>Unknown environment</b></div>`;
  const h = m.cellHealth(e, state.connection, serverNow());
  const sources = s.sources.filter((x) => x.app === e.app && x.environment === e.environment);
  const coverage = s.coverage.filter((c) => sources.some((x) => x.id === c.source)).slice(-12).reverse();
  const metrics = s.metrics.filter((x) => sources.some((y) => y.id === x.source));
  return `<article class="environment ${h}">
    <header class="incident-head"><span class="glyph">${GLYPH[h] ?? GLYPH.unknown}</span><div><h2>${esc(e.app)} / ${esc(e.environment)}</h2><div class="meta"><span>${esc(m.HEALTH_LABEL[h])}</span>${e.excluded.length ? `<span>not measured here: ${esc(e.excluded.join(", "))}</span>` : ""}</div></div></header>
    <section class="panel"><h3>Sources</h3><ul class="sources">${sources.map((x) => `<li class="${x.failure ? "failing" : ""}" data-subject="${esc(x.subject)}"><b class="subject-link">${esc(x.id)}</b><span>${x.failure ? `${esc(causeTitle({ kind: x.failure }))}${x.suspended ? " · suspended, probing every five minutes" : ""}` : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, s.atMs)}` : "not read yet"}</span>${x.fix ? `<code>${esc(x.fix)}</code>` : ""}</li>`).join("")}</ul></section>
    ${outlookPanels(e)}
    ${metrics.length ? `<section class="panel"><h3>Gauges</h3><ul class="gauges">${metrics.map((x) => `<li class="${x.breach ? "breach" : ""}"><span>${esc(x.name)}</span><b>${esc(x.value)}</b>${x.breach ? "<em>over its limit</em>" : ""}</li>`).join("")}</ul></section>` : ""}
    <section class="panel"><h3>Coverage</h3><ol class="history">${coverage.map((c) => `<li class="cov cov-${esc(c.state)}"><span class="ev-kind">${esc(c.reading)}: ${esc(c.state)}${c.missed ? ` (${c.missed} missed)` : ""}</span><time>${m.ago(c.toMs, s.atMs)}</time></li>`).join("") || "<li>Nothing read yet</li>"}</ol></section>
  </article>`;
}

function sourceView(subject) {
  const s = state.snap;
  const x = s.sources.find((y) => y.subject === subject);
  if (!x) return `<div class="stage-empty"><b>Unknown source</b></div>`;
  const e = s.environments.find((y) => y.app === x.app && y.environment === x.environment);
  const coverage = s.coverage.filter((c) => c.source === x.id).slice(-12).reverse();
  const readings = (e?.readings ?? []).filter((r) => r.source === x.id);
  const now = serverNow();
  return `<article class="environment source">
    <header class="incident-head"><span class="glyph">${x.failure ? GLYPH.signed_out : GLYPH.quiet}</span><div><h2>${esc(x.id)}</h2>
      <div class="meta"><span>${esc(x.kind)}</span><span>${x.failure ? esc(causeTitle({ kind: x.failure })) : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, s.atMs)}` : "not read yet"}</span>${x.suspended ? "<span>suspended, probing every five minutes</span>" : ""}</div></div></header>
    ${x.fix ? `<div class="back-note"><b>Repair</b><code>${esc(x.fix)}</code></div>` : ""}
    <section class="panel"><h3>Readings</h3><ul class="gauges">${readings.map((r) => `<li class="${r.state === "ok" ? "" : "breach"}"><span>${esc(r.reading)}</span><b>${esc(r.state ?? "never read")}</b><em>${r.okMs === null ? "never measured" : `measured ${m.ago(r.okMs, now ?? s.atMs)}`}</em></li>`).join("")}</ul></section>
    <section class="panel"><h3>Coverage</h3><ol class="history">${coverage.map((c) => `<li class="cov cov-${esc(c.state)}"><span class="ev-kind">${esc(c.reading)}: ${esc(c.state)}${c.missed ? ` (${c.missed} missed)` : ""}</span><time>${m.ago(c.toMs, s.atMs)}</time></li>`).join("") || "<li>Nothing read yet</li>"}</ol></section>
  </article>`;
}

function renderDock() {
  const chip = $("[data-chip]");
  const route = $("[data-route]");
  const f = state.focus;
  const dock = $("[data-dock]");
  dock.classList.toggle("locked", Boolean(f));
  dock.classList.toggle("off", down());
  if (!f) {
    chip.textContent = "Nothing in focus: Enter finds";
    route.textContent = "";
    $("[data-send]").firstChild.textContent = "Find ";
  } else {
    const i = isIncident(f) ? incident(f) ?? state.detail?.incident : null;
    chip.innerHTML = `<span class="reticle" aria-hidden="true">⌖</span>${esc(i ? `${i.app}/${i.environment} · ${i.title}` : f.slice(4).replaceAll("/", " / "))}`;
    const t = state.target?.subject === f ? state.target.promptTarget : null;
    route.textContent = down() ? "Service not answering: your draft is kept" : t ? (t.mode === "continue" ? "Continues the conversation · Shift+Enter for a new one" : "Queues a new conversation with an agent") : "";
    $("[data-send]").firstChild.textContent = "Ask ";
  }
  $("[data-send]").disabled = down();
}

// ---------------------------------------------------------------- focus and detail

async function setFocus(subject) {
  if (state.focus === subject) return;
  state.focus = subject;
  state.target = null;
  state.key = null;
  clearTimeout(state.seenTimer);
  if (isIncident(subject)) {
    if (state.detail?.incident?.id !== subject) state.detail = null;
    loadDetail(subject);
    // Seen means looked at: focus held for a moment, not passed over on the way to something else.
    state.seenTimer = setTimeout(() => state.focus === subject && markSeen(subject), m.SEEN_AFTER_MS);
  }
  render();
  scrollFocused();
  call("focus?subject=" + encodeURIComponent(subject)).then((t) => {
    if (state.focus !== subject) return;
    state.target = t;
    renderDock();
  }, () => undefined);
}

async function loadDetail(id) {
  try {
    const seq = state.snap?.seq ?? 0;
    const d = await call("items/" + encodeURIComponent(id));
    if (state.focus !== id) return;
    state.detailSeq = Math.max(state.detailSeq, seq);
    state.detail = { ...d, incident: { ...d.incident } };
    renderStage();
    renderDock();
  } catch {
    // The stream's next snapshot will try again.
  }
}

function markSeen(id) {
  const i = incident(id);
  if (!i || down() || i.lastSeq <= i.seenSeq) return;
  call(`items/${encodeURIComponent(id)}/action`, { action: "seen", throughSeq: state.snap.seq }).then(apply, () => undefined);
}

function scrollFocused() {
  const el = state.focus && document.querySelector(`[data-item-id="${CSS.escape(state.focus)}"]`);
  el?.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- actions

function toast(text, kind = "") {
  const t = $("[data-toast]");
  t.textContent = text;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast"), 3200);
}

async function wayOut(body, basis = incident(state.focus)?.decidedSeq) {
  const id = state.focus;
  if (!isIncident(id) || down()) return;
  const before = rows();
  try {
    // The decision is bound to the state the owner was shown: if it changed since, the service refuses it.
    const res = await call(`items/${encodeURIComponent(id)}/action`, { ...body, ...(basis === undefined ? {} : { basisSeq: basis }) });
    state.actions.push({ id, seq: res.action.seq });
    state.shown = m.without(state.shown, id);
    const next = m.after(before, id, id);
    apply(res);
    toast(`${body.action === "done" ? "Done" : body.action === "never" ? "Never" : "Later"}: ${incident(id)?.title ?? ""} · u puts it back`);
    if (next && next !== id) setFocus(next);
    else render();
  } catch (e) {
    if (e.status === 409) {
      toast("This changed since you looked (another tab or a return). Look again, then decide.", "error");
      loadDetail(id);
      render();
    } else toast(e.message, "error");
  }
}

async function undo() {
  if (down()) return;
  const last = state.actions.pop() ?? (isIncident(state.focus) && incident(state.focus)?.way ? { id: state.focus, seq: incident(state.focus).way.seq } : null);
  if (!last) return toast("Nothing to undo");
  try {
    const res = await call(`items/${encodeURIComponent(last.id)}/action`, { action: "undo", actionSeq: last.seq });
    state.shown = m.restore(state.shown, res.inbox, last.id);
    apply(res);
    state.focus = null;
    setFocus(last.id);
    toast("Put back");
  } catch (e) {
    toast(e.status === 409 ? "That changed since: nothing undone" : e.message, "error");
  }
}

/** A request key for this subject, from the service (the page makes no identifiers). */
const requestKey = async (subject) => (await call("focus?subject=" + encodeURIComponent(subject))).requestKey;

/** O: the focused thing in an ordinary OpenCode session. The window opens with the key press; the URL follows. */
async function openInOpenCode() {
  const subject = state.focus;
  if (!subject || down()) return toast(subject ? "Service not answering" : "Put something in focus first");
  const win = window.open("about:blank", "_blank");
  try {
    const r = await call("open", { subject }, { "Idempotency-Key": await requestKey(subject) });
    if (win) win.location.href = r.url;
    else window.location.href = r.url;
  } catch (e) {
    win?.close();
    toast(e.message, "error");
  }
}

async function investigate() {
  const id = state.focus;
  if (!isIncident(id) || down()) return;
  try {
    await call(`items/${encodeURIComponent(id)}/investigate`, {}, { "Idempotency-Key": await requestKey(id) });
    toast("Investigation queued: independent readings, then a challenger if most say real.", "ok");
    loadDetail(id);
  } catch (e) {
    toast(e.message, "error");
  }
}

/** F: ask for a fix proposal on the latest investigation; the answer, a proposal or the rule that stops it, appears in place. */
async function proposeFix() {
  const id = state.focus, job = (state.detail?.investigations ?? []).filter((x) => x.result).at(-1);
  if (!isIncident(id) || down() || !job) return;
  try {
    await call(`items/${encodeURIComponent(id)}/fix`, { jobId: job.id }, { "Idempotency-Key": await requestKey(id) });
    toast("Fix requested: every rule is checked before anything is proposed.", "ok");
    loadDetail(id);
  } catch (e) {
    toast(e.message, "error");
  }
}
async function declineFix(fixId) {
  try {
    await call(`fixes/${encodeURIComponent(fixId)}/decline`, {}, { "Idempotency-Key": await requestKey(state.focus) });
    toast("Declined. The problem stays open; this finding is not proposed again.", "ok");
    loadDetail(state.focus);
  } catch (e) {
    toast(e.message, "error");
  }
}

/** B: a brief to copy. The owner edits it and sends it himself; nothing is sent from here. */
function briefSheet() {
  state.overlay = "brief";
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div>
    <div class="sheet brief-sheet" role="dialog" aria-modal="true" aria-labelledby="brief-title">
      <h2 id="brief-title">Brief</h2>
      <label>For <select data-brief-audience><option value="owner">you (technical)</option><option value="team">the team (plain words)</option></select></label>
      <textarea data-brief-text rows="14" spellcheck="true" aria-label="Brief text"></textarea>
      <p class="hint">What changed, from the event log. Edit it, copy it, send it yourself.</p>
      <div class="sheet-actions"><button type="button" data-close>Close <kbd>Esc</kbd></button><button type="button" class="primary" data-brief-copy>Copy</button></div>
    </div>`;
  const select = $("[data-brief-audience]");
  // Choosing an audience asks for its brief; the answer replaces the text only if the owner has not typed since:
  // an edit made while the request waits is never overwritten by a late template.
  let placed = "";
  const load = async () => {
    const text = $("[data-brief-text]");
    text.value = placed = "Loading…";
    try {
      const b = await call("brief?audience=" + encodeURIComponent(select.value));
      if (state.overlay === "brief" && select.value === b.audience && text.value === placed) text.value = placed = b.text;
    } catch (e) {
      if (text.value === placed) text.value = placed = "";
      toast(e.message, "error");
    }
  };
  select.addEventListener("change", load);
  $("[data-brief-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("[data-brief-text]").value);
      toast("Copied. Nothing was sent.", "ok");
    } catch (e) {
      toast(`Copy failed: ${e.message}`, "error");
    }
  });
  select.focus();
  load();
}

/** "Was this right?": one dated line in the app's playbook, read by later investigations of that app. */
function correctSheet() {
  const i = incident(state.focus);
  const job = (state.detail?.investigations ?? []).filter((x) => x.result).at(-1);
  if (!i || !job || down()) return toast(job ? "Service not answering" : "Nothing investigated to correct yet");
  state.overlay = "correct";
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div>
    <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="correct-title" data-sheet="correct" data-job="${esc(job.jobId)}">
      <h2 id="correct-title">Was this right?</h2>
      <p class="sheet-subject">${esc(i.title)}: ${esc(m.verdictView(job.result).label)}</p>
      <label>What should the next investigation of ${esc(i.app)} know? <textarea data-sheet-input rows="4" maxlength="1000" placeholder="e.g. The regional maintenance window runs 02:00–03:00 UTC; check it first."></textarea></label>
      <p class="hint">It becomes one dated line in ${esc(i.app)}'s playbook and is given to later readers as guidance. It does not change this verdict.</p>
      <p class="error" data-sheet-error></p>
      <div class="sheet-actions"><button type="button" data-close>Cancel <kbd>Esc</kbd></button><button type="submit" class="primary">Save <kbd>⌘↵</kbd></button></div>
    </form>`;
  $("[data-sheet-input]").focus();
}

async function saveCorrection(form) {
  const text = $("[data-sheet-input]", form).value.trim();
  if (!text) return void ($("[data-sheet-error]", form).textContent = "Write what was wrong or what to check");
  const id = state.focus;
  try {
    await call(`items/${encodeURIComponent(id)}/corrections`, { jobId: form.dataset.job, text }, { "Idempotency-Key": await requestKey(id) });
    close();
    toast("Saved to the playbook.", "ok");
    loadDetail(id);
  } catch (e) {
    $("[data-sheet-error]", form).textContent = e.message;
  }
}

function refresh() {
  if (!state.snap) return;
  state.shown = m.freeze(state.snap.inbox);
  render();
}

// ---------------------------------------------------------------- overlays: Later, Never, search, keys

function close() {
  state.overlay = null;
  $("[data-overlay]").innerHTML = "";
}

function sheet(kind) {
  const i = incident(state.focus);
  if (!i || down()) return;
  state.overlay = kind;
  state.sheetBasis = i.decidedSeq;
  const later = kind === "later";
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div>
    <form class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" data-sheet="${kind}">
      <h2 id="sheet-title">${later ? "Later" : "Never"}</h2>
      <p class="sheet-subject">${esc(i.title)}</p>
      ${later
        ? `<label>Until <input name="until" data-sheet-input placeholder="something changes" autofocus></label>
           <p class="hint">Leave empty for <b>until something changes</b> (a deploy here, a finding, or worse). Or type <code>2h</code>, <code>tomorrow</code>, <code>monday</code>, <code>worse</code>.</p>`
        : `<p class="hint">It stays counted and searchable, and comes back only if it becomes more severe or ten times as frequent.</p>
           <div class="chips">${["noise", "expected", "duplicate"].map((r) => `<button type="button" class="chip-option" data-reason="${r}">${r}</button>`).join("")}</div>
           <label>Reason <input name="reason" data-sheet-input placeholder="optional" autofocus></label>`}
      <p class="error" data-sheet-error></p>
      <div class="sheet-actions"><button type="button" data-close>Cancel <kbd>Esc</kbd></button><button type="submit" class="primary">${later ? "Later" : "Never"} <kbd>↵</kbd></button></div>
    </form>`;
  const input = $("[data-sheet-input]");
  input.focus();
}

function submitSheet(form) {
  const input = $("[data-sheet-input]", form);
  if (form.dataset.sheet === "later") {
    const body = m.later(input.value, Date.now());
    if (body.error) return void ($("[data-sheet-error]", form).textContent = body.error);
    const basis = state.sheetBasis;
    close();
    wayOut(body, basis);
  } else {
    const reason = input.value.trim();
    const basis = state.sheetBasis;
    close();
    wayOut({ action: "never", ...(reason ? { reason } : {}) }, basis);
  }
}

let searchTimer = 0;
function openSearch(q = "") {
  state.overlay = "search";
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Find">
      <div class="palette-input"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>
        <input data-search placeholder="Find problems, findings, evidence and prompts, even put away" value="${esc(q)}" aria-label="Find"></div>
      <ul class="results" data-results role="listbox"></ul>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> focus</span><span><kbd>Esc</kbd> close</span></footer>
    </div>`;
  const input = $("[data-search]");
  input.focus();
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 90);
  });
  if (q) runSearch(q);
}

async function runSearch(q, cursor = null) {
  const list = $("[data-results]");
  if (!list) return;
  if (!q.trim()) return void (list.innerHTML = "");
  try {
    const { items, nextCursor } = await call("search?q=" + encodeURIComponent(q) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    if (state.overlay !== "search" || $("[data-search]")?.value !== q) return;
    state.results = { q, nextCursor };
    $("[data-more]")?.remove();
    const html = items.length || cursor
      ? items.map((r, n) => {
          const i = incident(r.id);
          const where = i ? (i.way ? `put away: ${WAY_LABEL[i.way.kind]}` : m.GROUP_LABEL[i.group] ?? "") : "";
          return `<li class="result${n === 0 && !cursor ? " selected" : ""}" data-result-id="${esc(r.id)}" role="option"><b>${esc(r.title)}</b><span class="where">${esc(where)}</span>${r.excerpt.trim() === r.title.trim() ? "" : `<span class="excerpt">${esc(r.excerpt)}</span>`}</li>`;
        }).join("")
      : `<li class="no-results">Nothing matches “${esc(q)}”</li>`;
    const more = nextCursor ? `<li class="more" data-more role="option">More results <kbd>↓</kbd></li>` : "";
    if (cursor) list.insertAdjacentHTML("beforeend", html + more);
    else list.innerHTML = html + more;
  } catch (e) {
    list.innerHTML = `<li class="no-results">${esc(e.message)}</li>`;
  }
}

function moveResult(delta) {
  const all = [...document.querySelectorAll("[data-result-id]")];
  if (!all.length) return;
  const i = all.findIndex((x) => x.classList.contains("selected"));
  // Moving past the last result loads the next page: every match can be reached.
  if (delta > 0 && i === all.length - 1 && state.results?.nextCursor) return void runSearch(state.results.q, state.results.nextCursor);
  all[i]?.classList.remove("selected");
  const next = all[Math.min(all.length - 1, Math.max(0, i + delta))];
  next.classList.add("selected");
  next.scrollIntoView({ block: "nearest" });
}

function chooseResult(el) {
  const id = (el ?? $(".result.selected"))?.dataset.resultId;
  if (!id) return;
  close();
  setFocus(id);
}

function help() {
  state.overlay = "help";
  const keys = [
    ["j / ↓", "Next row"], ["k / ↑", "Previous row"], ["d", "Done: back if it happens again"], ["l", "Later: until something changes, a time, or worse"],
    ["w", "Later, until it gets worse"], ["n", "Never: back only if much worse or more severe"], ["u", "Undo the last way out"], ["r", "Show what waits behind “N new”"],
    ["p / Enter", "Ask about what is in focus"], ["i", "Investigate: independent readings and a challenger"], ["o", "Open in OpenCode, with this in focus"],
    ["y", "Was this right? A line for the app's playbook"], ["b", "Brief: what changed, to edit and copy"], ["Shift+Enter", "Ask in a new request"], ["/ or ⌘K", "Find anything, even put away"], ["t", "Light or dark"], ["Esc", "Close, or leave the bar"],
  ];
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div><div class="sheet keys-sheet" role="dialog" aria-modal="true" aria-label="Keyboard"><h2>Keyboard</h2><dl>${keys.map(([k, v]) => `<div><dt>${k.split(" / ").map((x) => `<kbd>${esc(x)}</kbd>`).join(" ")}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></div>`;
}

// ---------------------------------------------------------------- the bar

async function submitPrompt(newSession) {
  const input = $("[data-prompt]");
  const text = input.value.trim();
  if (!state.focus) return openSearch(text);
  // One draft, one request: a second Enter while the first is on its way is ignored.
  if (!text || down() || state.sending) return;
  const subject = state.focus;
  state.sending = true;
  try {
    // One key per draft, kept until it is accepted, so a retry can never queue the same prompt twice.
    if (!state.key || state.key.subject !== subject) {
      const t = state.target?.subject === subject ? state.target : await call("focus?subject=" + encodeURIComponent(subject));
      state.key = { subject, value: t.requestKey };
    }
    const result = await call("ask", { subject, text, mode: newSession ? "new" : "auto" }, { "Idempotency-Key": state.key.value });
    // A late reply clears only the draft it answered, never what was typed since.
    if (input.value.trim() === text) input.value = "";
    state.key = null;
    autosize(input);
    if (state.focus === subject && isIncident(subject)) loadDetail(subject);
    toast(result.target.mode === "new" ? "Queued: an agent answers here, under Questions." : "Added to the queued request.", "ok");
    call("focus?subject=" + encodeURIComponent(subject)).then((t) => ((state.target = t), renderDock()), () => undefined);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    state.sending = false;
  }
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(160, el.scrollHeight) + "px";
}

// ---------------------------------------------------------------- input

function theme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("ow-theme", next);
  } catch {}
}

document.addEventListener("keydown", (e) => {
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
  if (state.overlay === "search" && typing) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") return e.preventDefault(), moveResult(e.key === "ArrowDown" ? 1 : -1);
    if (e.key === "Enter") return e.preventDefault(), chooseResult();
  }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && target instanceof Element && target.closest("[data-sheet=correct]")) return e.preventDefault(), saveCorrection(target.closest("form"));
  if (target === $("[data-prompt]") && e.key === "Enter" && !e.shiftKey && !e.isComposing) return e.preventDefault(), submitPrompt(false);
  if (target === $("[data-prompt]") && e.key === "Enter" && e.shiftKey) return e.preventDefault(), submitPrompt(true);
  const c = m.command(e.key, { typing, overlay: Boolean(state.overlay), shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  if (!c) return;
  e.preventDefault();
  if (c === "escape") return state.overlay ? close() : target instanceof HTMLElement && target.blur();
  if (c === "search") return openSearch();
  const list = rows();
  switch (c) {
    case "next": return setFocus(m.step(list, state.focus, 1));
    case "previous": return setFocus(m.step(list, state.focus, -1));
    case "done": return wayOut({ action: "done" });
    case "later": return sheet("later");
    case "never": return sheet("never");
    case "worse": return wayOut({ action: "later", when: "worse" });
    case "undo": return undo();
    case "refresh": return refresh();
    case "prompt": return state.focus ? $("[data-prompt]").focus() : openSearch();
    case "theme": return theme();
    case "help": return help();
    case "open": return openInOpenCode();
    case "brief": return briefSheet();
    case "investigate": return investigate();
    case "correct": return correctSheet();
    case "fix": return proposeFix();
  }
});

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const handle = t.closest("[data-handle]");
  if (handle)
    return navigator.clipboard.writeText(handle.dataset.handle).then(() => toast(`Copied ${handle.dataset.handle}`, "ok"), (err) => toast(`Copy failed: ${err.message}`, "error"));
  if (t.closest("[data-back]")) {
    state.focus = null;
    render();
    return window.scrollTo({ top: 0 });
  }
  const env = t.closest("[data-env]");
  if (env) return setFocus(env.dataset.subject);
  const subject = t.closest("[data-subject]");
  if (subject) return setFocus(subject.dataset.subject);
  if (t.closest("[data-more]") && state.results?.nextCursor) return runSearch(state.results.q, state.results.nextCursor);
  const r = t.closest("[data-item-id]");
  if (r) return setFocus(r.dataset.itemId);
  const toggle = t.closest("[data-toggle]");
  if (toggle) {
    state.collapsed[toggle.dataset.toggle] = !state.collapsed[toggle.dataset.toggle];
    try {
      localStorage.setItem("ow-groups", JSON.stringify(state.collapsed));
    } catch {}
    return renderGroups();
  }
  if (t.closest("[data-pending]")) return refresh();
  if (t.closest("[data-close]")) return close();
  if (t.closest("[data-theme-toggle]")) return theme();
  if (t.closest("[data-help]")) return help();
  const result = t.closest("[data-result-id]");
  if (result) return chooseResult(result);
  const reason = t.closest("[data-reason]");
  if (reason) {
    const input = $("[data-sheet-input]");
    input.value = reason.dataset.reason;
    return input.focus();
  }
  const action = t.closest("[data-action]");
  if (action && !action.disabled) {
    const a = action.dataset.action;
    return a === "done" ? wayOut({ action: "done" }) : a === "worse" ? wayOut({ action: "later", when: "worse" }) : a === "undo" ? undo()
      : a === "open" ? openInOpenCode() : a === "investigate" ? investigate() : a === "correct" ? correctSheet() : a === "fix" ? proposeFix() : sheet(a);
  }
  const decline = t.closest("[data-decline]");
  if (decline) return declineFix(decline.dataset.decline);
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.matches("[data-sheet=correct]")) return saveCorrection(form);
  if (form.matches("[data-sheet]")) return submitSheet(form);
  if (form.matches("[data-dock]")) return submitPrompt(false);
});

$("[data-prompt]").addEventListener("input", (e) => autosize(e.target));

render();
connect();
setInterval(tick, 1000);
