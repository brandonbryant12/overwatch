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

const state = {
  snap: null,
  last: null,
  connection: "unknown",
  shown: null,
  collapsed: { needsYou: false, new: false, working: true, quiet: true },
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
  if (!state.shown) state.shown = m.freeze(snap.inbox);
  render();
  if (state.focus && !state.focus.startsWith("env:") && !state.focus.startsWith("src:")) {
    const row = incident(state.focus);
    if (row && state.detail?.incident?.id === row.id && state.detail.incident.lastSeq !== row.lastSeq) loadDetail(state.focus);
  }
}

function heard() {
  state.last = sample();
  tick();
}

function connect() {
  const stream = new EventSource("/v2/changes");
  const onSnap = (e) => {
    heard();
    apply(JSON.parse(e.data));
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
  } else renderConnection();
}

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
      const h = m.shownHealth(e.health, state.connection);
      const errors = s.incidents.filter((i) => i.app === e.app && i.environment === e.environment && i.active && i.severity === "error").length;
      const detail = h === "attention" ? `${errors} active error${errors === 1 ? "" : "s"}` : h === "unknown" ? "until the service answers" : h === "signed_out" ? "sign in again" : h === "stale" ? "readings are old" : h === "partial" ? "not every reading" : "every reading fresh";
      return `<button type="button" class="env ${h}${state.focus === e.subject ? " focused" : ""}" data-env="${esc(e.environment)}" data-app="${esc(e.app)}" data-health="${h}" data-subject="${esc(e.subject)}">
        <span class="glyph">${GLYPH[h] ?? GLYPH.unknown}</span>
        <span class="env-name"><b>${esc(e.environment)}</b><span>${esc(e.app)}</span></span>
        <span class="env-state"><b>${esc(m.HEALTH_LABEL[h])}</b><span>${esc(detail)}</span></span>
      </button>`;
    })
    .join("");
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
  const pending = m.staged(state.shown, s.inbox);
  const pend = $("[data-pending]");
  pend.dataset.pendingCount = String(pending.count);
  pend.hidden = pending.count === 0;
  pend.innerHTML = `${pending.count} new <kbd>r</kbd>`;
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
  if (f.startsWith("env:")) return void (stage.innerHTML = environmentView(f));
  const d = state.detail?.incident?.id === f ? state.detail : null;
  const i = incident(f) ?? d?.incident;
  if (!i) return void (stage.innerHTML = `<div class="stage-empty"><b>Loading…</b></div>`);
  stage.innerHTML = incidentView(i, d);
}

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

function incidentView(i, d) {
  const now = state.snap.atMs;
  const off = down() ? " disabled" : "";
  const way = i.way
    ? `<div class="way-note">Put away with <b>${WAY_LABEL[i.way.kind]}</b>${i.way.when ? " until it gets worse" : i.way.untilMs ? ` until ${new Date(i.way.untilMs).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : i.way.kind === "later" ? " until something changes" : ""}${i.way.reason ? ` · ${esc(i.way.reason)}` : ""}. <kbd>u</kbd> puts it back.</div>`
    : "";
  const back = i.returned && !i.way ? `<div class="back-note"><b>${esc(m.RETURN_LABEL[i.returned.code] ?? "Back")}</b>${esc(i.returned.reason)}</div>` : "";
  const history = (d?.history ?? []).slice(-12).reverse().map((e) => `<li class="ev ev-${esc(e.kind)}"><span class="ev-kind">${esc(eventText(e))}</span><time>${m.ago(e.atMs, now)}</time></li>`).join("");
  const findings = (d?.findings ?? []).map((f) => `<article class="finding ${esc(f.verdict)}">
      <header><b>${esc({ real: "Real", not_real: "Not real", unsure: "Unsure" }[f.verdict] ?? f.verdict)}</b><span>${esc(f.body?.cause ?? "")}</span></header>
      ${(f.claims ?? []).map((c) => `<p>${esc(c.statement)}</p>${(c.pieces ?? []).map((p) => `<pre class="evidence"><span class="handle">${esc(p.handle)}</span>${esc(p.text)}</pre>`).join("")}`).join("")}
    </article>`).join("");
  return `<article class="incident sev-${esc(i.severity)}">
    <header class="incident-head">
      <span class="sev">${SEVERITY_GLYPH[i.severity] ?? ""}</span>
      <div>
        <h2>${esc(i.title)}</h2>
        <div class="meta"><span class="place">${esc(i.app)} / ${esc(i.environment)}</span><span>${esc(i.severity)}</span><span class="count${i.exact ? "" : " bound"}">${m.countText(i.count, i.exact)}${i.exact ? "" : " (at least)"}</span><span>first ${m.ago(i.firstMs, now)}</span><span>last ${m.ago(i.lastMs, now)}</span>${i.active ? "" : '<span class="pill quiet">quiet</span>'}</div>
      </div>
    </header>
    ${back}${way}
    <div class="actions">
      <button type="button" data-action="done"${off}>Done <kbd>d</kbd></button>
      <button type="button" data-action="later"${off}>Later <kbd>l</kbd></button>
      <button type="button" data-action="worse"${off}>Until worse <kbd>w</kbd></button>
      <button type="button" data-action="never"${off}>Never <kbd>n</kbd></button>
      ${i.way ? `<button type="button" data-action="undo"${off}>Put back <kbd>u</kbd></button>` : ""}
    </div>
    <section class="panel">
      <h3>Last 24 hours</h3>
      ${spark(i.spark, 560, 64)}
      <div class="axis"><span>24h ago</span><span>now</span></div>
      ${i.exact ? "" : `<p class="note bound">The total is a lower bound: part of the time was not fully read (a gap, a cap, or lines that rotated away).</p>`}
    </section>
    ${findings ? `<section class="panel"><h3>Findings</h3>${findings}</section>` : ""}
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
    case "incident": return d.metric ? `Gauge ${d.state}` : "First counted";
    default: return e.kind;
  }
}

