// Overwatch Zero-Business-Logic Web Cockpit
// Hydrates projections exclusively from GET /api/state, syncs live across tabs via
// resumable EventSource(/api/stream?after=<cursor>), and sends typed intents to POST /api/intents/*.

const ui = {
  view: "now",
  selectedEnv: "checkout-api:prod",
  selectedIncident: "INC-42",
  teamFilter: "all",
  state: null,
  cursor: 0,
  eventSource: null,
  paletteOpen: false,
  paletteIndex: 0,
};

const $ = (sel) => document.querySelector(sel);

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtAgo(tsMs) {
  if (!tsMs) return "not yet sampled";
  const sec = Math.max(0, Math.round((Date.now() - tsMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

function showToast(msg) {
  const region = $("#toast-region");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  region.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function fetchState() {
  const res = await fetch("/api/state", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ui.state = await res.json();
  ui.cursor = ui.state.cursor ?? ui.cursor;
  if (!ui.state.incidentDetails?.[ui.selectedIncident]) {
    const firstInc = Object.keys(ui.state.now?.incidents ?? {})[0];
    if (firstInc) ui.selectedIncident = firstInc;
  }
  if (!ui.state.telemetry?.[ui.selectedEnv]) {
    const firstEnv = Object.keys(ui.state.now?.environments ?? {})[0];
    if (firstEnv) ui.selectedEnv = firstEnv;
  }
  render();
}

async function sendIntent(intent, payload = {}, successMsg = "Updated") {
  const commandId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(`/api/intents/${intent}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, commandId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error ?? `Action ${intent} rejected`);
    return null;
  }
  showToast(data.notice ?? successMsg);
  await fetchState();
  return data;
}

function connectStream() {
  if (ui.eventSource) ui.eventSource.close();
  const es = new EventSource(`/api/stream?after=${ui.cursor}`);
  ui.eventSource = es;

  es.addEventListener("connected", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      $("#status-message").textContent = `Connected to Overwatch daemon (${data.mode} mode)`;
      // Always reload after (re)connecting: a restart or a long gap can outrun the replay buffer.
      ui.cursor = Math.max(ui.cursor, Number(data.cursor || 0));
      void fetchState();
    } catch {
      // ignore
    }
  });

  es.addEventListener("update", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      ui.cursor = Math.max(ui.cursor, Number(data.cursor || 0));
      if (data.kind !== "telemetry.collected") {
        $("#status-message").textContent = `Latest event: ${data.kind} (${data.detail})`;
      }
      void fetchState().then(() => announce(data));
    } catch {
      // ignore
    }
  });

  es.onerror = () => {
    $("#status-message").textContent = "Reconnecting to Overwatch stream...";
  };
}

// Tell the operator about the two events worth interrupting for.
function announce(event) {
  if (event.kind !== "incident.opened" && event.kind !== "incident.resolved") return;
  const incident = ui.state?.now?.incidents?.[event.detail];
  const headline = incident?.headline ?? event.detail;
  const text = event.kind === "incident.opened" ? `New incident: ${headline}` : `Recovered: ${headline}`;
  showToast(text);
  if (event.kind === "incident.opened") ui.selectedIncident = event.detail;
  if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("Overwatch", { body: text });
  }
}

// One line on what the monitor is doing, so quiet reads as "covered" rather than "idle".
function monitorSummary(s) {
  const envs = Object.values(s.monitor?.environments ?? {});
  if (!s.monitor?.running) return envs.length ? "Monitor paused" : "Monitor not started";
  const frozen = envs.filter((e) => e.frozen).length;
  const next = Math.min(...envs.map((e) => e.nextSweepAtMs ?? Infinity));
  const wait = Number.isFinite(next) ? Math.max(0, Math.round((next - Date.now()) / 1000)) : null;
  return [
    `Watching ${envs.length} environments`,
    frozen ? `${frozen} without coverage` : null,
    wait === null ? null : `next check in ${wait}s`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// The tightest absolute p95 limit watching an environment, for the chart's threshold line.
function p95Limit(s, env) {
  const limits = (s.insights?.watchRules ?? [])
    .filter(
      (r) =>
        r.enabled &&
        r.appId === env.appId &&
        r.envId === env.envId &&
        r.metric === "p95_latency_ms" &&
        r.operator !== "ratio_gt",
    )
    .map((r) => r.threshold);
  return limits.length ? Math.min(...limits) : "";
}

// Theme management
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("overwatch-theme", theme);
  $("#btn-theme").textContent = theme === "dark" ? "Light" : "Dark";
  if (ui.state) drawAllCharts();
}

function initTheme() {
  const saved = localStorage.getItem("overwatch-theme");
  applyTheme(saved === "dark" ? "dark" : "light");
}

function themeColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    bgSubtle: s.getPropertyValue("--bg-subtle").trim(),
    accent: s.getPropertyValue("--accent").trim(),
    critical: s.getPropertyValue("--status-critical").trim(),
    warn: s.getPropertyValue("--status-warn").trim(),
    healthy: s.getPropertyValue("--status-healthy").trim(),
    muted: s.getPropertyValue("--text-secondary").trim(),
    border: s.getPropertyValue("--border").trim(),
  };
}

function drawSparkline(canvas, points, threshold) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(120, Math.round(rect.width));
  const h = Math.max(40, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const c = themeColors();
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length === 0) return;

  const vals = points.map((p) => Number(p.p95LatencyMs || 0));
  const maxVal = Math.max(...vals, threshold || 1, 1);
  const padX = 4;
  const padY = 6;
  const plotW = w - padX * 2;
  const plotH = h - padY * 2;

  if (threshold) {
    const ty = padY + plotH * (1 - Math.min(1, threshold / maxVal));
    ctx.strokeStyle = c.warn;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, ty);
    ctx.lineTo(w - padX, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  const gap = 2;
  const barW = Math.max(2, (plotW - gap * (vals.length - 1)) / vals.length);
  vals.forEach((v, i) => {
    const bh = Math.max(3, (v / maxVal) * plotH);
    const x = padX + i * (barW + gap);
    const y = padY + plotH - bh;
    ctx.fillStyle = threshold && v > threshold ? c.critical : c.accent;
    ctx.fillRect(x, y, barW, bh);
  });
}

function drawLargeMetricChart(canvas, points, threshold) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(260, Math.round(rect.width));
  const h = Math.max(160, Math.round(rect.height));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const c = themeColors();
  ctx.clearRect(0, 0, w, h);
  if (!points || points.length < 2) return;

  const p95 = points.map((p) => Number(p.p95LatencyMs || 0));
  const p50 = points.map((p) => Number(p.p50LatencyMs || 0));
  const maxVal = Math.max(...p95, threshold || 100, 100) * 1.1;

  const padL = 48;
  const padR = 14;
  const padT = 16;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Gridlines
  ctx.font = "12px 'Plus Jakarta Sans', sans-serif";
  ctx.fillStyle = c.muted;
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (plotH * i) / 3;
    const val = Math.round(maxVal * (1 - i / 3));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(`${val}ms`, 4, y + 4);
  }

  // Baseline threshold line
  if (threshold) {
    const ty = padT + plotH * (1 - threshold / maxVal);
    ctx.strokeStyle = c.warn;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, ty);
    ctx.lineTo(w - padR, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.warn;
    ctx.fillText(`Rule ${threshold}ms`, padL + 6, Math.max(padT + 12, ty - 5));
  }

  const drawLine = (series, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    series.forEach((v, idx) => {
      const x = padL + (idx / (series.length - 1)) * plotW;
      const y = padT + plotH * (1 - v / maxVal);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawLine(p50, c.muted, 1.5);
  drawLine(p95, threshold && p95[p95.length - 1] > threshold ? c.critical : c.accent, 2.25);
}

function drawAllCharts() {
  document.querySelectorAll("canvas[data-spark-env]").forEach((canvas) => {
    const envKey = canvas.dataset.sparkEnv;
    const thresh = canvas.dataset.threshold ? Number(canvas.dataset.threshold) : undefined;
    const tel = ui.state?.telemetry?.[envKey];
    drawSparkline(canvas, tel?.metrics ?? [], thresh);
  });
  document.querySelectorAll("canvas[data-chart-env]").forEach((canvas) => {
    const envKey = canvas.dataset.chartEnv;
    const thresh = canvas.dataset.threshold ? Number(canvas.dataset.threshold) : undefined;
    const tel = ui.state?.telemetry?.[envKey];
    drawLargeMetricChart(canvas, tel?.metrics ?? [], thresh);
  });
}

function openEvidenceDrawer(evidenceId) {
  const blob = ui.state?.evidence?.[evidenceId];
  const backdrop = $("#evidence-backdrop");
  const body = $("#drawer-body");
  if (!blob) {
    showToast(`Evidence ${evidenceId} not found`);
    return;
  }
  $("#drawer-title").textContent = blob.title;

  let traceHtml = "";
  if (blob.traceDiff && blob.traceDiff.spans?.length) {
    const td = blob.traceDiff;
    traceHtml = `
      <div class="section">
        <h3 class="section-heading">Paired trace diff (${esc(td.route)})</h3>
        <p class="row-meta">Release <span class="mono">${esc(td.releaseVersion)}</span> · Slow avg ${td.slowTotalMs}ms vs Median avg ${td.medianTotalMs}ms</p>
        <div class="table-wrap" style="margin-top:10px">
          <table class="data-table">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Slow / Median</th>
                <th>Delta</th>
                <th>Calls</th>
              </tr>
            </thead>
            <tbody>
              ${td.spans
                .map(
                  (sp) => `
                <tr>
                  <td>
                    <div class="mono">${esc(sp.operation)}</div>
                    <div class="row-meta mono">${esc(sp.resource)}</div>
                  </td>
                  <td>${sp.slowAvgMs}ms / ${sp.medianAvgMs}ms</td>
                  <td class="${sp.deltaMs > 200 ? "tone-critical" : ""}">+${sp.deltaMs}ms</td>
                  <td>${sp.slowCallCount}x vs ${sp.medianCallCount}x${sp.nPlusOneSuspect ? " (N+1)" : ""}</td>
                </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  body.innerHTML = `
    <p class="row-meta">
      <span class="mono">${esc(blob.evidenceId)}</span> · Source: ${esc(blob.source)} · ${esc(blob.envKey)} · Captured ${fmtAgo(blob.capturedAtMs)}
    </p>
    <div class="diff-block">${esc(blob.query)}</div>
    <p class="bullet-text">${esc(blob.excerpt)}</p>
    <p style="margin-top:14px">
      <a href="${esc(blob.deepLink)}" target="_blank" rel="noopener noreferrer">Open source deep-link</a>
    </p>
    ${traceHtml}
  `;

  backdrop.classList.remove("hidden");
  backdrop.setAttribute("aria-hidden", "false");
}

function closeEvidenceDrawer() {
  const backdrop = $("#evidence-backdrop");
  backdrop.classList.add("hidden");
  backdrop.setAttribute("aria-hidden", "true");
}

async function copyHandoff(sessionId, mode) {
  const res = await fetch(`/api/handoff/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return;
  const desc = await res.json();
  if (mode === "desktop") {
    window.location.href = desc.desktopDeepLink;
    showToast(`Opening OpenCode Desktop for ${sessionId}`);
  } else {
    await navigator.clipboard?.writeText(desc.cliCommand).catch(() => {});
    showToast(`Copied CLI handoff: ${desc.cliCommand}`);
  }
}

function renderNowView() {
  const s = ui.state;
  const pendingAsks = s.needsMe?.pending ?? [];
  const incidents = Object.values(s.now?.incidents ?? {});
  const envs = Object.values(s.now?.environments ?? {}).filter(
    (e) => ui.teamFilter === "all" || e.tags?.team === ui.teamFilter,
  );
  const openIncidentEnvs = new Set(
    incidents
      .filter((i) => i.status !== "resolved" && i.status !== "dismissed")
      .map((i) => `${i.appId}:${i.envId}`),
  );

  const needsMeSection =
    pendingAsks.length > 0
      ? `
      <section class="section">
        <div class="section-bar">
          <h2 class="section-heading">Needs your decision</h2>
          <span class="row-meta">${pendingAsks.length} waiting for operator sign-off</span>
        </div>
        ${pendingAsks
          .map(
            (ask) => `
          <div class="ask-row">
            <div class="ask-copy">
              <p class="ask-question">${esc(ask.question)}</p>
              <p class="ask-why">${esc(ask.whyItMatters)}</p>
            </div>
            <div class="ask-actions">
              ${ask.options
                .map((opt) => {
                  const isRec = opt.id === ask.recommendedOptionId;
                  return `<button
                    type="button"
                    class="${isRec ? "btn-primary" : "control-subtle"}"
                    data-answer-ask="${esc(ask.askId)}"
                    data-option="${esc(opt.id)}"
                  >${esc(opt.label)}</button>`;
                })
                .join("")}
            </div>
          </div>`,
          )
          .join("")}
      </section>`
      : "";

  const incRows =
    incidents.length === 0
      ? `<div class="list-row"><span class="row-meta">No active incidents. All monitored rules are within baseline.</span></div>`
      : incidents
          .map(
            (inc) => `
        <div class="list-row clickable" data-open-incident="${esc(inc.incidentId)}">
          <div class="row-main">
            <span class="severity-bar sev-${esc(inc.severity)}" aria-hidden="true"></span>
            <div>
              <p class="row-title">${esc(inc.headline)}</p>
              <p class="row-meta">
                <span class="mono">${esc(inc.incidentId)}</span> · ${esc(inc.appId)}/${esc(inc.envId)} · ${inc.signalCount} correlated signals · recovery ${inc.recoveryCleanWindows}/${inc.recoveryTargetK} clean windows${inc.commitSha ? ` · commit <span class="mono">${esc(inc.commitSha)}</span>` : ""}
              </p>
            </div>
          </div>
          <span class="status-text ${inc.status === "resolved" ? "tone-healthy" : inc.severity === "page" ? "tone-critical" : "tone-warn"}">${esc(inc.status)}</span>
        </div>`,
          )
          .join("");

  const envTiles = envs
    .map((env) => {
      const tel = s.telemetry?.[env.envKey];
      const latest = tel?.metrics?.[tel.metrics.length - 1];
      const degraded = env.coverage !== "healthy";
      const hasInc = openIncidentEnvs.has(env.envKey);
      const statText = degraded
        ? `Coverage: ${env.coverage}`
        : latest
          ? `p95 ${Math.round(latest.p95LatencyMs)} ms · ${latest.errorRatePct}% err`
          : "Healthy";
      const statTone = degraded
        ? "tone-warn"
        : hasInc
          ? "tone-critical"
          : "tone-healthy";
      const thresh = p95Limit(s, env);

      return `
        <article class="env-tile ${degraded ? "degraded" : hasInc ? "incident-active" : ""}" data-open-env="${esc(env.envKey)}">
          <div class="env-tile-head">
            <h3 class="env-tile-name">${esc(env.displayName)}</h3>
            <span class="env-tile-stat ${statTone}">${esc(statText)}</span>
          </div>
          <canvas class="sparkline-canvas" data-spark-env="${esc(env.envKey)}" data-threshold="${thresh}"></canvas>
          <p class="env-tile-foot">${esc(env.coverageDetail)} · ${fmtAgo(env.lastCollectedAtMs)}</p>
        </article>
      `;
    })
    .join("");

  return `
    ${needsMeSection}

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Active incidents</h2>
        <span class="row-meta">${incidents.filter((i) => i.status !== "resolved" && i.status !== "dismissed").length} open</span>
      </div>
      <div class="sheet">${incRows}</div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Fleet health</h2>
        <div class="segmented" role="group" aria-label="Filter by team">
          ${["all", "payments", "platform"]
            .map(
              (team) => `
            <button
              type="button"
              class="segmented-item"
              data-team-filter="${team}"
              aria-pressed="${ui.teamFilter === team}"
            >${team === "all" ? "All teams" : team.charAt(0).toUpperCase() + team.slice(1)}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div class="fleet-grid">${envTiles}</div>
    </section>
  `;
}

function renderEnvironmentsView() {
  const s = ui.state;
  const envs = Object.values(s.now?.environments ?? {});
  const env = s.now?.environments?.[ui.selectedEnv] ?? envs[0];
  const tel = env ? s.telemetry?.[env.envKey] : null;

  const envSelector = `
    <div class="segmented" role="group" aria-label="Select environment">
      ${envs
        .map(
          (e) => `
        <button
          type="button"
          class="segmented-item"
          data-select-env="${esc(e.envKey)}"
          aria-pressed="${env?.envKey === e.envKey}"
        >${esc(e.displayName)}</button>`,
        )
        .join("")}
    </div>
  `;

  if (!env || !tel) {
    return `<div class="view-header"><h1 class="view-title">Environments</h1></div><p class="row-meta">No telemetry loaded.</p>`;
  }

  const remediation =
    tel.coverage !== "healthy" && tel.remediation
      ? `<div class="remediation-banner"><strong>Coverage degraded (${esc(tel.coverage)}):</strong> ${esc(tel.remediation)} Anomaly detectors are frozen until credentials recover.</div>`
      : "";

  const utilBar = (used, req, lim, unit) => {
    const denom = Math.max(lim, used, 1);
    const fillPct = Math.min(100, Math.round((used / denom) * 100));
    const reqPct = Math.min(98, Math.round((req / denom) * 100));
    const color =
      fillPct >= 85
        ? "var(--status-critical)"
        : fillPct >= 65
          ? "var(--status-warn)"
          : "var(--accent)";
    return `
      <div class="util-wrap">
        <span class="row-meta">${used}${unit} / ${req}${unit} req / ${lim}${unit} lim</span>
        <div class="util-track">
          <div class="util-fill" style="width:${fillPct}%;background:${color}"></div>
          <div class="util-req-mark" style="left:${reqPct}%"></div>
        </div>
      </div>
    `;
  };

  const podRows =
    tel.pods.length === 0
      ? `<tr><td colspan="5" class="row-meta">No pod snapshots reported for this environment.</td></tr>`
      : tel.pods
          .map(
            (pod) => `
        <tr>
          <td>
            <div class="mono">${esc(pod.name)}</div>
            <div class="row-meta">${esc(pod.nodeName)}</div>
          </td>
          <td>
            <span class="cell-status ${pod.track === "new" ? "accent" : "healthy"}">${esc(pod.revision)} (${esc(pod.track)})</span>
            <div class="row-meta mono">${esc(pod.imageTag)}</div>
          </td>
          <td>
            <span class="cell-status ${pod.restarts > 0 ? "critical" : "healthy"}">${esc(pod.ready)} · ${pod.restarts} restarts</span>
            ${pod.lastTerminationReason ? `<div class="row-meta tone-critical">${esc(pod.lastTerminationReason)}</div>` : ""}
          </td>
          <td>${utilBar(pod.cpuMillicores, pod.cpuRequestMillicores, pod.cpuLimitMillicores, "m")}</td>
          <td>${utilBar(pod.memoryMiB, pod.memoryRequestMiB, pod.memoryLimitMiB, " MiB")}</td>
        </tr>`,
          )
          .join("");

  const buildRows =
    tel.builds.length === 0
      ? `<div class="list-row"><span class="row-meta">No recent Jenkins builds linked.</span></div>`
      : tel.builds
          .map(
            (b) => `
        <div class="list-row">
          <div>
            <p class="row-title">Build #${b.buildNumber} · <span class="mono">${esc(b.commitSha)}</span></p>
            <p class="row-meta">${esc(b.commitMessage)} · by ${esc(b.author)} · ${Math.round(b.durationMs / 1000)}s · ${fmtAgo(b.timestampMs)}</p>
          </div>
          <span class="cell-status ${b.result === "SUCCESS" ? "healthy" : "critical"}">${esc(b.result)}</span>
        </div>`,
          )
          .join("");

  const thresh = p95Limit(s, env);
  const mon = s.monitor?.environments?.[env.envKey];
  const monitorLine = mon
    ? `${esc(mon.lastOutcome)} · checked every ${mon.cadenceSeconds}s`
    : "Not checked yet";
  const demoControls =
    s.mode === "demo" && tel.coverage === "healthy"
      ? `<button type="button" class="control-subtle" data-simulate="regression" data-env="${esc(env.envKey)}">Simulate regression</button>
         <button type="button" class="control-subtle" data-simulate="recovery" data-env="${esc(env.envKey)}">Simulate recovery</button>`
      : "";

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">${esc(env.displayName)}</h1>
        <p class="view-subtitle">${esc(tel.coverageDetail)} · Sampled ${fmtAgo(tel.sampledAtMs)}</p>
        <p class="row-meta">Monitor: ${monitorLine}</p>
      </div>
      <div class="action-row">
        ${demoControls}
        <button type="button" class="btn-primary" data-collect-env="${esc(env.envKey)}">Collect environment</button>
      </div>
    </div>

    <div class="section">${envSelector}</div>
    ${remediation}

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Latency trend (p95 vs p50)</h2>
        <span class="row-meta">Rollout Watch pins pre-deploy 30m baseline</span>
      </div>
      <div class="sheet sheet-padded">
        <canvas class="chart-canvas-lg" data-chart-env="${esc(env.envKey)}" data-threshold="${thresh}"></canvas>
      </div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Workload and revision matrix</h2>
        <span class="row-meta">${tel.pods.length} pods across ReplicaSets</span>
      </div>
      <div class="sheet table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Pod</th>
              <th>Revision</th>
              <th>Readiness</th>
              <th>CPU usage / request / limit</th>
              <th>Memory usage / request / limit</th>
            </tr>
          </thead>
          <tbody>${podRows}</tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Jenkins build history</h2>
      </div>
      <div class="sheet">${buildRows}</div>
    </section>
  `;
}

function renderIncidentsView() {
  const s = ui.state;
  const incidents = Object.values(s.now?.incidents ?? {});
  const inc = s.incidentDetails?.[ui.selectedIncident] ?? Object.values(s.incidentDetails ?? {})[0];
  if (!inc) {
    return `<div class="view-header"><h1 class="view-title">Incidents</h1></div><p class="row-meta">No incidents recorded yet.</p>`;
  }

  const actions = Object.values(s.now?.actions ?? {}).filter((a) => a.incidentId === inc.incidentId);
  const runs = (s.runs?.runs ?? []).filter((r) => inc.linkedRunIds?.includes(r.runId));
  const primarySession = runs[0]?.sessionId ?? "ses_overwatch_fix_42";

  const selector =
    incidents.length > 1
      ? `<div class="section"><div class="segmented">${incidents
          .map(
            (i) => `
          <button type="button" class="segmented-item" data-select-inc="${esc(i.incidentId)}" aria-pressed="${i.incidentId === inc.incidentId}">
            ${esc(i.incidentId)} · ${esc(i.status)}
          </button>`,
          )
          .join("")}</div></div>`
      : "";

  const understandingHtml =
    inc.understanding.length === 0
      ? `<p class="row-meta">Triage agent has not posted an understanding yet.</p>`
      : `<ul class="bullet-list">${inc.understanding
          .map(
            (b) => `
        <li class="bullet-item">
          <p class="bullet-text">${esc(b.text)}</p>
          <div class="evidence-links">
            ${b.evidenceIds
              .map(
                (evId) =>
                  `<button type="button" class="evidence-link" data-open-evidence="${esc(evId)}">${esc(evId)}</button>`,
              )
              .join("")}
          </div>
        </li>`,
          )
          .join("")}</ul>`;

  const verifyHtml =
    inc.verificationBundles.length === 0
      ? `<p class="row-meta">No local worktree verification bundles yet.</p>`
      : inc.verificationBundles
          .map(
            (vb) => `
        <div class="bullet-item">
          <p class="bullet-text"><strong>${vb.reproducedLocally ? "Reproduced and verified locally" : "Partially verified"}</strong> · ${esc(vb.beforeAfterSummary)}</p>
          <p class="row-meta mono">${esc(vb.commandsRun.join(" && "))} · ${esc(vb.diffStat)}</p>
          ${vb.branch ? `<p class="row-meta">Branch <span class="mono">${esc(vb.branch)}</span></p>` : ""}
        </div>`,
          )
          .join("");

  const actionHtml =
    actions.length === 0
      ? `<p class="row-meta">No outward GitHub actions requested yet.</p>`
      : actions
          .map(
            (a) => `
        <div class="bullet-item">
          <p class="bullet-text"><strong>${esc(a.kind)}</strong> · ${esc(a.title)} (${esc(a.status)})</p>
          ${a.artifactUrl ? `<p class="row-meta"><a href="${esc(a.artifactUrl)}" target="_blank" rel="noopener noreferrer">${esc(a.artifactUrl)}</a>${a.reconciled ? " (reconciled without duplicate)" : ""}</p>` : ""}
        </div>`,
          )
          .join("");

  const chatHtml = inc.chat
    .map(
      (m) => `
      <div class="chat-msg ${m.author === "operator" ? "operator" : ""}">
        <div class="chat-author">${m.author === "operator" ? "You" : "Overwatch agent"} · ${esc(m.delivery)}</div>
        <p class="chat-text">${esc(m.text)}</p>
        ${
          m.evidenceIds?.length
            ? `<div class="evidence-links">${m.evidenceIds
                .map(
                  (id) =>
                    `<button type="button" class="evidence-link" data-open-evidence="${esc(id)}">${esc(id)}</button>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>`,
    )
    .join("");

  return `
    ${selector}
    <div class="view-header">
      <div>
        <h1 class="view-title">${esc(inc.headline)}</h1>
        <p class="view-subtitle">
          <span class="mono">${esc(inc.incidentId)}</span> · ${esc(inc.appId)}/${esc(inc.envId)} · Status: <strong>${esc(inc.status)}</strong> · Recovery guard: ${inc.recoveryCleanWindows}/${inc.recoveryTargetK} clean windows${inc.commitSha ? ` · Build commit <span class="mono">${esc(inc.commitSha)}</span>` : ""}
        </p>
      </div>
      <button type="button" class="btn-primary" data-prepare-fix="${esc(inc.incidentId)}">Prepare fix</button>
    </div>

    <div class="section action-strip">
      <button type="button" class="control-subtle" data-handoff-cli="${esc(primarySession)}">Copy OpenCode CLI handoff</button>
      <button type="button" class="control-subtle" data-handoff-desktop="${esc(primarySession)}">Open in OpenCode Desktop</button>
      <button type="button" class="control-subtle" data-create-issue="${esc(inc.incidentId)}">Create GitHub issue</button>
      <button type="button" class="control-subtle" data-draft-stakeholder="${esc(inc.incidentId)}">Draft 60-word update</button>
      ${
        inc.status === "investigating" || inc.status === "mitigating"
          ? `<button type="button" class="control-subtle" data-enter-watching="${esc(inc.incidentId)}">Enter watching</button>`
          : ""
      }
      ${
        inc.status === "watching"
          ? `<button type="button" class="control-subtle" data-clean-window="${esc(inc.incidentId)}">Record clean window (${inc.recoveryCleanWindows}/${inc.recoveryTargetK})</button>`
          : ""
      }
      ${
        inc.status !== "resolved" && inc.status !== "dismissed"
          ? `<button type="button" class="btn-danger" data-dismiss-inc="${esc(inc.incidentId)}">Dismiss</button>`
          : ""
      }
    </div>

    <div class="split-grid">
      <div>
        <section class="section">
          <div class="section-bar">
            <h2 class="section-heading">Current understanding</h2>
            <div class="action-strip">
              <button type="button" class="control-subtle" data-feedback-inc="${esc(inc.incidentId)}" data-vote="up" data-reason="accurate">Helpful</button>
              <button type="button" class="control-subtle" data-feedback-inc="${esc(inc.incidentId)}" data-vote="down" data-reason="wrong_cause">Wrong cause</button>
            </div>
          </div>
          <div class="sheet sheet-padded">${understandingHtml}</div>
        </section>

        <section class="section">
          <div class="section-bar">
            <h2 class="section-heading">Local verification and GitHub actions</h2>
          </div>
          <div class="sheet sheet-padded">
            ${verifyHtml}
            ${actionHtml}
          </div>
        </section>
      </div>

      <section class="section">
        <div class="section-bar">
          <h2 class="section-heading">Steer investigation</h2>
          <span class="row-meta mono">${esc(primarySession)}</span>
        </div>
        <div class="sheet sheet-padded">
          <div class="chat-feed">${chatHtml}</div>
          <form class="chat-form" id="incident-chat-form" data-incident-id="${esc(inc.incidentId)}">
            <input
              type="text"
              class="text-input"
              id="incident-chat-input"
              placeholder="Ask about pod revisions, rollback safety, or spans..."
              required
            />
            <button type="submit" class="btn-primary">Send</button>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderInsightsView() {
  const s = ui.state;
  const insights = s.insights?.insights ?? [];
  const rules = s.insights?.watchRules ?? [];
  const frontier = s.frontier ?? [];

  const insightRows =
    insights.length === 0
      ? `<div class="list-row"><span class="row-meta">No proactive insights yet. Trigger a trace walk to explore routes.</span></div>`
      : insights
          .map(
            (ins) => `
        <div class="list-row">
          <div style="flex:1;min-width:260px">
            <p class="row-title">${esc(ins.claim)}</p>
            <p class="row-meta">${esc(ins.whyItMatters)}</p>
            <p class="row-meta">${esc(ins.appId)}/${esc(ins.envId)} · ${esc(ins.sourceMode)} · recurred ${ins.recurrenceCount}x · status: <strong>${esc(ins.status)}</strong></p>
            <div class="evidence-links">
              ${ins.evidenceIds
                .map(
                  (id) =>
                    `<button type="button" class="evidence-link" data-open-evidence="${esc(id)}">${esc(id)}</button>`,
                )
                .join("")}
            </div>
          </div>
          <div class="action-strip">
            ${
              ins.status === "active"
                ? `
              <button type="button" class="btn-primary" data-watch-insight="${esc(ins.insightId)}">Watch</button>
              <button type="button" class="control-subtle" data-promote-insight="${esc(ins.insightId)}">Promote</button>
              <button type="button" class="control-subtle" data-dismiss-insight="${esc(ins.insightId)}">Dismiss</button>
            `
                : `<span class="cell-status healthy">${esc(ins.status)}</span>`
            }
          </div>
        </div>`,
          )
          .join("");

  const ruleRows = rules
    .map(
      (r) => `
      <tr>
        <td>${esc(r.name)}</td>
        <td class="mono">${esc(r.appId)}/${esc(r.envId)}</td>
        <td class="mono">${esc(r.metric)} ${esc(r.operator)} ${r.threshold}</td>
        <td><span class="cell-status ${r.severity === "page" ? "critical" : "warn"}">${esc(r.severity)}</span></td>
      </tr>`,
    )
    .join("");

  const frontierRows = frontier
    .map(
      (f) => `
      <tr>
        <td class="mono">${esc(f.envKey)}</td>
        <td class="mono">${esc(f.route)}</td>
        <td>${f.priorityScore}</td>
        <td>${esc(f.lastOutcome)}</td>
        <td>${fmtAgo(f.lastExploredMs)}</td>
      </tr>`,
    )
    .join("");

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">Proactive insights</h1>
        <p class="view-subtitle">Findings from budgeted trace random walks, resource drift checks, and overnight wake rollups.</p>
      </div>
      <div class="action-strip">
        <button type="button" class="control-subtle" id="btn-sim-wake">Simulate overnight wake</button>
        <button type="button" class="btn-primary" id="btn-trace-walk">Run trace walk</button>
      </div>
    </div>

    <section class="section">
      <div class="sheet">${insightRows}</div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Standing watch rules</h2>
        <span class="row-meta">${rules.length} active detectors</span>
      </div>
      <div class="sheet table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Scope</th>
              <th>Condition</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>${ruleRows || '<tr><td colspan="4" class="row-meta">No watch rules configured.</td></tr>'}</tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Exploration frontier</h2>
      </div>
      <div class="sheet table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Environment</th>
              <th>Route</th>
              <th>Priority score</th>
              <th>Last outcome</th>
              <th>Explored</th>
            </tr>
          </thead>
          <tbody>${frontierRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderRunsView() {
  const runs = ui.state?.runs?.runs ?? [];
  const rows = runs
    .map(
      (r) => `
      <tr>
        <td>
          <div class="mono">${esc(r.runId)}</div>
          <div class="row-meta">${esc(r.role)} · trigger: ${esc(r.trigger)}</div>
        </td>
        <td class="mono">${esc(r.appId)}/${esc(r.envId)}</td>
        <td class="mono">${esc(r.model)}</td>
        <td><span class="cell-status ${r.status === "completed" ? "healthy" : r.status === "running" ? "accent" : "warn"}">${esc(r.status)}</span></td>
        <td>${Math.round(r.awakeElapsedMs / 1000)}s / ${Math.round(r.maxAwakeMs / 1000)}s awake</td>
        <td>${r.totalToolCalls} calls · $${r.spentUsd.toFixed(2)} / $${r.maxUsd.toFixed(2)}</td>
        <td>${r.judgeScore !== undefined ? `${r.judgeScore}/100` : "Pending"}</td>
        <td>
          ${
            r.sessionId
              ? `<button type="button" class="control-subtle" data-handoff-cli="${esc(r.sessionId)}">Copy CLI</button>`
              : ""
          }
        </td>
      </tr>`,
    )
    .join("");

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">Agent runs and sessions</h1>
        <p class="view-subtitle">Awake-time budgets, connector call caps, cost audit, and OpenCode session handoff.</p>
      </div>
    </div>

    <section class="section">
      <div class="sheet table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Scope</th>
              <th>Model</th>
              <th>Status</th>
              <th>Awake budget</th>
              <th>Cost and tools</th>
              <th>Judge</th>
              <th>Handoff</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="row-meta">No runs recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderScorecardView() {
  const s = ui.state;
  const sc = s.scorecard;
  const briefs = s.briefs?.briefs ?? [];
  const proposals = sc?.proposals ?? [];
  const verdicts = sc?.verdicts ?? [];

  const propHtml =
    proposals.length === 0
      ? `<div class="list-row"><span class="row-meta">No weekly proposals awaiting review.</span></div>`
      : proposals
          .map(
            (p) => `
        <div class="list-row" style="display:block">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>
              <p class="row-title">${esc(p.title)}</p>
              <p class="row-meta mono">${esc(p.targetPath)} · Replay score ${p.beforeReplayScore} -> ${p.afterReplayScore}</p>
            </div>
            <div class="action-strip">
              ${
                p.status === "pending"
                  ? `
                <button type="button" class="btn-primary" data-proposal-decide="${esc(p.proposalId)}" data-status="approved">Approve diff</button>
                <button type="button" class="control-subtle" data-proposal-decide="${esc(p.proposalId)}" data-status="rejected">Reject</button>
              `
                  : `<span class="cell-status ${p.status === "approved" ? "healthy" : "warn"}">${esc(p.status)}</span>`
              }
            </div>
          </div>
          <p class="row-meta" style="margin-top:8px">${esc(p.rationale)}</p>
          <pre class="diff-block">${esc(p.diffPreview)}</pre>
        </div>`,
          )
          .join("");

  const briefHtml =
    briefs.length === 0
      ? `<div class="list-row"><span class="row-meta">No team briefs drafted yet.</span></div>`
      : briefs
          .map(
            (b) => `
        <div class="list-row" style="display:block">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div>
              <p class="row-title">${esc(b.subject)}</p>
              <p class="row-meta">${esc(b.kind)} · To: ${esc(b.recipients.join(", "))} · Edit distance: ${b.editDistanceChars} chars · Status: <strong>${esc(b.status)}</strong></p>
            </div>
            <div class="action-strip">
              <button type="button" class="control-subtle" data-copy-brief="${esc(b.briefId)}">Copy</button>
              ${
                b.status !== "sent"
                  ? `<button type="button" class="btn-primary" data-send-brief="${esc(b.briefId)}">Approve and send</button>`
                  : `<span class="cell-status healthy">Sent</span>`
              }
            </div>
          </div>
          <textarea class="text-area" style="margin-top:10px" id="brief-editor-${esc(b.briefId)}" data-brief-editor="${esc(b.briefId)}">${esc(b.body)}</textarea>
          <div style="margin-top:8px">
            <button type="button" class="control-subtle" data-save-brief-edit="${esc(b.briefId)}">Save edit diff</button>
          </div>
        </div>`,
          )
          .join("");

  const verdictRows = verdicts
    .map(
      (v) => `
      <tr>
        <td class="mono">${esc(v.runId)}</td>
        <td class="mono">${esc(v.judgeModel)}</td>
        <td>${v.score}/100</td>
        <td>${v.grounded ? "Grounded" : "Ungrounded"} · ${v.concise ? "Concise" : "Verbose"} · ${v.scopeDisciplined ? "Scoped" : "Drift"}</td>
        <td><span class="cell-status ${v.operatorAgreed === false ? "warn" : "healthy"}">${v.operatorAgreed === false ? "Disagreed" : "Agreed"}</span></td>
      </tr>`,
    )
    .join("");

  return `
    <div class="view-header">
      <div>
        <h1 class="view-title">Scorecard and team briefs</h1>
        <p class="view-subtitle">Cross-model judge calibration, replay-verified playbook diffs, and stakeholder communication.</p>
      </div>
      <div class="action-strip">
        <button type="button" class="control-subtle" data-draft-brief="daily_digest_tech">Draft technical digest</button>
        <button type="button" class="btn-primary" data-draft-brief="daily_digest_exec">Draft executive brief</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi-cell">
        <p class="kpi-label">Judge calibration agreement</p>
        <p class="kpi-value tone-healthy">${sc.calibrationAgreementPct}%</p>
      </div>
      <div class="kpi-cell">
        <p class="kpi-label">Operator ratings</p>
        <p class="kpi-value">${sc.feedbackUp} up / ${sc.feedbackDown} down</p>
      </div>
      <div class="kpi-cell">
        <p class="kpi-label">Signal precision</p>
        <p class="kpi-value">${sc.incidentsOpened} opened / ${sc.incidentsDismissed} dismissed</p>
      </div>
      <div class="kpi-cell">
        <p class="kpi-label">Wake sweeps recorded</p>
        <p class="kpi-value">${s.now?.wakeCount ?? 0}</p>
      </div>
    </div>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Weekly improvement proposals</h2>
      </div>
      <div class="sheet">${propHtml}</div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Drafted team briefs</h2>
      </div>
      <div class="sheet">${briefHtml}</div>
    </section>

    <section class="section">
      <div class="section-bar">
        <h2 class="section-heading">Cross-model judge verdicts</h2>
      </div>
      <div class="sheet table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Judge model</th>
              <th>Score</th>
              <th>Rubric checks</th>
              <th>Calibration</th>
            </tr>
          </thead>
          <tbody>${verdictRows || '<tr><td colspan="5" class="row-meta">No judge verdicts recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    </section>
  `;
}

function render() {
  if (!ui.state) return;
  const s = ui.state;

  // Update header nav state & counters
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.view === ui.view));
  });

  const openIncCount = Object.values(s.now?.incidents ?? {}).filter(
    (i) => i.status !== "resolved" && i.status !== "dismissed",
  ).length;
  $("#nav-incident-count").textContent = openIncCount > 0 ? `(${openIncCount})` : "";
  const activeIns = (s.insights?.insights ?? []).filter((i) => i.status === "active").length;
  $("#nav-insight-count").textContent = activeIns > 0 ? `(${activeIns})` : "";
  $("#spend-readout").textContent = `$${(s.now?.dailySpendUsd ?? 0).toFixed(2)} / $${s.dailyUsdCap ?? 15} daily`;
  $("#status-meta").textContent = `${monitorSummary(s)} · ${s.mode} mode`;

  const workspace = $("#workspace");
  // Telemetry refreshes re-render in the background; a half-typed message must survive that.
  const active = document.activeElement;
  const typing =
    active && workspace.contains(active) && active.id && "value" in active
      ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
  const scrollY = window.scrollY;
  if (ui.view === "now") workspace.innerHTML = renderNowView();
  else if (ui.view === "environments") workspace.innerHTML = renderEnvironmentsView();
  else if (ui.view === "incidents") workspace.innerHTML = renderIncidentsView();
  else if (ui.view === "insights") workspace.innerHTML = renderInsightsView();
  else if (ui.view === "runs") workspace.innerHTML = renderRunsView();
  else workspace.innerHTML = renderScorecardView();

  if (typing) {
    const restored = document.getElementById(typing.id);
    if (restored && "value" in restored) {
      restored.value = typing.value;
      restored.focus({ preventScroll: true });
      try {
        restored.setSelectionRange(typing.start, typing.end);
      } catch {
        // not a text control
      }
    }
  }
  window.scrollTo({ top: scrollY });

  requestAnimationFrame(drawAllCharts);
}

// Command Palette (Cmd+K)
function paletteCommands() {
  const cmds = [
    { label: "Go to Now cockpit", meta: "View", run: () => switchView("now") },
    { label: "Go to Environments", meta: "View", run: () => switchView("environments") },
    { label: "Go to Incidents", meta: "View", run: () => switchView("incidents") },
    { label: "Go to Insights", meta: "View", run: () => switchView("insights") },
    { label: "Go to Runs", meta: "View", run: () => switchView("runs") },
    { label: "Go to Scorecard and Briefs", meta: "View", run: () => switchView("scorecard") },
    {
      label: "Collect fresh telemetry across fleet",
      meta: "Intent",
      run: () => sendIntent("collect", {}, "Collected fresh telemetry"),
    },
    {
      label: "Run exploratory trace walk",
      meta: "Intent",
      run: () => sendIntent("trace-walk", {}, "Trace walk completed"),
    },
    {
      label: "Simulate overnight laptop wake sweep",
      meta: "Intent",
      run: () => sendIntent("simulate-wake", { gapMinutes: 540 }, "Overnight wake sweep recorded"),
    },
  ];
  for (const env of Object.values(ui.state?.now?.environments ?? {})) {
    cmds.push({
      label: `Inspect ${env.displayName}`,
      meta: "Environment",
      run: () => {
        ui.selectedEnv = env.envKey;
        switchView("environments");
      },
    });
  }
  return cmds;
}

function renderPalette() {
  const q = ($("#palette-input").value || "").trim().toLowerCase();
  const list = paletteCommands().filter((c) => c.label.toLowerCase().includes(q));
  ui.paletteIndex = Math.min(ui.paletteIndex, Math.max(0, list.length - 1));
  const container = $("#palette-list");
  container.innerHTML = list
    .map(
      (c, i) => `
      <button type="button" class="palette-item" data-palette-idx="${i}" aria-selected="${i === ui.paletteIndex}">
        <span>${esc(c.label)}</span>
        <span class="row-meta">${esc(c.meta)}</span>
      </button>`,
    )
    .join("");
  container._items = list;
}

function openPalette() {
  ui.paletteOpen = true;
  ui.paletteIndex = 0;
  const backdrop = $("#palette-backdrop");
  backdrop.classList.remove("hidden");
  backdrop.setAttribute("aria-hidden", "false");
  $("#palette-input").value = "";
  renderPalette();
  $("#palette-input").focus();
}

function closePalette() {
  ui.paletteOpen = false;
  const backdrop = $("#palette-backdrop");
  backdrop.classList.add("hidden");
  backdrop.setAttribute("aria-hidden", "true");
}

function switchView(view) {
  ui.view = view;
  window.history.replaceState(null, "", `#${view}`);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}

// Event delegation
document.addEventListener("click", (e) => {
  const target = e.target.closest("button, [data-open-incident], [data-open-env], a");
  if (!target) {
    if (e.target.id === "evidence-backdrop") closeEvidenceDrawer();
    if (e.target.id === "palette-backdrop") closePalette();
    return;
  }

  if (target.matches(".nav-tab")) {
    switchView(target.dataset.view);
    return;
  }
  if (target.id === "brand-link") {
    e.preventDefault();
    switchView("now");
    return;
  }
  if (target.id === "btn-theme") {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    return;
  }
  if (target.id === "btn-palette") {
    openPalette();
    return;
  }
  if (target.id === "drawer-close") {
    closeEvidenceDrawer();
    return;
  }
  if (target.id === "btn-collect-all") {
    void sendIntent("collect", {}, "Collected fresh telemetry across fleet");
    return;
  }
  if (target.dataset.simulate) {
    const regression = target.dataset.simulate === "regression";
    void sendIntent(
      regression ? "simulate-regression" : "simulate-recovery",
      { envKey: target.dataset.env },
      regression
        ? "Regression injected. The monitor opens an incident after two bad samples."
        : "Recovery injected. Open incidents resolve after consecutive clean windows.",
    );
    return;
  }
  if (target.id === "btn-trace-walk") {
    void sendIntent("trace-walk", {}, "Exploratory trace walk recorded a new insight");
    return;
  }
  if (target.id === "btn-sim-wake") {
    void sendIntent("simulate-wake", { gapMinutes: 540 }, "Overnight wake sweep recorded");
    return;
  }
  if (target.dataset.paletteIdx !== undefined) {
    const items = $("#palette-list")._items ?? [];
    const cmd = items[Number(target.dataset.paletteIdx)];
    closePalette();
    cmd?.run();
    return;
  }
  if (target.dataset.teamFilter) {
    ui.teamFilter = target.dataset.teamFilter;
    render();
    return;
  }
  if (target.dataset.openIncident) {
    ui.selectedIncident = target.dataset.openIncident;
    switchView("incidents");
    return;
  }
  if (target.dataset.selectInc) {
    ui.selectedIncident = target.dataset.selectInc;
    render();
    return;
  }
  if (target.dataset.openEnv) {
    ui.selectedEnv = target.dataset.openEnv;
    switchView("environments");
    return;
  }
  if (target.dataset.selectEnv) {
    ui.selectedEnv = target.dataset.selectEnv;
    render();
    return;
  }
  if (target.dataset.collectEnv) {
    void sendIntent("collect", { envKey: target.dataset.collectEnv }, `Collected ${target.dataset.collectEnv}`);
    return;
  }
  if (target.dataset.answerAsk) {
    void sendIntent(
      "answer-ask",
      { askId: target.dataset.answerAsk, selectedOptionId: target.dataset.option },
      `Recorded decision: ${target.dataset.option}`,
    );
    return;
  }
  if (target.dataset.openEvidence) {
    openEvidenceDrawer(target.dataset.openEvidence);
    return;
  }
  if (target.dataset.handoffCli) {
    void copyHandoff(target.dataset.handoffCli, "cli");
    return;
  }
  if (target.dataset.handoffDesktop) {
    void copyHandoff(target.dataset.handoffDesktop, "desktop");
    return;
  }
  if (target.dataset.prepareFix) {
    void sendIntent("prepare-fix", { incidentId: target.dataset.prepareFix }, "Prepared isolated worktree fix and queued Draft PR approval");
    return;
  }
  if (target.dataset.createIssue) {
    void sendIntent(
      "create-issue",
      { incidentId: target.dataset.createIssue, title: `Investigate ${target.dataset.createIssue}` },
      "Queued GitHub issue approval in Needs Me",
    );
    return;
  }
  if (target.dataset.draftStakeholder) {
    void sendIntent(
      "draft-brief",
      { kind: "stakeholder_update", incidentId: target.dataset.draftStakeholder },
      "Drafted 60-word stakeholder update in Scorecard",
    );
    return;
  }
  if (target.dataset.enterWatching) {
    void sendIntent("enter-watching", { incidentId: target.dataset.enterWatching }, "Incident moved to watching");
    return;
  }
  if (target.dataset.cleanWindow) {
    void sendIntent("record-clean-window", { incidentId: target.dataset.cleanWindow }, "Recorded healthy clean window");
    return;
  }
  if (target.dataset.dismissInc) {
    void sendIntent("dismiss-incident", { incidentId: target.dataset.dismissInc }, "Incident dismissed");
    return;
  }
  if (target.dataset.feedbackInc) {
    void sendIntent(
      "feedback",
      {
        incidentId: target.dataset.feedbackInc,
        vote: target.dataset.vote,
        reason: target.dataset.reason,
      },
      "Recorded operator feedback",
    );
    return;
  }
  if (target.dataset.watchInsight) {
    void sendIntent("watch-insight", { insightId: target.dataset.watchInsight }, "Promoted insight to standing WatchRule");
    return;
  }
  if (target.dataset.promoteInsight) {
    void sendIntent("promote-insight", { insightId: target.dataset.promoteInsight }, "Promoted insight to active Incident");
    return;
  }
  if (target.dataset.dismissInsight) {
    void sendIntent("dismiss-insight", { insightId: target.dataset.dismissInsight }, "Dismissed insight");
    return;
  }
  if (target.dataset.proposalDecide) {
    void sendIntent(
      "decide-proposal",
      { proposalId: target.dataset.proposalDecide, status: target.dataset.status },
      `Proposal marked ${target.dataset.status}`,
    );
    return;
  }
  if (target.dataset.draftBrief) {
    void sendIntent("draft-brief", { kind: target.dataset.draftBrief }, "Drafted new team brief");
    return;
  }
  if (target.dataset.copyBrief) {
    const editor = document.querySelector(`textarea[data-brief-editor="${target.dataset.copyBrief}"]`);
    if (editor) {
      void navigator.clipboard?.writeText(editor.value).catch(() => {});
      showToast("Copied brief text to clipboard");
    }
    return;
  }
  if (target.dataset.saveBriefEdit) {
    const editor = document.querySelector(`textarea[data-brief-editor="${target.dataset.saveBriefEdit}"]`);
    if (editor) {
      void sendIntent(
        "edit-brief",
        { briefId: target.dataset.saveBriefEdit, body: editor.value },
        "Saved brief edit and recorded diff distance",
      );
    }
    return;
  }
  if (target.dataset.sendBrief) {
    void sendIntent("send-brief", { briefId: target.dataset.sendBrief }, "Approved and queued brief delivery");
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id === "incident-chat-form") {
    e.preventDefault();
    const input = $("#incident-chat-input");
    const text = input.value.trim();
    if (!text) return;
    const incidentId = e.target.dataset.incidentId;
    input.value = "";
    void sendIntent("incident-chat", { incidentId, text }, "Sent to the investigation");
  }
});

$("#palette-input").addEventListener("input", () => {
  ui.paletteIndex = 0;
  renderPalette();
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (ui.paletteOpen) closePalette();
    else openPalette();
    return;
  }
  if (e.key === "Escape") {
    if (ui.paletteOpen) closePalette();
    closeEvidenceDrawer();
    return;
  }
  if (ui.paletteOpen) {
    const items = $("#palette-list")._items ?? [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ui.paletteIndex = (ui.paletteIndex + 1) % Math.max(1, items.length);
      renderPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      ui.paletteIndex = (ui.paletteIndex - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
      renderPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = items[ui.paletteIndex];
      closePalette();
      cmd?.run();
    }
  }
});

window.addEventListener("scroll", () => {
  $("#topbar").classList.toggle("scrolled", window.scrollY > 4);
});

window.addEventListener("resize", () => {
  if (ui.state) drawAllCharts();
});

// Boot from URL hash if provided
const initialHash = window.location.hash.replace(/^#/, "");
if (["now", "environments", "incidents", "insights", "runs", "scorecard"].includes(initialHash)) {
  ui.view = initialHash;
}

initTheme();
const noSse = new URLSearchParams(window.location.search).get("nosse") === "1";
void fetchState().then(() => {
  if (!noSse) connectStream();
});
