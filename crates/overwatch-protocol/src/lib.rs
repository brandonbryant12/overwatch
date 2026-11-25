#![forbid(unsafe_code)]

pub mod generated;
pub use generated::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_openapi_catalog_is_populated() {
        assert!(OPENAPI_VERSION.starts_with("3."));
        assert!(DOMAIN_ENDPOINT_COUNT >= 20);
        assert_eq!(DOMAIN_OPERATIONS.len(), DOMAIN_ENDPOINT_COUNT);
    }

    #[test]
    fn full_state_snapshot_roundtrips_json() {
        let json = r#"{
            "cursor": 7,
            "mode": "demo",
            "serviceUrl": "http://127.0.0.1:4096",
            "dailyUsdCap": 15.0,
            "now": {
                "environments": {},
                "incidents": {},
                "pendingAsks": {},
                "activeRuns": {},
                "actions": {},
                "activeInsightCount": 2,
                "watchRuleCount": 4,
                "dailySpendUsd": 0.76,
                "wakeCount": 1
            },
            "needsMe": { "pending": [], "recent": [] },
            "insights": { "insights": [], "watchRules": [] },
            "runs": { "runs": [] },
            "scorecard": {
                "verdicts": [],
                "proposals": [],
                "feedbackUp": 3,
                "feedbackDown": 0,
                "incidentsOpened": 1,
                "incidentsDismissed": 0,
                "totalSpendUsd": 0.76,
                "calibrationAgreementPct": 100
            },
            "briefs": { "briefs": [] },
            "incidentDetails": {},
            "telemetry": {},
            "evidence": {}
        }"#;
        let parsed: FullStateSnapshot = serde_json::from_str(json).expect("valid snapshot json");
        assert_eq!(parsed.cursor, 7);
        assert_eq!(parsed.now.watch_rule_count, 4);
        assert_eq!(parsed.scorecard.calibration_agreement_pct, 100);
    }
}
