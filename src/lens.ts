/**
 * Declarative GenUI Visual Lenses (`LensSpec`) and structured OpenCode handoff bundles.
 * Every visual block is schema-validated JSON (zero raw HTML) and grounded strictly in stored SQLite facts and
 * verified evidence handles. AI-generated lenses are verified against the incident's own evidence handles before storage.
 */
import { Effect, Option, Predicate, Schedule, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { clock } from "./clock.ts";
import { AppConfig, policyFor } from "./config.ts";
import { apiError } from "./errors.ts";
import { after, emptyFolder, OpenCodeClient } from "./opencode.ts";
import { commits, type CommitSummary } from "./outlook.ts";
import { clean, errorText } from "./redact.ts";
import { json, Store, sql, type Clean } from "./store.ts";

const Tone = Schema.Literals(["neutral", "warn", "error", "ok"]);
const Origin = Schema.Literals(["telemetry", "code", "history", "generated", "db"]);
const OptHandle = Schema.optionalKey(Schema.String);
export const LensBlockSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("causal_flow"), title: Schema.String, steps: Schema.Array(Schema.Struct({ label: Schema.String, detail: Schema.String, tone: Tone, handle: OptHandle })) }),
  Schema.Struct({ kind: Schema.Literal("span_waterfall"), title: Schema.String, p50Ms: Schema.optionalKey(Schema.Finite), slowMs: Schema.optionalKey(Schema.Finite), spans: Schema.Array(Schema.Struct({ label: Schema.String, service: Schema.String, durationMs: Schema.Finite, offsetMs: Schema.Finite, status: Schema.Literals(["ok", "slow", "error"]), handle: OptHandle })) }),
  Schema.Struct({ kind: Schema.Literal("metric_compare"), title: Schema.String, rows: Schema.Array(Schema.Struct({ label: Schema.String, before: Schema.String, after: Schema.String, beforeNum: Schema.optionalKey(Schema.Finite), afterNum: Schema.optionalKey(Schema.Finite), unit: Schema.optionalKey(Schema.String), delta: Schema.String, tone: Tone, handle: OptHandle })) }),
  Schema.Struct({ kind: Schema.Literal("commit_risk"), title: Schema.String, commits: Schema.Array(Schema.Struct({ sha: Schema.String, subject: Schema.String, files: Schema.Int, insertions: Schema.Int, deletions: Schema.Int, flags: Schema.Array(Schema.String), deployed: Schema.Boolean, handle: OptHandle })) }),
  Schema.Struct({ kind: Schema.Literal("timeline"), title: Schema.String, events: Schema.Array(Schema.Struct({ at: Schema.Union([Schema.Finite, Schema.String]), label: Schema.String, kind: Schema.Literals(["deploy", "spike", "span", "finding", "fix"]), handle: OptHandle })) }),
  Schema.Struct({ kind: Schema.Literal("key_facts"), title: Schema.String, facts: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String, origin: Origin, handle: OptHandle })) }),
]);
export const LensSpecSchema = Schema.Struct({
  source: Schema.Literals(["ai", "derived"]), title: Schema.String, summary: Schema.String,
  model: Schema.optionalKey(Schema.String), generatedAt: Schema.Finite, verifiedHandles: Schema.Array(Schema.String), blocks: Schema.Array(LensBlockSchema), });
export type LensBlock = typeof LensBlockSchema.Type;
export type LensSpec = typeof LensSpecSchema.Type;

/** Strips any handle not present in `valid` and computes the canonical verifiedHandles list. */
export function verifyLens(spec: LensSpec, valid: ReadonlySet<string>): LensSpec {
  const used = new Set<string>();
  const keep = <T extends { readonly handle?: string }>(item: T): T => {
    if (!item.handle) return item;
    if (valid.has(item.handle)) { used.add(item.handle); return item; }
    const { handle: _, ...rest } = item;
    return rest as T;
  };
  const blocks: LensBlock[] = spec.blocks.map((b) =>
    b.kind === "causal_flow" ? { ...b, steps: b.steps.map(keep) } : b.kind === "span_waterfall" ? { ...b, spans: b.spans.map(keep) }
      : b.kind === "metric_compare" ? { ...b, rows: b.rows.map(keep) } : b.kind === "commit_risk" ? { ...b, commits: b.commits.map(keep) }
      : b.kind === "timeline" ? { ...b, events: b.events.map(keep) } : { ...b, facts: b.facts.map(keep) });
  for (const h of spec.verifiedHandles) if (valid.has(h)) used.add(h);
  return { ...spec, verifiedHandles: [...used].sort(), blocks };
}

