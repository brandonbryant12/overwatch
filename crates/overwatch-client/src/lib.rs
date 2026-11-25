#![forbid(unsafe_code)]

//! Platform-agnostic zero-business-logic client transport for Overwatch.
//! Speaks exclusively HTTP JSON + resumable SSE against the Overwatch Bun daemon.

use overwatch_protocol::*;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct ClientConfig {
    pub base_url: String,
}

impl Default for ClientConfig {
    fn default() -> Self {
        let base_url = std::env::var("OVERWATCH_API_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:4720".to_string());
        Self { base_url }
    }
}

#[derive(Clone, Debug)]
pub struct OverwatchClient {
    config: ClientConfig,
}

impl OverwatchClient {
    pub fn new(config: ClientConfig) -> Self {
        Self { config }
    }

    pub fn base_url(&self) -> &str {
        &self.config.base_url
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn fetch_state(&self) -> Result<FullStateSnapshot, String> {
        let url = format!("{}/api/state", self.config.base_url.trim_end_matches('/'));
        let resp = ureq::get(&url)
            .timeout(std::time::Duration::from_secs(3))
            .call()
            .map_err(|e| format!("GET {url} failed: {e}"))?;
        resp.into_json::<FullStateSnapshot>()
            .map_err(|e| format!("Decode FullStateSnapshot failed: {e}"))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn post_intent(&self, intent: &str, payload: Value) -> Result<Value, String> {
        let url = format!(
            "{}/api/intents/{}",
            self.config.base_url.trim_end_matches('/'),
            intent
        );
        let resp = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(5))
            .send_json(payload)
            .map_err(|e| format!("POST {url} failed: {e}"))?;
        resp.into_json::<Value>()
            .map_err(|e| format!("Decode intent response failed: {e}"))
    }

    #[cfg(target_arch = "wasm32")]
    pub fn fetch_state(&self) -> Result<FullStateSnapshot, String> {
        Ok(demo_fallback_snapshot())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn post_intent(&self, _intent: &str, _payload: Value) -> Result<Value, String> {
        Ok(serde_json::json!({ "ok": true }))
    }
}

/// Deterministic preview snapshot used only for offline headless UI rendering (`--snap` / `cargo test`).
/// Live sessions always hydrate from `GET /api/state` on the Overwatch daemon.
pub fn demo_fallback_snapshot() -> FullStateSnapshot {
    let mut environments = BTreeMap::new();
    environments.insert(
        "checkout-api:prod".into(),
        EnvironmentRecord {
            env_key: "checkout-api:prod".into(),
            app_id: "checkout-api".into(),
            env_id: "prod".into(),
            display_name: "Checkout API (prod)".into(),
            tags: BTreeMap::from([
                ("team".into(), "payments".into()),
                ("tier".into(), "critical".into()),
            ]),
            region: "us-east-1".into(),
            coverage: "healthy".into(),
            coverage_detail: "Rollout Watch active (build #482 · 9f31c2a)".into(),
            active_rollout_id: Some("rollout-482".into()),
            latest_commit_sha: Some("9f31c2a".into()),
            latest_build_number: Some(482),
            last_collected_at_ms: Some(1_764_000_000_000),
        },
    );
    environments.insert(
        "checkout-api:staging".into(),
        EnvironmentRecord {
            env_key: "checkout-api:staging".into(),
            app_id: "checkout-api".into(),
            env_id: "staging".into(),
            display_name: "Checkout API (staging)".into(),
            tags: BTreeMap::from([("team".into(), "payments".into())]),
            region: "us-east-1".into(),
            coverage: "auth_expired".into(),
            coverage_detail: "EKS SSO token expired (detectors frozen)".into(),
            active_rollout_id: None,
            latest_commit_sha: Some("9f31c2a".into()),
            latest_build_number: Some(484),
            last_collected_at_ms: Some(1_763_997_500_000),
        },
    );
    environments.insert(
        "billing-worker:prod".into(),
        EnvironmentRecord {
            env_key: "billing-worker:prod".into(),
            app_id: "billing-worker".into(),
            env_id: "prod".into(),
            display_name: "Billing Worker (prod)".into(),
            tags: BTreeMap::from([("team".into(), "payments".into())]),
            region: "us-east-1".into(),
            coverage: "healthy".into(),
            coverage_detail: "All connectors healthy · 2/2 pods ready".into(),
            active_rollout_id: None,
            latest_commit_sha: Some("6a12d9".into()),
            latest_build_number: Some(219),
            last_collected_at_ms: Some(1_764_000_000_000),
        },
    );
    environments.insert(
        "identity-edge:prod".into(),
        EnvironmentRecord {
            env_key: "identity-edge:prod".into(),
            app_id: "identity-edge".into(),
            env_id: "prod".into(),
            display_name: "Identity Edge (prod)".into(),
            tags: BTreeMap::from([("team".into(), "platform".into())]),
            region: "us-east-1".into(),
            coverage: "healthy".into(),
            coverage_detail: "All connectors healthy · 2/2 pods ready".into(),
            active_rollout_id: None,
            latest_commit_sha: Some("d04e71".into()),
            latest_build_number: Some(108),
            last_collected_at_ms: Some(1_764_000_000_000),
        },
    );
    environments.insert(
        "ledger-ingest:prod".into(),
        EnvironmentRecord {
            env_key: "ledger-ingest:prod".into(),
            app_id: "ledger-ingest".into(),
            env_id: "prod".into(),
            display_name: "Ledger Ingest (prod)".into(),
            tags: BTreeMap::from([("team".into(), "payments".into())]),
            region: "us-east-1".into(),
            coverage: "healthy".into(),
            coverage_detail: "All connectors healthy · watching steady throughput".into(),
            active_rollout_id: None,
            latest_commit_sha: Some("c390b1".into()),
            latest_build_number: Some(304),
            last_collected_at_ms: Some(1_764_000_000_000),
        },
    );

    let mut incidents = BTreeMap::new();
    incidents.insert(
        "INC-42".into(),
        IncidentSummary {
            incident_id: "INC-42".into(),
            app_id: "checkout-api".into(),
            env_id: "prod".into(),
            headline: "checkout-api prod p95 latency jumped 0.89s -> 2.15s (+141%)".into(),
            severity: "page".into(),
            status: "mitigating".into(),
            signal_count: 2,
            recovery_clean_windows: 0,
            recovery_target_k: 3,
            rollout_id: Some("rollout-482".into()),
            commit_sha: Some("9f31c2a".into()),
            tags: BTreeMap::from([("team".into(), "payments".into())]),
            opened_at_ms: 1_763_999_300_000,
            last_anomaly_at_ms: 1_763_999_400_000,
            resolved_at_ms: None,
            active_run_id: Some("run-fix-42".into()),
        },
    );

    let ask = AskSummary {
        ask_id: "ask_act_act-pr-42".into(),
        kind: "action_approval".into(),
        status: "pending".into(),
        question: "Open draft PR: Batch promo tier lookup in checkout confirm (INC-42)".into(),
        why_it_matters:
            "Outward open_draft_pr for checkout-api/prod requires operator sign-off. Local bun test dropped 890ms -> 42ms.".into(),
        options: vec![
            AskOption {
                id: "approve".into(),
                label: "Approve and execute".into(),
                description: None,
            },
            AskOption {
                id: "reject".into(),
                label: "Reject action".into(),
                description: None,
            },
        ],
        recommended_option_id: "approve".into(),
        incident_id: Some("INC-42".into()),
        run_id: Some("run-fix-42".into()),
        action_id: Some("act-pr-42".into()),
        session_id: Some("ses_overwatch_fix_42".into()),
        selected_option_id: None,
        resolved_via: None,
        opened_at_ms: 1_763_999_500_000,
    };

    let mut pending_asks = BTreeMap::new();
    pending_asks.insert(ask.ask_id.clone(), ask.clone());

    let mut telemetry = BTreeMap::new();
    let checkout_metrics: Vec<MetricPoint> = (0..28)
        .map(|i| {
            let spike = i >= 19;
            MetricPoint {
                ts_ms: 1_763_998_000_000 + i * 60_000,
                p50_latency_ms: if spike { 410.0 } else { 355.0 },
                p95_latency_ms: if spike {
                    1550.0 + ((i - 19) as f64) * 75.0
                } else {
                    840.0 + ((i % 4) as f64) * 28.0
                },
                error_rate_pct: if spike { 1.84 } else { 0.14 },
                cpu_pct: if spike { 84.0 } else { 44.0 },
                memory_pct: if spike { 76.0 } else { 52.0 },
                rps: 430.0,
            }
        })
        .collect();

    telemetry.insert(
        "checkout-api:prod".into(),
        EnvironmentTelemetrySnapshot {
            env_key: "checkout-api:prod".into(),
            app_id: "checkout-api".into(),
            env_id: "prod".into(),
            coverage: "healthy".into(),
            coverage_detail: "Rollout Watch active (build #482 · 9f31c2a)".into(),
            remediation: None,
            pods: vec![
                PodSnapshot {
                    name: "checkout-api-9f31c2a-7b4d".into(),
                    namespace: "checkout".into(),
                    revision: "rev-482".into(),
                    track: "new".into(),
                    image_tag: "9f31c2a".into(),
                    ready: "2/2".into(),
                    phase: "Running".into(),
                    restarts: 0,
                    last_termination_reason: None,
                    cpu_millicores: 840,
                    cpu_request_millicores: 500,
                    cpu_limit_millicores: 1000,
                    memory_mi_b: 712,
                    memory_request_mi_b: 512,
                    memory_limit_mi_b: 1024,
                    node_name: "ip-10-42-14-88".into(),
                },
                PodSnapshot {
                    name: "checkout-api-9f31c2a-9c2f".into(),
                    namespace: "checkout".into(),
                    revision: "rev-482".into(),
                    track: "new".into(),
                    image_tag: "9f31c2a".into(),
                    ready: "2/2".into(),
                    phase: "Running".into(),
                    restarts: 1,
                    last_termination_reason: Some("OOMKilled".into()),
                    cpu_millicores: 875,
                    cpu_request_millicores: 500,
                    cpu_limit_millicores: 1000,
                    memory_mi_b: 790,
                    memory_request_mi_b: 512,
                    memory_limit_mi_b: 1024,
                    node_name: "ip-10-42-18-12".into(),
                },
                PodSnapshot {
                    name: "checkout-api-4c88e1b-3a1e".into(),
                    namespace: "checkout".into(),
                    revision: "rev-481".into(),
                    track: "stable".into(),
                    image_tag: "4c88e1b".into(),
                    ready: "2/2".into(),
                    phase: "Running".into(),
                    restarts: 0,
                    last_termination_reason: None,
                    cpu_millicores: 410,
                    cpu_request_millicores: 500,
                    cpu_limit_millicores: 1000,
                    memory_mi_b: 482,
                    memory_request_mi_b: 512,
                    memory_limit_mi_b: 1024,
                    node_name: "ip-10-42-11-04".into(),
                },
            ],
            builds: vec![BuildRecord {
                build_number: 482,
                job_path: "job/payments/job/checkout-api/job/main".into(),
                result: "SUCCESS".into(),
                commit_sha: "9f31c2a".into(),
                commit_message: "feat(promos): evaluate tiered bundle discounts per cart item".into(),
                author: "m.patel".into(),
                duration_ms: 184_000,
                timestamp_ms: 1_763_999_100_000,
                url: "https://jenkins.internal.example.com/job/checkout-api/482".into(),
            }],
            metrics: checkout_metrics,
            sampled_at_ms: 1_764_000_000_000,
        },
    );

    for (key, app, env, p95_base) in [
        ("billing-worker:prod", "billing-worker", "prod", 710.0),
        ("identity-edge:prod", "identity-edge", "prod", 58.0),
        ("ledger-ingest:prod", "ledger-ingest", "prod", 275.0),
    ] {
        telemetry.insert(
            key.into(),
            EnvironmentTelemetrySnapshot {
                env_key: key.into(),
                app_id: app.into(),
                env_id: env.into(),
                coverage: "healthy".into(),
                coverage_detail: "All connectors healthy".into(),
                remediation: None,
                pods: vec![],
                builds: vec![],
                metrics: (0..28)
                    .map(|i| MetricPoint {
                        ts_ms: 1_763_998_000_000 + i * 60_000,
                        p50_latency_ms: p95_base * 0.45,
                        p95_latency_ms: p95_base + ((i % 5) as f64) * (p95_base * 0.04),
                        error_rate_pct: 0.06,
                        cpu_pct: 32.0,
                        memory_pct: 51.0,
                        rps: 510.0,
                    })
                    .collect(),
                sampled_at_ms: 1_764_000_000_000,
            },
        );
    }

    let mut incident_details = BTreeMap::new();
    incident_details.insert(
        "INC-42".into(),
        IncidentDetailState {
            exists: true,
            incident_id: "INC-42".into(),
            app_id: "checkout-api".into(),
            env_id: "prod".into(),
            headline: "checkout-api prod p95 latency jumped 0.89s -> 2.15s (+141%)".into(),
            severity: "page".into(),
            status: "mitigating".into(),
            rollout_id: Some("rollout-482".into()),
            commit_sha: Some("9f31c2a".into()),
            understanding: vec![
                UnderstandingBullet {
                    text: "Regression isolated 100% to rev-482 pods (commit 9f31c2a); rev-481 stays at 0.88s p95.".into(),
                    evidence_ids: vec!["ev_k8s_rev_482".into()],
                },
                UnderstandingBullet {
                    text: "Paired trace diff shows cart_line_items pg.query firing 46x per request vs 2x baseline (+1563ms).".into(),
                    evidence_ids: vec!["ev_trace_diff_482".into()],
                },
                UnderstandingBullet {
                    text: "Local worktree fix batched promo lookup; bun test checkout dropped 890ms -> 42ms.".into(),
                    evidence_ids: vec!["ev_jk_482".into()],
                },
            ],
            verification_bundles: vec![VerificationBundle {
                run_id: "run-fix-42".into(),
                reproduced_locally: true,
                commands_run: vec!["bun run typecheck".into(), "bun test checkout/confirm.test.ts".into()],
                exit_codes: vec![0, 0],
                before_after_summary: "46 queries / 890ms -> 1 batched IN query / 42ms".into(),
                diff_stat: "2 files changed, 34 insertions(+), 12 deletions(-)".into(),
                unknowns: vec!["Production recovery requires 3 clean post-deploy windows.".into()],
                worktree_path: Some("/Users/brandon/.local/share/overwatch/worktrees/checkout-api/inc-42".into()),
                branch: Some("overwatch/inc-42-batch-promo-query".into()),
            }],
            linked_run_ids: vec!["run-triage-42".into(), "run-fix-42".into()],
            action_ids: vec!["act-pr-42".into()],
            chat: vec![
                IncidentChatEntry {
                    id: "chat-1".into(),
                    author: "operator".into(),
                    text: "Is this happening on the old ReplicaSet pods too?".into(),
                    delivery: "steer".into(),
                    evidence_ids: vec![],
                    created_at_ms: 1_763_999_420_000,
                },
                IncidentChatEntry {
                    id: "chat-2".into(),
                    author: "agent".into(),
                    text: "No. Old rev-481 pod is steady at 0.88s p95 with 0 restarts. Both rev-482 pods sit at 2.15s p95 and 840m+ CPU.".into(),
                    delivery: "reply".into(),
                    evidence_ids: vec!["ev_k8s_rev_482".into()],
                    created_at_ms: 1_763_999_425_000,
                },
            ],
            recovery_clean_windows: 0,
            recovery_target_k: 3,
            opened_at_ms: 1_763_999_300_000,
        },
    );

    FullStateSnapshot {
        cursor: 1,
        mode: "demo".into(),
        service_url: "http://127.0.0.1:4096".into(),
        daily_usd_cap: 15.0,
        now: NowViewState {
            environments,
            incidents,
            pending_asks,
            active_runs: BTreeMap::new(),
            actions: BTreeMap::new(),
            active_insight_count: 2,
            watch_rule_count: 4,
            daily_spend_usd: 0.76,
            wake_count: 0,
            last_wake_at_ms: None,
            last_wake_gap_ms: None,
        },
        needs_me: NeedsMeViewState {
            pending: vec![ask],
            recent: vec![],
        },
        insights: InsightFeedState {
            insights: vec![
                InsightRecord {
                    insight_id: "ins-billing-n1".into(),
                    app_id: "billing-worker".into(),
                    env_id: "prod".into(),
                    claim: "invoice.reconcile_batch executes sequential SELECT per line (+34% p95 WoW)".into(),
                    why_it_matters: "Batch jobs approach 2s SLA during month-end invoicing spikes.".into(),
                    recurrence_count: 14,
                    evidence_ids: vec!["ev_explore_billing_n1".into()],
                    source_mode: "trace_walk".into(),
                    status: "active".into(),
                    recorded_at_ms: 1_763_990_000_000,
                },
                InsightRecord {
                    insight_id: "ins-ledger-mem".into(),
                    app_id: "ledger-ingest".into(),
                    env_id: "prod".into(),
                    claim: "ledger-ingest working set climbed +38% over 7d with flat RPS".into(),
                    why_it_matters: "At current slope, pod hits 1536 MiB OOM limit in ~9 days.".into(),
                    recurrence_count: 7,
                    evidence_ids: vec!["ev_explore_redis_drift".into()],
                    source_mode: "resource_drift".into(),
                    status: "active".into(),
                    recorded_at_ms: 1_763_992_000_000,
                },
            ],
            watch_rules: vec![],
        },
        runs: RunListState {
            runs: vec![
                RunSummary {
                    run_id: "run-fix-42".into(),
                    role: "fix".into(),
                    trigger: "intent".into(),
                    app_id: "checkout-api".into(),
                    env_id: "prod".into(),
                    incident_id: Some("INC-42".into()),
                    model: "claude-sonnet-4-5".into(),
                    status: "running".into(),
                    session_id: Some("ses_overwatch_fix_42".into()),
                    worktree_path: Some("/Users/brandon/.local/share/overwatch/worktrees/checkout-api/inc-42".into()),
                    awake_elapsed_ms: 142_000,
                    max_awake_ms: 600_000,
                    connector_calls: 4,
                    max_connector_calls: 15,
                    total_tool_calls: 18,
                    spent_usd: 0.62,
                    max_usd: 3.0,
                    summary: Some("Verified worktree fix locally; awaiting draft PR approval.".into()),
                    judge_score: None,
                    started_at_ms: 1_763_999_480_000,
                },
                RunSummary {
                    run_id: "run-triage-42".into(),
                    role: "triage".into(),
                    trigger: "signal".into(),
                    app_id: "checkout-api".into(),
                    env_id: "prod".into(),
                    incident_id: Some("INC-42".into()),
                    model: "claude-haiku-4-5".into(),
                    status: "completed".into(),
                    session_id: Some("ses_overwatch_triage_42".into()),
                    worktree_path: None,
                    awake_elapsed_ms: 38_000,
                    max_awake_ms: 120_000,
                    connector_calls: 6,
                    max_connector_calls: 12,
                    total_tool_calls: 11,
                    spent_usd: 0.14,
                    max_usd: 0.75,
                    summary: Some("Isolated N+1 query regression to build #482 (9f31c2a).".into()),
                    judge_score: Some(96),
                    started_at_ms: 1_763_999_310_000,
                },
            ],
        },
        scorecard: ScorecardState {
            verdicts: vec![VerdictRecord {
                verdict_id: "verd-42-triage".into(),
                run_id: "run-triage-42".into(),
                judge_model: "gemini-2.5-pro".into(),
                grounded: true,
                concise: true,
                actionable: true,
                severity_calibrated: true,
                scope_disciplined: true,
                score: 96,
                operator_agreed: Some(true),
            }],
            proposals: vec![ProposalRecord {
                proposal_id: "prop-checkout-playbook-1".into(),
                title: "Add ReplicaSet revision check to checkout-api playbook".into(),
                target_path: "agents/playbooks/checkout-api.md".into(),
                rationale: "Checking revision split first saves ~45s in deploy regressions.".into(),
                diff_preview: "+2. Always check cart_line_items pg.query fan-out count.".into(),
                before_replay_score: 84,
                after_replay_score: 95,
                status: "pending".into(),
            }],
            feedback_up: 1,
            feedback_down: 0,
            incidents_opened: 1,
            incidents_dismissed: 0,
            total_spend_usd: 0.76,
            calibration_agreement_pct: 100,
        },
        briefs: BriefListState { briefs: vec![] },
        incident_details,
        telemetry,
        evidence: BTreeMap::new(),
    }
}
