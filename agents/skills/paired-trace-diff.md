# Skill: Paired Trace-Tree Diff Investigation

1. Query `datadog_list_route_cohorts` for the target `(service, env)` to rank routes by `p95 / p50` skew and WoW delta.
2. Sample 2-3 slow traces (`p95-p99`) paired with 2-3 median traces (`p50`) on the **same route and release version**.
3. Run `datadog_diff_trace_trees` to inspect deterministic self-time delta, N+1 call-count multipliers (`>= 5x` and `>= 3x` median), and pod revision tag skew.
4. Cite the resulting `EvidenceId` directly in `RecordFinding` or `RecordInsight`.