const SLOW_RE = /^SLOW\s+(\d+(?:\.\d+)?)ms\s+(\S+)\s+(.+?)(?:\s+trace=(\S+))?$/;

const evidenceOf = Effect.fnUntraced(function* (id: string) {
  return yield* sql.all<{ handle: string; source: string; text: string; origin: string | null }>(
    `SELECT e.handle, e.source, e.text, coalesce(o.origin, 'generated') AS origin FROM evidence e
     JOIN runs r ON r.id = e.run_id JOIN jobs j ON j.id = r.job_id LEFT JOIN origins o ON o.handle = e.handle
     WHERE j.subject = ? AND j.kind <> 'trial' ORDER BY e.rowid`, id); });

/** Deterministic grounded LensSpec built purely from SQLite facts, plus any stored verified AI lens. */
export const lensesFor = Effect.fnUntraced(function* (id: string) {
  const inc = yield* sql.get<{ id: string; app: string; environment: string; source: string; title: string; severity: string; count: number; exact: number; first_ms: number; last_ms: number }>("SELECT id, app, environment, source, title, severity, count, exact, first_ms, last_ms FROM incidents WHERE id = ?", id);
  if (!inc) return { lens: undefined as LensSpec | undefined, lenses: [] as LensSpec[] };
  const ev = yield* evidenceOf(id);
  const valid = new Set(ev.map((e) => e.handle));
  const lines = yield* sql.all<{ at_ms: number; text: string }>("SELECT at_ms, text FROM lines WHERE incident = ? ORDER BY at_ms DESC LIMIT 40", id);
  const onset = (yield* sql.get<{ at_ms: number }>("SELECT at_ms FROM onsets WHERE incident = ?", id))?.at_ms ?? inc.first_ms;
  const deploys = yield* sql.all<{ revision: string; previous: string | null; seq: number }>("SELECT revision, previous, seq FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 2", inc.app, inc.environment);
  const inv = yield* sql.get<{ result: string | null }>("SELECT result FROM jobs WHERE kind = 'investigation' AND subject = ? AND state = 'completed' ORDER BY created_seq DESC LIMIT 1", id);
  const fix = yield* sql.get<{ id: string; state: string; data: string }>("SELECT id, state, data FROM fixes WHERE incident = ? ORDER BY seq DESC LIMIT 1", id);
  const appCommits = (yield* commits).filter((c: CommitSummary) => c.app === inc.app).slice(0, 6);
  const firstTelemetry = ev.find((e) => e.origin === "telemetry")?.handle;
  const firstCode = ev.find((e) => e.origin === "code")?.handle;
  const blocks: LensBlock[] = [];

  // 1. Key facts grounded in SQLite + evidence handles
  const facts: Array<{ label: string; value: string; origin: "telemetry" | "code" | "history" | "generated"; handle?: string }> = [
    { label: "Occurrences", value: `${inc.exact ? inc.count : `${inc.count}+`} (${inc.exact ? "exact" : "lower bound"})`, origin: "telemetry", ...(firstTelemetry ? { handle: firstTelemetry } : {}) },
    { label: "Environment", value: `${inc.app}/${inc.environment}`, origin: "generated" },
    ...(deploys[0] ? [{ label: "Deployed", value: deploys[0].revision.slice(0, 12), origin: "history" as const, ...(firstCode ? { handle: firstCode } : {}) }] : []),
  ];
  const res = inv?.result ? (JSON.parse(inv.result) as { verdict: string; observed: boolean; planned: number; counts: Record<string, number>; challenge: { outcome: string | null } | null }) : null;
  if (res) facts.push({ label: "Adjudication", value: `${res.verdict.replace("_", " ")} (${res.counts.real ?? 0}/${res.planned} real${res.challenge?.outcome ? `, challenger ${res.challenge.outcome}` : ""})`, origin: res.observed ? "telemetry" : "generated", ...(firstTelemetry ? { handle: firstTelemetry } : {}) });
  if (fix) facts.push({ label: "Fix candidate", value: `${fix.state.replace("_", " ")} (${fix.id})`, origin: "code", ...(firstCode ? { handle: firstCode } : {}) });
  blocks.push({ kind: "key_facts", title: "At a glance", facts });

  // 2. Span waterfall when stored telemetry lines contain SLOW <ms>ms span observations
  const parsedSpans = lines.flatMap((l) => {
    const m = SLOW_RE.exec(l.text);
    return m ? [{ at: l.at_ms, durationMs: Number(m[1]), service: m[2]!, label: m[3]!, status: (Number(m[1]) >= 1000 ? "error" : "slow") as "slow" | "error" }] : [];
  });
  if (parsedSpans.length) {
    const sorted = [...parsedSpans].sort((a, b) => a.durationMs - b.durationMs);
    const p50Ms = sorted[Math.floor(sorted.length / 2)]!.durationMs;
    const minAt = Math.min(...parsedSpans.map((s) => s.at));
    blocks.push({
      kind: "span_waterfall", title: "Slow span latency", p50Ms, slowMs: sorted[0]!.durationMs,
      spans: parsedSpans.slice(0, 8).map((s) => ({ label: s.label, service: s.service, durationMs: s.durationMs, offsetMs: Math.max(0, s.at - minAt), status: s.status, ...(firstTelemetry ? { handle: firstTelemetry } : {}) })), });
  }

  // 3. Causal flow connecting rollout -> symptom -> adjudication -> fix
  const steps: Array<{ label: string; detail: string; tone: "neutral" | "warn" | "error" | "ok"; handle?: string }> = [];
  if (deploys[0]) steps.push({ label: "Rollout", detail: `${deploys[0].previous ? `${deploys[0].previous.slice(0, 8)} → ` : ""}${deploys[0].revision.slice(0, 12)}`, tone: "neutral", ...(firstCode ? { handle: firstCode } : {}) });
  steps.push({ label: "Symptom", detail: clean(inc.title, 120), tone: inc.severity === "error" ? "error" : "warn", ...(firstTelemetry ? { handle: firstTelemetry } : {}) });
  if (res) steps.push({ label: "Verdict", detail: `${res.verdict.replace("_", " ")} (${res.counts.real ?? 0}/${res.planned} real)`, tone: res.verdict === "real" ? "error" : res.verdict === "not_real" ? "ok" : "warn", ...(firstTelemetry ? { handle: firstTelemetry } : {}) });
  if (fix) steps.push({ label: "Fix", detail: `${fix.state.replace("_", " ")}: ${clean(String((JSON.parse(fix.data) as { summary?: string }).summary ?? fix.id), 120)}`, tone: fix.state === "verified" || fix.state === "published" ? "ok" : "warn", ...(firstCode ? { handle: firstCode } : {}) });
  if (steps.length >= 2) blocks.push({ kind: "causal_flow", title: "Causal path", steps });

  // 4. Recent commits risk map for this app
  if (appCommits.length) {
    blocks.push({ kind: "commit_risk", title: "Recent commits", commits: appCommits.map((c) => ({ sha: c.sha.slice(0, 12), subject: c.subject, files: c.files, insertions: c.insertions, deletions: c.deletions, flags: c.flags, deployed: c.deployedEnvs.includes(inc.environment), ...(firstCode ? { handle: firstCode } : {}) })) });
  }

  // 5. Timeline strip
  const events: Array<{ at: number; label: string; kind: "deploy" | "spike" | "span" | "finding" | "fix"; handle?: string }> = [
    { at: onset, label: parsedSpans.length ? `First slow span (${parsedSpans.at(-1)!.durationMs}ms)` : "First observed occurrence", kind: parsedSpans.length ? "span" : "spike", ...(firstTelemetry ? { handle: firstTelemetry } : {}) },
    ...(inc.last_ms > onset ? [{ at: inc.last_ms, label: `Latest occurrence (${inc.exact ? inc.count : `${inc.count}+`} total)`, kind: "spike" as const }] : []),
  ];
  blocks.push({ kind: "timeline", title: "Event timeline", events: events.sort((a, b) => a.at - b.at) });

  const derived = verifyLens({
    source: "derived", title: clean(inc.title, 120),
    summary: res ? `${res.verdict.replace("_", " ")} (${res.counts.real ?? 0}/${res.planned} real) in ${inc.app}/${inc.environment}` : `${inc.exact ? inc.count : `${inc.count}+`} occurrences in ${inc.app}/${inc.environment}`,
    generatedAt: clock.now(), verifiedHandles: [...valid], blocks,
  }, valid);

  const stored = yield* sql.get<{ spec: string }>("SELECT spec FROM lenses WHERE incident = ?", id);
  let ai: LensSpec | undefined;
  if (stored) {
    const decoded = Schema.decodeUnknownOption(LensSpecSchema)(JSON.parse(stored.spec));
    if (Option.isSome(decoded)) ai = verifyLens(decoded.value, valid);
  }
  return { lens: ai ?? derived, lenses: ai ? [ai, derived] : [derived] };
});

