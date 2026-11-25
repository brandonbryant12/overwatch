#![forbid(unsafe_code)]

//! Overwatch Native GPU Command Center built on Anomaly Rune (`anomalyco/rune`).
//! Zero business logic lives here: every metric, incident, ask, insight, and action
//! is hydrated from the Bun daemon (`OVERWATCH_API_URL`) and mutated via typed intents.
//!
//! Run live:      `cargo run -p overwatch-app`
//! Headless snap: `cargo run -p overwatch-app -- --snap shot.png --scene now`

use overwatch_client::{ClientConfig, OverwatchClient, demo_fallback_snapshot};
use overwatch_protocol::FullStateSnapshot;
use overwatch_viz::{Palette, palette, sparkline, utilization_bar};
use rune::tok::{TextStyle, motion};

const TYPE_BRAND: TextStyle = TextStyle::new(19.0, 700.0);
const TYPE_TITLE: TextStyle = TextStyle::new(18.0, 600.0);
const TYPE_BODY: TextStyle = TextStyle::new(15.0, 500.0);
const TYPE_SMALL: TextStyle = TextStyle::new(13.0, 450.0);
use rune::{Align, AppSpec, Color, Cx, El, ScrollSpec, col, el, row, text};
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Tab {
    Now,
    Environments,
    Incidents,
    Insights,
    Runs,
    Scorecard,
}

impl Tab {
    const ALL: [Tab; 6] = [
        Tab::Now,
        Tab::Environments,
        Tab::Incidents,
        Tab::Insights,
        Tab::Runs,
        Tab::Scorecard,
    ];

    fn label(self) -> &'static str {
        match self {
            Tab::Now => "Now",
            Tab::Environments => "Environments",
            Tab::Incidents => "Incidents",
            Tab::Insights => "Insights",
            Tab::Runs => "Runs",
            Tab::Scorecard => "Scorecard",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Tab::Now => "tab-now",
            Tab::Environments => "tab-environments",
            Tab::Incidents => "tab-incidents",
            Tab::Insights => "tab-insights",
            Tab::Runs => "tab-runs",
            Tab::Scorecard => "tab-scorecard",
        }
    }
}

struct AppState {
    tab: Tab,
    dark: bool,
    selected_env: String,
    selected_incident: String,
    tag_filter: String,
    status_notice: String,
    connected_live: bool,
    client: OverwatchClient,
    snapshot: FullStateSnapshot,
}

impl AppState {
    fn boot() -> Self {
        let client = OverwatchClient::new(ClientConfig::default());
        let (snapshot, connected_live, status_notice) = match client.fetch_state() {
            Ok(snap) => (
                snap,
                true,
                format!("Connected to {}", client.base_url()),
            ),
            Err(_) => (
                demo_fallback_snapshot(),
                false,
                "Preview snapshot (start `bun run start` for live daemon)".into(),
            ),
        };
        Self {
            tab: Tab::Now,
            dark: false,
            selected_env: "checkout-api:prod".into(),
            selected_incident: "INC-42".into(),
            tag_filter: "all".into(),
            status_notice,
            connected_live,
            client,
            snapshot,
        }
    }

    fn offline_preview() -> Self {
        Self {
            tab: Tab::Now,
            dark: false,
            selected_env: "checkout-api:prod".into(),
            selected_incident: "INC-42".into(),
            tag_filter: "all".into(),
            status_notice: "Connected to http://127.0.0.1:4720".into(),
            connected_live: true,
            client: OverwatchClient::new(ClientConfig::default()),
            snapshot: demo_fallback_snapshot(),
        }
    }

    fn dispatch(&mut self, intent: &str, payload: serde_json::Value, fallback_msg: &str) {
        if self.connected_live {
            match self.client.post_intent(intent, payload) {
                Ok(_) => {
                    if let Ok(fresh) = self.client.fetch_state() {
                        self.snapshot = fresh;
                    }
                    self.status_notice = fallback_msg.to_string();
                }
                Err(e) => {
                    self.status_notice = format!("Daemon error: {e}");
                }
            }
        } else {
            self.status_notice = format!("{fallback_msg} (offline preview)");
        }
    }
}

