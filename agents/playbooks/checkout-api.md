# Playbook: checkout-api

## Rollout Triage Order
1. Compare p95 latency and CPU utilization by Kubernetes ReplicaSet revision (`rev-new` vs `rev-stable`) before checking Stripe downstream latency.
2. When Jenkins build diff touches `promos/` or `cart_line_items`, run `datadog_diff_trace_trees` on `POST /v1/checkout/confirm` to check for N+1 `pg.query` fan-out.
3. Verify `checkout-api:staging` EKS SSO coverage before assuming staging is clean.