/** POST /v2/items/:id/lens: asks OpenCode (with a committed Permit) to synthesize a grounded LensSpec JSON. */
export const generateLens = Effect.fn("generateLens")(function* (id: string) {
  const store = yield* Store, config = yield* AppConfig;
  const inc = yield* store.get<{ id: string; app: string; environment: string; title: string; count: number; exact: number }>("SELECT id, app, environment, title, count, exact FROM incidents WHERE id = ?", id);
  if (!inc) return yield* apiError(404, `no item ${id}`);
  if (!policyFor(config, inc.app, inc.environment).genUi) return yield* apiError(403, `AI lens generation is disabled for ${inc.app}/${inc.environment} (genUi)`);
  const oc = yield* (yield* OpenCodeClient).connect;
  if (!oc) return yield* apiError(503, "OpenCode is not running; start OpenCode to generate an AI lens");
  const ev = yield* evidenceOf(id), valid = new Set(ev.map((e) => e.handle)), emptyDir = yield* emptyFolder(config.dataDir);
  const session = `ses_${randomBytes(12).toString("hex")}`, msg = `msg_${randomBytes(12).toString("hex")}`;
  const evidenceText = ev.slice(0, 20).map((e) => `[${e.handle} | ${e.origin} | ${e.source}] ${clean(e.text, 240)}`).join("\n");
  const prompt = `Return ONLY valid JSON matching LensSpec {source:"ai",title,summary,generatedAt,verifiedHandles,blocks} for ${inc.app}/${inc.environment} problem "${inc.title}" (${inc.exact ? inc.count : `${inc.count}+`}). Allowed block kinds: causal_flow, span_waterfall, metric_compare, commit_risk, timeline, key_facts. Cite ONLY these evidence handles (never invent handles or quotes):\n${evidenceText || "(no evidence handles yet)"}`;
  const said = yield* Effect.gen(function* () {
    yield* oc.createSession(yield* store.permit("peer", id, { lens: session }), { id: session, title: `Overwatch lens: ${clean(inc.title, 80)}`, agent: "ow-responder", model: config.opencode.model, directory: emptyDir });
    yield* oc.prompt(yield* store.permit("peer", id, { lens: msg }), session, { id: msg, text: prompt });
    const done = yield* oc.messages(session).pipe(Effect.map((h) => after(h, msg)), Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (a) => a.idle }), Effect.timeoutOption("60 seconds"));
    if (done._tag === "None" || done.value.outcome === "failed" || !done.value.said.trim()) return yield* apiError(503, "OpenCode did not return a lens in time");
    return done.value.said.trim();
  }).pipe(Effect.catchTags({ Unavailable: (e) => apiError(503, errorText(e, 200)), PeerError: (e) => apiError(503, errorText(e, 200)) }));
  const raw = said.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LensSpecSchema))(raw).pipe(Effect.mapError(() => apiError(503, "model returned invalid LensSpec JSON; falling back to derived lens")));
  const grounded = verifyLens({ ...parsed, source: "ai", model: config.opencode.model ?? parsed.model ?? "opencode", generatedAt: clock.now() }, valid);
  yield* store.tx((w) => Effect.gen(function* () {
    const seq = yield* w.event("lens", id as Clean, { source: "ai", handles: grounded.verifiedHandles.length, blocks: grounded.blocks.length });
    yield* w.run("INSERT OR REPLACE INTO lenses (incident, spec, seq) VALUES (?, ?, ?)", id as Clean, json(grounded), seq); }));
  return { lens: grounded }; });