fn coverage_color(coverage: &str, p: Palette) -> Color {
    match coverage {
        "healthy" => p.healthy,
        "auth_expired" | "rate_limited" => p.warn,
        _ => p.critical,
    }
}

fn severity_color(severity: &str, p: Palette) -> Color {
    match severity {
        "page" => p.critical,
        "warn" => p.warn,
        _ => p.accent,
    }
}

fn top_nav(s: &AppState, p: Palette) -> El {
    let mut tabs = row().align(Align::Center).gap(4.0);
    for tab in Tab::ALL {
        let active = s.tab == tab;
        let label_text = if tab == Tab::Incidents && !s.snapshot.now.incidents.is_empty() {
            format!("{} ({})", tab.label(), s.snapshot.now.incidents.len())
        } else {
            tab.label().to_string()
        };
        tabs = tabs.child(
            el().key(tab.key())
                .role("tab")
                .label(tab.label())
                .focusable(true)
                .h(32.0)
                .px(12.0)
                .center()
                .radius(6.0)
                .fill(if active { p.accent_soft } else { Color::TRANSPARENT })
                .motion(motion::SNAPPY)
                .on_press(move |st: &mut AppState| st.tab = tab)
                .child(
                    text(label_text)
                        .font(TYPE_BODY)
                        .color(if active { p.accent } else { p.ink_muted }),
                ),
        );
    }

    let theme_toggle = el()
        .key("toggle-theme")
        .role("button")
        .label("Toggle appearance")
        .focusable(true)
        .h(32.0)
        .px(12.0)
        .center()
        .radius(6.0)
        .border(1.0, p.hairline)
        .fill(p.surface)
        .on_press(|st: &mut AppState| st.dark = !st.dark)
        .child(
            text(if s.dark { "Light" } else { "Dark" })
                .font(TYPE_SMALL)
                .color(p.ink_muted),
        );

    let collect_btn = el()
        .key("btn-collect-now")
        .role("button")
        .label("Collect now")
        .focusable(true)
        .h(32.0)
        .px(14.0)
        .center()
        .radius(6.0)
        .fill(p.accent)
        .motion(motion::SNAPPY)
        .on_press(|st: &mut AppState| {
            st.dispatch("collect", json!({}), "Collected fresh telemetry across fleet");
        })
        .child(text("Collect now").font(TYPE_SMALL).color(p.on_accent));

    row()
        .key("top-nav")
        .w_full()
        .h(56.0)
        .px(24.0)
        .align(Align::Center)
        .fill(p.surface)
        .border_sides([0.0, 0.0, 1.0, 0.0], p.hairline)
        .child(
            row()
                .h(32.0)
                .align(Align::Center)
                .gap(10.0)
                .mr(24.0)
                .child(el().size(11.0, 11.0).radius(2.5).fill(p.accent))
                .child(text("Overwatch").font(TYPE_BRAND).color(p.ink)),
        )
        .child(tabs)
        .child(el().grow(1.0))
        .child(
            row()
                .align(Align::Center)
                .gap(10.0)
                .child(
                    text(format!(
                        "${:.2} / ${:.0} daily",
                        s.snapshot.now.daily_spend_usd, s.snapshot.daily_usd_cap
                    ))
                    .font(TYPE_SMALL)
                    .color(p.ink_muted),
                )
                .child(theme_toggle)
                .child(collect_btn),
        )
}

