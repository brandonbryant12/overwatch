// Display-only fixtures on the real 200-problem service. Owner writes always reach the service.
// Run this before navigation using Page.addScriptToEvaluateOnNewDocument.
export function fleetPageStates() {
  const states = [
    "queued",
    "proposing",
    "verifying",
    "publishing",
    "draft",
    "awaiting_deploy",
    "released_quiet",
    "closed_unmerged",
    "blocked",
    "ineligible",
    "refused",
    "verify_failed",
    "stale",
    "declined",
    "unresolved",
  ]
  const forecast = ["forecast", "reached", "outside_horizon", "unknown"]
  const comparison = ["pending", "regression", "unknown", "no_signal", "same_release"]
  const reasons = {
    unresolved: "The host has not confirmed this draft after five tries",
    blocked: "The fix trial has not passed",
    ineligible: "The first line predates rollout",
    refused: "The inverse changes an unapproved file",
    verify_failed: "node verify.cjs exited 7",
    stale: "The base moved before publication",
    declined: "Declined by the owner",
    pending: "Waiting for two aligned intervals",
    unknown: "Production was not measured in interval 2",
    reached: "The limit of 100 units is reached",
    outside_horizon: "More than 24 hours at this rate",
  }
  const decorate = (s) => {
    if (!s.inbox || !s.environments) return s
    s.outlook = {
      forecasts: s.environments.map((e, i) => ({
        source: e.app + "/" + e.environment + "/quota",
        resource: "quota",
        unit: "units",
        limit: 100,
        state: forecast[i % 4],
        reason: reasons[forecast[i % 4]] ?? null,
        asOfMs: s.atMs,
        etaMinutes: i % 4 === 0 ? 4 : null,
        samples: 6,
        ratePerMinute: 10,
        intervalMs: 60000,
      })),
      comparisons: s.environments.map((e, i) => ({
        app: e.app,
        staging: e.environment,
        production: "prod",
        stagingRevision: "a".repeat(40),
        productionRevision: "b".repeat(40),
        state: comparison[i % 5],
        reason: reasons[comparison[i % 5]] ?? null,
        stagingCount: 3,
        productionCount: 0,
      })),
    }
    return s
  }
  const get = window.fetch.bind(window)
  window.fetch = async (...args) => {
    const r = await get(...args)
    const pathname = new URL(args[0], location.href).pathname
    if (!r.ok || !/^\/v2\/(status$|items\/[^/]+$)/.test(pathname)) return r
    const json = await r.json()
    if (json.incident)
      json.fixes = states.map((state, i) => ({
        id: "fixture-" + i,
        state,
        reason: reasons[state] ?? null,
        verification: ["verify_failed", "draft"].includes(state)
          ? [{ argv: ["node", "verify.cjs"], exitCode: state === "draft" ? 0 : 7, elapsedMs: 42 }]
          : [],
        pr: state === "draft" ? { number: 17, url: "/fixture-draft", draft: true, state: "OPEN" } : null,
      }))
    return Response.json(decorate(json))
  }
  const EventStream = window.EventSource
  window.EventSource = class extends EventStream {
    addEventListener(name, fn, ...rest) {
      if (["change", "snapshot"].includes(name))
        return super.addEventListener(
          name,
          (e) => fn(new MessageEvent(name, { data: JSON.stringify(decorate(JSON.parse(e.data))) })),
          ...rest,
        )
      return super.addEventListener(name, fn, ...rest)
    }
  }
}