function environmentView(subject) {
  const s = state.snap;
  const e = s.environments.find((x) => x.subject === subject);
  if (!e) return `<div class="stage-empty"><b>Unknown environment</b></div>`;
  const h = m.shownHealth(e.health, state.connection);
  const sources = s.sources.filter((x) => x.app === e.app && x.environment === e.environment);
  const coverage = s.coverage.filter((c) => sources.some((x) => x.id === c.source)).slice(-12).reverse();
  const metrics = s.metrics.filter((x) => sources.some((y) => y.id === x.source));
  return `<article class="environment ${h}">
    <header class="incident-head"><span class="glyph">${GLYPH[h] ?? GLYPH.unknown}</span><div><h2>${esc(e.app)} / ${esc(e.environment)}</h2><div class="meta"><span>${esc(m.HEALTH_LABEL[h])}</span>${e.excluded.length ? `<span>not measured here: ${esc(e.excluded.join(", "))}</span>` : ""}</div></div></header>
    <section class="panel"><h3>Sources</h3><ul class="sources">${sources.map((x) => `<li class="${x.failure ? "failing" : ""}"><b>${esc(x.id)}</b><span>${x.failure ? `${esc(causeTitle({ kind: x.failure }))}${x.suspended ? " · suspended, probing every five minutes" : ""}` : x.checkpointMs ? `read through ${m.ago(x.checkpointMs, s.atMs)}` : "not read yet"}</span>${x.fix ? `<code>${esc(x.fix)}</code>` : ""}</li>`).join("")}</ul></section>
    ${metrics.length ? `<section class="panel"><h3>Gauges</h3><ul class="gauges">${metrics.map((x) => `<li class="${x.breach ? "breach" : ""}"><span>${esc(x.name)}</span><b>${esc(x.value)}</b>${x.breach ? "<em>over its limit</em>" : ""}</li>`).join("")}</ul></section>` : ""}
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
    route.textContent = down() ? "Service not answering: your draft is kept" : t ? (t.mode === "continue" ? "Adds to the queued request · Shift+Enter for a new one" : "Queues a new request for an agent") : "";
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
  if (isIncident(subject)) {
    if (state.detail?.incident?.id !== subject) state.detail = null;
    loadDetail(subject);
    markSeen(subject);
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
    const d = await call("items/" + encodeURIComponent(id));
    if (state.focus !== id) return;
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

async function wayOut(body) {
  const id = state.focus;
  if (!isIncident(id) || down()) return;
  const before = rows();
  try {
    const res = await call(`items/${encodeURIComponent(id)}/action`, body);
    state.actions.push({ id, seq: res.action.seq });
    state.shown = m.without(state.shown, id);
    const next = m.after(before, id, id);
    apply(res);
    toast(`${body.action === "done" ? "Done" : body.action === "never" ? "Never" : "Later"}: ${incident(id)?.title ?? ""} · u puts it back`);
    if (next && next !== id) setFocus(next);
    else render();
  } catch (e) {
    toast(e.message, "error");
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
    close();
    wayOut(body);
  } else {
    const reason = input.value.trim();
    close();
    wayOut({ action: "never", ...(reason ? { reason } : {}) });
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

async function runSearch(q) {
  const list = $("[data-results]");
  if (!list) return;
  if (!q.trim()) return void (list.innerHTML = "");
  try {
    const { items } = await call("search?q=" + encodeURIComponent(q));
    if (state.overlay !== "search" || $("[data-search]")?.value !== q) return;
    list.innerHTML = items.length
      ? items.map((r, n) => {
          const i = incident(r.id);
          const where = i ? (i.way ? `put away: ${WAY_LABEL[i.way.kind]}` : m.GROUP_LABEL[i.group] ?? "") : "";
          return `<li class="result${n === 0 ? " selected" : ""}" data-result-id="${esc(r.id)}" role="option"><b>${esc(r.title)}</b><span class="where">${esc(where)}</span>${r.excerpt.trim() === r.title.trim() ? "" : `<span class="excerpt">${esc(r.excerpt)}</span>`}</li>`;
        }).join("")
      : `<li class="no-results">Nothing matches “${esc(q)}”</li>`;
  } catch (e) {
    list.innerHTML = `<li class="no-results">${esc(e.message)}</li>`;
  }
}

function moveResult(delta) {
  const all = [...document.querySelectorAll("[data-result-id]")];
  if (!all.length) return;
  const i = all.findIndex((x) => x.classList.contains("selected"));
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
    ["p / Enter", "Ask about what is in focus"], ["Shift+Enter", "Ask in a new request"], ["/ or ⌘K", "Find anything, even put away"], ["t", "Light or dark"], ["Esc", "Close, or leave the bar"],
  ];
  $("[data-overlay]").innerHTML = `<div class="backdrop" data-close></div><div class="sheet keys-sheet" role="dialog" aria-modal="true" aria-label="Keyboard"><h2>Keyboard</h2><dl>${keys.map(([k, v]) => `<div><dt>${k.split(" / ").map((x) => `<kbd>${esc(x)}</kbd>`).join(" ")}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></div>`;
}

// ---------------------------------------------------------------- the bar

async function submitPrompt(newSession) {
  const input = $("[data-prompt]");
  const text = input.value.trim();
  if (!text || down()) return;
  const subject = state.focus;
  if (!subject) return openSearch(text);
  try {
    // One key per draft, kept until it is accepted, so a retry can never queue the same prompt twice.
    if (!state.key || state.key.subject !== subject) {
      const t = state.target?.subject === subject ? state.target : await call("focus?subject=" + encodeURIComponent(subject));
      state.key = { subject, value: t.requestKey };
    }
    const result = await call("ask", { subject, text, mode: newSession ? "new" : "auto" }, { "Idempotency-Key": state.key.value });
    input.value = "";
    state.key = null;
    autosize(input);
    toast(result.target.mode === "new" ? "Queued for an agent. Agents answer from milestone 3." : "Added to the queued request.", "ok");
    call("focus?subject=" + encodeURIComponent(subject)).then((t) => ((state.target = t), renderDock()), () => undefined);
  } catch (e) {
    toast(e.message, "error");
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
    case "prompt": return $("[data-prompt]").focus();
    case "theme": return theme();
    case "help": return help();
  }
});

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const env = t.closest("[data-env]");
  if (env) return setFocus(env.dataset.subject);
  const r = t.closest("[data-item-id]");
  if (r) return setFocus(r.dataset.itemId);
  const toggle = t.closest("[data-toggle]");
  if (toggle) {
    state.collapsed[toggle.dataset.toggle] = !state.collapsed[toggle.dataset.toggle];
    return renderGroups();
  }
  if (t.closest("[data-pending]")) return refresh();
  if (t.closest("[data-close]")) return close();
  if (t.closest("[data-open-search]")) return openSearch();
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
    return a === "done" ? wayOut({ action: "done" }) : a === "worse" ? wayOut({ action: "later", when: "worse" }) : a === "undo" ? undo() : sheet(a);
  }
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.matches("[data-sheet]")) return submitSheet(form);
  if (form.matches("[data-dock]")) return submitPrompt(false);
});

$("[data-prompt]").addEventListener("input", (e) => autosize(e.target));

render();
connect();
setInterval(tick, 1000);