fn view_now(s: &AppState, p: Palette) -> El {
    let mut root = col().w_full().gap(24.0);

    // 1. Needs Me blocking strip (only shown when asks are pending)
    if !s.snapshot.needs_me.pending.is_empty() {
        let mut ask_col = col().w_full().gap(10.0);
        for ask in &s.snapshot.needs_me.pending {
            let ask_id_approve = ask.ask_id.clone();
            let ask_id_reject = ask.ask_id.clone();
            ask_col = ask_col.child(
                row()
                    .w_full()
                    .padding(16.0)
                    .radius(8.0)
                    .fill(p.surface)
                    .border(1.0, p.warn)
                    .align(Align::Center)
                    .gap(16.0)
                    .child(
                        col()
                            .grow(1.0)
                            .gap(4.0)
                            .child(text(ask.question.clone()).font(TYPE_BODY).color(p.ink))
                            .child(
                                text(ask.why_it_matters.clone())
                                    .font(TYPE_SMALL)
                                    .color(p.ink_muted),
                            ),
                    )
                    .child(
                        row()
                            .gap(8.0)
                            .child(
                                el().key(format!("reject-{}", ask.ask_id))
                                    .role("button")
                                    .label("Reject")
                                    .focusable(true)
                                    .px(12.0)
                                    .py(7.0)
                                    .radius(6.0)
                                    .border(1.0, p.hairline_strong)
                                    .fill(p.surface)
                                    .on_press(move |st: &mut AppState| {
                                        st.dispatch(
                                            "answer-ask",
                                            json!({ "askId": ask_id_reject, "selectedOptionId": "reject" }),
                                            "Rejected pending action",
                                        );
                                        st.snapshot.needs_me.pending.retain(|a| a.ask_id != ask_id_reject);
                                    })
                                    .child(text("Reject").font(TYPE_SMALL).color(p.ink)),
                            )
                            .child(
                                el().key(format!("approve-{}", ask.ask_id))
                                    .role("button")
                                    .label("Approve")
                                    .focusable(true)
                                    .px(14.0)
                                    .py(7.0)
                                    .radius(6.0)
                                    .fill(p.accent)
                                    .on_press(move |st: &mut AppState| {
                                        st.dispatch(
                                            "answer-ask",
                                            json!({ "askId": ask_id_approve, "selectedOptionId": "approve" }),
                                            "Approved action and dispatched ExecuteAction Saga",
                                        );
                                        st.snapshot.needs_me.pending.retain(|a| a.ask_id != ask_id_approve);
                                    })
                                    .child(
                                        text("Approve and execute")
                                            .font(TYPE_SMALL)
                                            .color(p.on_accent),
                                    ),
                            ),
                    ),
            );
        }

        root = root.child(
            col()
                .w_full()
                .gap(10.0)
                .child(text("Needs your decision").font(TYPE_TITLE).color(p.ink))
                .child(ask_col),
        );
    }

    // 2. Active Incidents section
    let mut inc_list = col()
        .w_full()
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.hairline);
    if s.snapshot.now.incidents.is_empty() {
        inc_list = inc_list.child(
            el().padding(16.0).child(
                text("No open incidents. Fleet signals are within baseline.")
                    .font(TYPE_BODY)
                    .color(p.ink_muted),
            ),
        );
    } else {
        for (idx, inc) in s.snapshot.now.incidents.values().enumerate() {
            let inc_id = inc.incident_id.clone();
            let mut r = row()
                .key(format!("inc-row-{}", inc.incident_id))
                .w_full()
                .px(16.0)
                .py(14.0)
                .align(Align::Center)
                .gap(14.0)
                .focusable(true)
                .on_press(move |st: &mut AppState| {
                    st.selected_incident = inc_id.clone();
                    st.tab = Tab::Incidents;
                })
                .child(
                    el().size(8.0, 28.0)
                        .radius(2.0)
                        .fill(severity_color(&inc.severity, p)),
                )
                .child(
                    col()
                        .grow(1.0)
                        .gap(2.0)
                        .child(text(inc.headline.clone()).font(TYPE_BODY).color(p.ink))
                        .child(
                            text(format!(
                                "{} · {}/{} · {} correlated signals · recovery {}/{}",
                                inc.incident_id,
                                inc.app_id,
                                inc.env_id,
                                inc.signal_count,
                                inc.recovery_clean_windows,
                                inc.recovery_target_k
                            ))
                            .font(TYPE_SMALL)
                            .color(p.ink_muted),
                        ),
                )
                .child(
                    text(inc.status.clone())
                        .font(TYPE_SMALL)
                        .color(severity_color(&inc.severity, p)),
                );
            if idx > 0 {
                r = r.border_sides([1.0, 0.0, 0.0, 0.0], p.hairline);
            }
            inc_list = inc_list.child(r);
        }
    }

    root = root.child(
        col()
            .w_full()
            .gap(10.0)
            .child(text("Active incidents").font(TYPE_TITLE).color(p.ink))
            .child(inc_list),
    );

    // 3. Fleet Grid with live GPU sparklines & tag filter segmented control
    let mut filter_bar = row().gap(4.0).align(Align::Center);
    for tag in ["all", "payments", "platform"] {
        let active = s.tag_filter == tag;
        let t_val = tag.to_string();
        filter_bar = filter_bar.child(
            el().key(format!("filter-{tag}"))
                .role("radio")
                .label(tag)
                .focusable(true)
                .px(10.0)
                .py(5.0)
                .radius(5.0)
                .fill(if active { p.surface } else { Color::TRANSPARENT })
                .border(1.0, if active { p.hairline_strong } else { Color::TRANSPARENT })
                .on_press(move |st: &mut AppState| st.tag_filter = t_val.clone())
                .child(
                    text(if tag == "all" { "All teams" } else { tag })
                        .font(TYPE_SMALL)
                        .color(if active { p.ink } else { p.ink_muted }),
                ),
        );
    }

    let envs: Vec<_> = s
        .snapshot
        .now
        .environments
        .values()
        .filter(|e| {
            s.tag_filter == "all"
                || e.tags.get("team").map(String::as_str) == Some(s.tag_filter.as_str())
        })
        .collect();

    let mut grid = col().w_full().gap(12.0);
    for chunk in envs.chunks(2) {
        let mut r = row().w_full().gap(12.0);
        for env in chunk {
            let env_key = env.env_key.clone();
            let tel = s.snapshot.telemetry.get(&env.env_key);
            let series: Vec<f64> = tel
                .map(|t| t.metrics.iter().map(|m| m.p95_latency_ms).collect())
                .unwrap_or_default();
            let latest_p95 = series.last().copied().unwrap_or(0.0);
            let threshold = if env.app_id == "checkout-api" && env.env_id == "prod" {
                Some(1200.0)
            } else {
                None
            };
            let breached = threshold.is_some_and(|t| latest_p95 > t);
            let cov_color = if breached {
                p.critical
            } else {
                coverage_color(&env.coverage, p)
            };

            r = r.child(
                col()
                    .key(format!("env-tile-{}", env.env_key))
                    .grow(1.0)
                    .padding(16.0)
                    .radius(8.0)
                    .fill(p.surface)
                    .border(1.0, p.hairline)
                    .gap(10.0)
                    .focusable(true)
                    .on_press(move |st: &mut AppState| {
                        st.selected_env = env_key.clone();
                        st.tab = Tab::Environments;
                    })
                    .child(
                        row()
                            .w_full()
                            .align(Align::Center)
                            .child(
                                text(env.display_name.clone())
                                    .font(TYPE_BODY)
                                    .color(p.ink),
                            )
                            .child(el().grow(1.0))
                            .child(
                                text(if env.coverage == "healthy" {
                                    format!("p95 {:.0} ms", latest_p95)
                                } else {
                                    format!("Coverage: {}", env.coverage)
                                })
                                .font(TYPE_SMALL)
                                .color(cov_color),
                            ),
                    )
                    .child(sparkline(&series, 44.0, threshold, p))
                    .child(
                        text(env.coverage_detail.clone())
                            .font(TYPE_SMALL)
                            .color(p.ink_muted),
                    ),
            );
        }
        if chunk.len() == 1 {
            r = r.child(el().grow(1.0));
        }
        grid = grid.child(r);
    }

    root = root.child(
        col()
            .w_full()
            .gap(12.0)
            .child(
                row()
                    .w_full()
                    .align(Align::Center)
                    .child(text("Fleet health").font(TYPE_TITLE).color(p.ink))
                    .child(el().grow(1.0))
                    .child(filter_bar),
            )
            .child(grid),
    );

    root
}