/** GET /v2/items/:id/handoff: structured, evidence-grounded mission brief for an interactive OpenCode session. */
export const buildHandoff = Effect.fn("buildHandoff")(function* (id: string) {
  const config = yield* AppConfig;
  const inc = yield* sql.get<{ id: string; app: string; environment: string; title: string; severity: string; count: number; exact: number }>("SELECT id, app, environment, title, severity, count, exact FROM incidents WHERE id = ?", id);
  if (!inc) return yield* apiError(404, `no item ${id}`);
  const app = config.apps[inc.app], checkout = app?.checkout ?? "", policy = policyFor(config, inc.app, inc.environment);
  const deployRow = yield* sql.get<{ revision: string; previous: string | null }>("SELECT revision, previous FROM deploys WHERE app = ? AND environment = ? ORDER BY seq DESC LIMIT 1", inc.app, inc.environment);
  const deploy = deployRow?.revision ?? null, previousDeploy = deployRow?.previous ?? null;
  const ev = yield* evidenceOf(id), handles = ev.slice(0, 12).map((e) => ({ handle: e.handle, source: e.source, origin: e.origin ?? "generated", text: clean(e.text, 240) }));
  const inv = yield* sql.get<{ result: string | null }>("SELECT result FROM jobs WHERE kind = 'investigation' AND subject = ? AND state = 'completed' ORDER BY created_seq DESC LIMIT 1", id);
  const fix = yield* sql.get<{ id: string; state: string; data: string }>("SELECT id, state, data FROM fixes WHERE incident = ? ORDER BY seq DESC LIMIT 1", id);
  const res = inv?.result ? (JSON.parse(inv.result) as { verdict: string; counts: Record<string, number>; planned: number; challenge: { outcome: string | null } | null }) : null;
  const hasDb = config.databases.some((d) => d.app === inc.app && d.environment === inc.environment);
  const mcpTools = ["ow_get", "ow_handoff", "ow_search", "ow_brief", "ow_outlook", ...(hasDb ? ["ow_db"] : []), "ow_investigate", "ow_correct", "ow_act"];
  const commands: string[] = [];
  if (checkout && deploy && previousDeploy) commands.push(`git -C ${checkout} log --stat ${previousDeploy}..${deploy}`, `git -C ${checkout} diff ${previousDeploy}..${deploy}`);
  else if (checkout && deploy) commands.push(`git -C ${checkout} show --stat ${deploy}`);
  for (const v of app?.fixes?.verify ?? []) commands.push(v.join(" "));
  const verdictLine = res ? `${res.verdict.replace("_", " ")} (${res.counts.real ?? 0}/${res.planned} real${res.challenge?.outcome ? `, challenger ${res.challenge.outcome}` : ""})` : "not yet investigated";
  const fixLine = fix ? `${fix.state} (${fix.id}${Predicate.isString((JSON.parse(fix.data) as { summary?: string }).summary) ? `: ${(JSON.parse(fix.data) as { summary?: string }).summary}` : ""})` : "none";
  const prompt = [
    `Overwatch focus: ${id} (${inc.app}/${inc.environment} — ${inc.title}).`,
    `Count: ${inc.exact ? inc.count : `${inc.count}+`}${checkout ? ` | Checkout: ${checkout}` : ""}${deploy ? ` | Deployed: ${deploy.slice(0, 12)}${previousDeploy ? ` (prev ${previousDeploy.slice(0, 12)})` : ""}` : ""}.`,
    `Investigation: ${verdictLine}. Fix: ${fixLine}. Policy: investigate=${policy.investigate}, readings=${policy.readings}, fixMode=${policy.fixMode}.`,
    ...(handles.length ? [`Top evidence: ${handles.slice(0, 4).map((h) => `${h.handle} (${h.origin}/${h.source})`).join(", ")}.`] : []),
    `Read full detail with ow_get {"id": "${id}"}; search history with ow_search; check outlook/commits with ow_outlook${hasDb ? "; run read-only DB queries with ow_db" : ""}; ask the owner before ow_investigate, ow_correct, or ow_act.`,
  ].join("\n");
  const markdown = [
    `# Overwatch Handoff: ${inc.title}`, `- **ID**: \`${id}\` | **Target**: \`${inc.app}/${inc.environment}\` | **Count**: ${inc.exact ? inc.count : `${inc.count}+`} (${inc.severity})`,
    ...(checkout ? [`- **Checkout**: \`${checkout}\``] : []), ...(deploy ? [`- **Revision**: \`${deploy}\`${previousDeploy ? ` (previous \`${previousDeploy}\`)` : ""}`] : []),
    `- **Investigation**: ${verdictLine} | **Fix**: ${fixLine} | **Policy**: investigate=${policy.investigate}, readings=${policy.readings}, fixMode=${policy.fixMode}`,
    ...(handles.length ? ["", "## Evidence Handles", ...handles.map((h) => `- \`${h.handle}\` (${h.origin}, ${h.source}): ${h.text}`)] : []),
    ...(commands.length ? ["", "## Local Commands", "```sh", ...commands, "```"] : []),
    "", "## Overwatch MCP Tools", `Use \`ow_get {"id":"${id}"}\`, \`ow_handoff {"id":"${id}"}\`, \`ow_search\`, \`ow_brief\`, \`ow_outlook\`${hasDb ? ", `ow_db`" : ""}, and confirm before \`ow_investigate\`, \`ow_correct\`, or \`ow_act\`.`,
  ].join("\n");
  return { id, title: inc.title, app: inc.app, env: inc.environment, policy, checkout, deploy, previousDeploy, handles, mcpTools, commands, prompt, markdown }; });