fn view_environments(s: &AppState, p: Palette) -> El {
    let mut env_tabs = row().gap(6.0);
    for env in s.snapshot.now.environments.values() {
        let active = s.selected_env == env.env_key;
        let k = env.env_key.clone();
        env_tabs = env_tabs.child(
            el().key(format!("sel-env-{}", env.env_key))
                .focusable(true)
                .px(10.0)
                .py(6.0)
                .radius(6.0)
                .fill(if active { p.accent_soft } else { p.surface })
                .border(1.0, if active { p.accent } else { p.hairline })
                .on_press(move |st: &mut AppState| st.selected_env = k.clone())
                .child(
                    text(env.display_name.clone())
                        .font(TYPE_SMALL)
                        .color(if active { p.accent } else { p.ink_muted }),
                ),
        );
    }

    let mut content = col()
        .w_full()
        .gap(18.0)
        .child(text("Environment workload matrix").font(TYPE_TITLE).color(p.ink))
        .child(env_tabs);

    if let Some(tel) = s.snapshot.telemetry.get(&s.selected_env) {
        let series: Vec<f64> = tel.metrics.iter().map(|m| m.p95_latency_ms).collect();
        content = content.child(
            col()
                .w_full()
                .padding(16.0)
                .radius(8.0)
                .fill(p.surface)
                .border(1.0, p.hairline)
                .gap(10.0)
                .child(
                    text(format!("{} · {}", tel.env_key, tel.coverage_detail))
                        .font(TYPE_BODY)
                        .color(p.ink),
                )
                .child(sparkline(&series, 68.0, Some(1200.0), p)),
        );

        let mut pod_table = col()
            .w_full()
            .radius(8.0)
            .fill(p.surface)
            .border(1.0, p.hairline);

        pod_table = pod_table.child(
            row()
                .w_full()
                .px(16.0)
                .py(10.0)
                .fill(p.surface_subtle)
                .child(text("Pod").font(TYPE_SMALL).color(p.ink_muted).grow(2.0))
                .child(text("Revision").font(TYPE_SMALL).color(p.ink_muted).grow(1.0))
                .child(text("Ready / Restarts").font(TYPE_SMALL).color(p.ink_muted).grow(1.0))
                .child(text("CPU usage / req / lim").font(TYPE_SMALL).color(p.ink_muted).grow(1.5))
                .child(text("Memory usage / req / lim").font(TYPE_SMALL).color(p.ink_muted).grow(1.5)),
        );

        if tel.pods.is_empty() {
            pod_table = pod_table.child(
                el().padding(16.0).child(
                    text(
                        tel.remediation
                            .clone()
                            .unwrap_or_else(|| "No pods reported in latest snapshot.".into()),
                    )
                    .font(TYPE_BODY)
                    .color(p.warn),
                ),
            );
        } else {
            for pod in &tel.pods {
                let restart_label = match &pod.last_termination_reason {
                    Some(reason) => format!("{} ({} · {})", pod.ready, pod.restarts, reason),
                    None => format!("{} ({} restarts)", pod.ready, pod.restarts),
                };
                pod_table = pod_table.child(
                    row()
                        .w_full()
                        .px(16.0)
                        .py(12.0)
                        .align(Align::Center)
                        .border_sides([1.0, 0.0, 0.0, 0.0], p.hairline)
                        .child(text(pod.name.clone()).font(TYPE_SMALL).color(p.ink).grow(2.0))
                        .child(
                            text(format!("{} ({})", pod.revision, pod.track))
                                .font(TYPE_SMALL)
                                .color(if pod.track == "new" { p.accent } else { p.ink_muted })
                                .grow(1.0),
                        )
                        .child(
                            text(restart_label)
                                .font(TYPE_SMALL)
                                .color(if pod.restarts > 0 { p.critical } else { p.healthy })
                                .grow(1.0),
                        )
                        .child(
                            col()
                                .grow(1.5)
                                .gap(4.0)
                                .child(
                                    text(format!(
                                        "{}m / {}m / {}m",
                                        pod.cpu_millicores,
                                        pod.cpu_request_millicores,
                                        pod.cpu_limit_millicores
                                    ))
                                    .font(TYPE_SMALL)
                                    .color(p.ink_muted),
                                )
                                .child(utilization_bar(
                                    pod.cpu_millicores,
                                    pod.cpu_request_millicores,
                                    pod.cpu_limit_millicores,
                                    130.0,
                                    p,
                                )),
                        )
                        .child(
                            col()
                                .grow(1.5)
                                .gap(4.0)
                                .child(
                                    text(format!(
                                        "{} / {} / {} MiB",
                                        pod.memory_mi_b,
                                        pod.memory_request_mi_b,
                                        pod.memory_limit_mi_b
                                    ))
                                    .font(TYPE_SMALL)
                                    .color(p.ink_muted),
                                )
                                .child(utilization_bar(
                                    pod.memory_mi_b,
                                    pod.memory_request_mi_b,
                                    pod.memory_limit_mi_b,
                                    130.0,
                                    p,
                                )),
                        ),
                );
            }
        }
        content = content.child(pod_table);
    }

    content
}

fn view_incident(s: &AppState, p: Palette) -> El {
    let mut content = col().w_full().gap(18.0);
    if let Some(inc) = s.snapshot.incident_details.get(&s.selected_incident) {
        content = content
            .child(
                col()
                    .gap(6.0)
                    .child(text(inc.headline.clone()).font(TYPE_TITLE).color(p.ink))
                    .child(
                        text(format!(
                            "{} · {}/{} · status {} · recovery {}/{} clean windows",
                            inc.incident_id,
                            inc.app_id,
                            inc.env_id,
                            inc.status,
                            inc.recovery_clean_windows,
                            inc.recovery_target_k
                        ))
                        .font(TYPE_SMALL)
                        .color(p.ink_muted),
                    ),
            )
            .child({
                let mut box_col = col()
                    .w_full()
                    .padding(16.0)
                    .radius(8.0)
                    .fill(p.surface)
                    .border(1.0, p.hairline)
                    .gap(10.0)
                    .child(text("Current understanding").font(TYPE_BODY).color(p.ink));
                for b in &inc.understanding {
                    box_col = box_col.child(
                        col()
                            .gap(2.0)
                            .child(text(format!("• {}", b.text)).font(TYPE_BODY).color(p.ink))
                            .child(
                                text(format!("Evidence: {}", b.evidence_ids.join(", ")))
                                    .font(TYPE_SMALL)
                                    .color(p.accent),
                            ),
                    );
                }
                box_col
            })
            .child({
                let mut chat_col = col()
                    .w_full()
                    .padding(16.0)
                    .radius(8.0)
                    .fill(p.surface)
                    .border(1.0, p.hairline)
                    .gap(10.0)
                    .child(text("Incident dialogue & handoff").font(TYPE_BODY).color(p.ink));
                for m in &inc.chat {
                    chat_col = chat_col.child(
                        col()
                            .padding(10.0)
                            .radius(6.0)
                            .fill(if m.author == "operator" {
                                p.accent_soft
                            } else {
                                p.surface_subtle
                            })
                            .gap(2.0)
                            .child(
                                text(format!("{}: {}", m.author, m.text))
                                    .font(TYPE_SMALL)
                                    .color(p.ink),
                            ),
                    );
                }
                chat_col = chat_col.child(
                    text(format!(
                        "OpenCode CLI handoff: opencode --server {} --session ses_overwatch_fix_42",
                        s.snapshot.service_url
                    ))
                    .font(TYPE_SMALL)
                    .color(p.ink_muted),
                );
                chat_col
            });
    } else {
        content = content.child(text("No incident selected.").font(TYPE_BODY).color(p.ink_muted));
    }
    content
}

fn view_insights(s: &AppState, p: Palette) -> El {
    let mut list = col().w_full().gap(12.0);
    for ins in &s.snapshot.insights.insights {
        let id_watch = ins.insight_id.clone();
        list = list.child(
            row()
                .w_full()
                .padding(16.0)
                .radius(8.0)
                .fill(p.surface)
                .border(1.0, p.hairline)
                .align(Align::Center)
                .gap(16.0)
                .child(
                    col()
                        .grow(1.0)
                        .gap(4.0)
                        .child(text(ins.claim.clone()).font(TYPE_BODY).color(p.ink))
                        .child(text(ins.why_it_matters.clone()).font(TYPE_SMALL).color(p.ink_muted))
                        .child(
                            text(format!(
                                "{}/{} · {} · recurred {}x · status: {}",
                                ins.app_id, ins.env_id, ins.source_mode, ins.recurrence_count, ins.status
                            ))
                            .font(TYPE_SMALL)
                            .color(p.accent),
                        ),
                )
                .child(
                    el().key(format!("watch-{}", ins.insight_id))
                        .role("button")
                        .label("Watch")
                        .focusable(true)
                        .px(12.0)
                        .py(7.0)
                        .radius(6.0)
                        .fill(p.accent)
                        .on_press(move |st: &mut AppState| {
                            st.dispatch(
                                "watch-insight",
                                json!({ "insightId": id_watch }),
                                "Promoted insight to standing WatchRule",
                            );
                        })
                        .child(text("Watch").font(TYPE_SMALL).color(p.on_accent)),
                ),
        );
    }

    col()
        .w_full()
        .gap(16.0)
        .child(text("Proactive insights").font(TYPE_TITLE).color(p.ink))
        .child(list)
}

fn view_runs(s: &AppState, p: Palette) -> El {
    let mut table = col()
        .w_full()
        .radius(8.0)
        .fill(p.surface)
        .border(1.0, p.hairline);

    for (idx, run) in s.snapshot.runs.runs.iter().enumerate() {
        let mut r = row()
            .w_full()
            .px(16.0)
            .py(12.0)
            .align(Align::Center)
            .gap(12.0)
            .child(
                col()
                    .grow(2.0)
                    .gap(2.0)
                    .child(
                        text(format!("{} · {} ({}/{})", run.run_id, run.role, run.app_id, run.env_id))
                            .font(TYPE_BODY)
                            .color(p.ink),
                    )
                    .child(
                        text(format!(
                            "Model {} · session {} · {} tool calls · ${:.2} / ${:.2}",
                            run.model,
                            run.session_id.as_deref().unwrap_or("pending"),
                            run.total_tool_calls,
                            run.spent_usd,
                            run.max_usd
                        ))
                        .font(TYPE_SMALL)
                        .color(p.ink_muted),
                    ),
            )
            .child(text(run.status.clone()).font(TYPE_SMALL).color(p.accent));
        if idx > 0 {
            r = r.border_sides([1.0, 0.0, 0.0, 0.0], p.hairline);
        }
        table = table.child(r);
    }

    col()
        .w_full()
        .gap(16.0)
        .child(text("Agent runs & sessions").font(TYPE_TITLE).color(p.ink))
        .child(table)
}

fn view_scorecard(s: &AppState, p: Palette) -> El {
    let sc = &s.snapshot.scorecard;
    let mut prop_col = col().w_full().gap(10.0);
    for prop in &sc.proposals {
        prop_col = prop_col.child(
            col()
                .w_full()
                .padding(16.0)
                .radius(8.0)
                .fill(p.surface)
                .border(1.0, p.hairline)
                .gap(6.0)
                .child(text(prop.title.clone()).font(TYPE_BODY).color(p.ink))
                .child(
                    text(format!(
                        "{} · replay score {} -> {} · status: {}",
                        prop.target_path, prop.before_replay_score, prop.after_replay_score, prop.status
                    ))
                    .font(TYPE_SMALL)
                    .color(p.healthy),
                )
                .child(text(prop.rationale.clone()).font(TYPE_SMALL).color(p.ink_muted)),
        );
    }

    col()
        .w_full()
        .gap(18.0)
        .child(text("Scorecard & calibration").font(TYPE_TITLE).color(p.ink))
        .child(
            row()
                .w_full()
                .gap(12.0)
                .child(
                    col()
                        .grow(1.0)
                        .padding(16.0)
                        .radius(8.0)
                        .fill(p.surface)
                        .border(1.0, p.hairline)
                        .child(text("Judge agreement").font(TYPE_SMALL).color(p.ink_muted))
                        .child(
                            text(format!("{}%", sc.calibration_agreement_pct))
                                .font(TYPE_TITLE)
                                .color(p.healthy),
                        ),
                )
                .child(
                    col()
                        .grow(1.0)
                        .padding(16.0)
                        .radius(8.0)
                        .fill(p.surface)
                        .border(1.0, p.hairline)
                        .child(text("Operator feedback").font(TYPE_SMALL).color(p.ink_muted))
                        .child(
                            text(format!("{} positive / {} negative", sc.feedback_up, sc.feedback_down))
                                .font(TYPE_BODY)
                                .color(p.ink),
                        ),
                )
                .child(
                    col()
                        .grow(1.0)
                        .padding(16.0)
                        .radius(8.0)
                        .fill(p.surface)
                        .border(1.0, p.hairline)
                        .child(text("Spend today").font(TYPE_SMALL).color(p.ink_muted))
                        .child(
                            text(format!("${:.2}", sc.total_spend_usd))
                                .font(TYPE_TITLE)
                                .color(p.ink),
                        ),
                ),
        )
        .child(text("Weekly improvement proposals").font(TYPE_BODY).color(p.ink))
        .child(prop_col)
}

fn view(s: &AppState, _cx: &mut Cx<AppState>) -> El {
    let p = palette(s.dark);
    let body = match s.tab {
        Tab::Now => view_now(s, p),
        Tab::Environments => view_environments(s, p),
        Tab::Incidents => view_incident(s, p),
        Tab::Insights => view_insights(s, p),
        Tab::Runs => view_runs(s, p),
        Tab::Scorecard => view_scorecard(s, p),
    };

    col()
        .key("root")
        .w_full()
        .h_full()
        .fill(p.canvas)
        .child(top_nav(s, p))
        .child(
            col()
                .key("viewport")
                .grow(1.0)
                .min_h(0.0)
                .w_full()
                .scroll(ScrollSpec::default())
                .px(28.0)
                .py(24.0)
                .child(body),
        )
        .child(
            row()
                .key("footer-bar")
                .w_full()
                .px(24.0)
                .py(8.0)
                .fill(p.surface)
                .border_sides([1.0, 0.0, 0.0, 0.0], p.hairline)
                .child(text(s.status_notice.clone()).font(TYPE_SMALL).color(p.ink_muted))
                .child(el().grow(1.0))
                .child(
                    text(format!("Cursor #{} · {} mode", s.snapshot.cursor, s.snapshot.mode))
                        .font(TYPE_SMALL)
                        .color(p.ink_muted),
                ),
        )
}

fn main() {
    rune::run(AppSpec::<AppState> {
        scenes: &[
            ("now", |s| {
                *s = AppState::offline_preview();
                s.tab = Tab::Now;
            }),
            ("environments", |s| {
                *s = AppState::offline_preview();
                s.tab = Tab::Environments;
            }),
            ("incident", |s| {
                *s = AppState::offline_preview();
                s.tab = Tab::Incidents;
            }),
            ("insights", |s| {
                *s = AppState::offline_preview();
                s.tab = Tab::Insights;
            }),
            ("dark", |s| {
                *s = AppState::offline_preview();
                s.dark = true;
            }),
        ],
        ..AppSpec::new("Overwatch", (1280.0, 820.0), AppState::boot, view)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn headless_rune_nav_tabs_and_approval_flow() {
        let env = Env {
            system_dark: false,
            scale: 2.0,
        };
        let mut rt = Runtime::new(AppState::offline_preview(), view, (1280.0, 820.0), env);
        rt.frame(0.0);

        assert_eq!(rt.state.tab, Tab::Now);
        assert_eq!(rt.state.snapshot.needs_me.pending.len(), 1);

        // Click "Environments" tab
        let (x, y) = rt.find("tab-environments").expect("tab-environments visible");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.tab, Tab::Environments);

        // Click back to "Now" and approve pending Draft PR ask
        let (nx, ny) = rt.find("tab-now").expect("tab-now visible");
        rt.pointer_down(nx, ny);
        rt.pointer_up(nx, ny);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.tab, Tab::Now);

        let (ax, ay) = rt
            .find("approve-ask_act_act-pr-42")
            .expect("approve button visible");
        rt.pointer_down(ax, ay);
        rt.pointer_up(ax, ay);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.snapshot.needs_me.pending.len(), 0);

        // Toggle dark theme
        let (tx, ty) = rt.find("toggle-theme").expect("theme toggle visible");
        rt.pointer_down(tx, ty);
        rt.pointer_up(tx, ty);
        rt.frame(1.0 / 60.0);
        assert!(rt.state.dark);
    }
}
