/**
 * The MCP server sessions reach Overwatch through.
 *
 * - Reads on the model (the inbox, an incident, a thread, search) come from Alchemy's `toMcp`, with an explicit
 *   allowlist.
 * - `query_telemetry` and `file_finding` are written by hand, because they must know which session is calling:
 *   OpenCode sends it as `_meta["ai.opencode/sessionID"]`, which `toMcp` does not pass on. Each call also carries the
 *   run's token. A call whose token names another session's run, or a finished run, is refused. What
 *   `query_telemetry` returns is recorded as shown to that session, and a finding's quotes are checked against what
 *   the session was shown, the brief, and the files in its working directory.
 */
import type { DatabaseSync } from "node:sqlite";
import * as DomainAi from "@alchemy.run/domain/Ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { verifyCitations } from "../collect/citations.ts";
import { iso, queryWindow } from "../collect/duration.ts";
import type { Options } from "../collect/options.ts";
import { validateFinding, type Finding as LegacyFinding } from "../collect/report.ts";
import { sourceContext, type Runtime } from "../collect/runtime.ts";
import { sourceType } from "../collect/sources/index.ts";
import { FindingInput, type Finding } from "../domain/finding.ts";
import { OverwatchApi } from "../domain/model.ts";
import { recordShown, shownFor, tokenRow, type TokenRow } from "./tables.ts";

export const SESSION_META = "ai.opencode/sessionID";
export const MCP_SERVER_NAME = "overwatch";

/** The `toMcp` tools: reads only. Names are `OverwatchApi_<name>_<operation>`. */
export const EXPOSED = ["Inbox.get", "IncidentPage.get", "ThreadPage.get", "Search"] as const;
export const EXPOSED_TOOL_NAMES = ["OverwatchApi_Inbox_get", "OverwatchApi_IncidentPage_get", "OverwatchApi_ThreadPage_get", "OverwatchApi_Search"];
export const SESSION_TOOL_NAMES = ["query_telemetry", "file_finding"];

export interface McpPorts {
  readonly options: Options;
  readonly runtime: Runtime;
  readonly read: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>;
  /** The run's state, to refuse calls for a finished run. */
  readonly runStatus: (runId: string) => Promise<string | undefined>;
  readonly incident: (id: string) => Promise<{ readonly app: string; readonly environment: string } | undefined>;
  readonly worktree: (threadId: string) => Promise<string | undefined>;
  readonly complete: (runId: string, sessionId: string, finding: Finding) => Promise<void>;
  readonly now: () => number;
}

const QueryTelemetry = Tool.make("query_telemetry", {
  description:
    "Read-only telemetry for the incident your run is about. `source` is one of the environment's telemetry sources; since/until take an ISO time or a duration back from now such as \"6h\" (defaults: 1h back to now); `args` are source-specific (kubernetes: { verb: get|describe|logs|top, args: string[] }). Everything returned is recorded as shown to your session.",
  parameters: Schema.Struct({
    token: Schema.String,
    source: Schema.String,
    since: Schema.optionalKey(Schema.String),
    until: Schema.optionalKey(Schema.String),
    args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  success: Schema.String,
  dependencies: [McpSchema.McpRequestContext],
});

const FileFinding = Tool.make("file_finding", {
  description:
    "File your run's finding, once, at the end. Lead with the verdict, cite evidence for every claim, stay within the limits. Each quote is checked by code against what you were shown (the brief, query_telemetry results) or the file it names in your working directory; a finding with a quote that is not there is refused with the reason. Nothing found is a valid answer (verdict unsure).",
  parameters: Schema.Struct({ token: Schema.String, finding: Schema.Unknown }),
  success: Schema.String,
  dependencies: [McpSchema.McpRequestContext],
});

export const SessionTools = Toolkit.make(QueryTelemetry, FileFinding);

/** Who is calling: the session from the call's metadata, and the run its token names. Refuses anything else. */
async function authorize(ports: McpPorts, sessionId: string | undefined, token: string): Promise<{ ok: true; row: TokenRow } | { ok: false; error: string }> {
  if (!sessionId) return { ok: false, error: "Refused: this call carries no OpenCode session id." };
  const row = await ports.read((db) => tokenRow(db, token));
  if (!row) return { ok: false, error: "Refused: unknown run token." };
  if (row.session_id !== sessionId) return { ok: false, error: `Refused: the token belongs to another session's run (${row.run_id}).` };
  if (row.role !== "investigator") return { ok: false, error: "Refused: this run's role may not use this tool." };
  const status = await ports.runStatus(row.run_id);
  if (status === "completed" || status === "failed" || status === undefined) return { ok: false, error: `Refused: run ${row.run_id} is finished.` };
  return { ok: true, row };
}

const sessionOf = Effect.map(Effect.service(McpSchema.McpRequestContext), (ctx) => {
  const meta = ctx.requestMetadata as Record<string, unknown> | undefined;
  return typeof meta?.[SESSION_META] === "string" ? (meta[SESSION_META] as string) : undefined;
});

export function sessionToolsLayer(ports: McpPorts) {
  return SessionTools.toLayer({
    query_telemetry: (input) =>
      Effect.flatMap(sessionOf, (sessionId) => Effect.promise(() => queryTelemetry(ports, sessionId, input))),
    file_finding: (input) => Effect.flatMap(sessionOf, (sessionId) => Effect.promise(() => fileFinding(ports, sessionId, input))),
  });
}

export async function queryTelemetry(
  ports: McpPorts,
  sessionId: string | undefined,
  input: { readonly token: string; readonly source: string; readonly since?: string; readonly until?: string; readonly args?: Readonly<Record<string, unknown>> },
): Promise<string> {
  const auth = await authorize(ports, sessionId, input.token);
  if (!auth.ok) return auth.error;
  const incident = await ports.incident(auth.row.subject);
  if (!incident) return "Refused: the run's incident is unknown.";
  const env = ports.options.apps[incident.app]?.environments[incident.environment];
  const config = env?.sources[input.source];
  const type = config ? sourceType(config.type) : undefined;
  if (!env || !config || !type) {
    return `Unknown source "${input.source}". This incident's sources: ${Object.keys(env?.sources ?? {}).join(", ") || "none"}.`;
  }
  const window = queryWindow(input, ports.now());
  if ("error" in window) return `Query not run: ${window.error}`;
  let text: string;
  try {
    text =
      (await type.query(
        config,
        { ...window, args: input.args ?? {} },
        sourceContext(ports.runtime, incident.app, incident.environment, input.source, AbortSignal.timeout(ports.options.timeouts.sourceMs + 5_000)),
      )) || "(no output)";
  } catch (error) {
    return `Query refused or failed: ${(error as Error).message}`;
  }
  await ports.atomically((db) =>
    recordShown(db, {
      sessionId: sessionId!,
      threadId: auth.row.thread_id,
      runId: auth.row.run_id,
      source: input.source,
      text: `query_telemetry ${input.source} ${iso(window.since)} to ${iso(window.until)} ${JSON.stringify(input.args ?? {})}\n${text}`,
      at: ports.now(),
    }),
  );
  return text;
}

export async function fileFinding(ports: McpPorts, sessionId: string | undefined, input: { readonly token: string; readonly finding: unknown }): Promise<string> {
  const auth = await authorize(ports, sessionId, input.token);
  if (!auth.ok) return auth.error;
  const decoded = Schema.decodeUnknownExit(FindingInput)(input.finding);
  if (decoded._tag === "Failure") {
    return `Not recorded: the finding does not match the schema. ${String(decoded.cause).slice(0, 1200)}`;
  }
  const finding = decoded.value;
  const legacy: LegacyFinding = {
    product: finding.product,
    engineering: { ...finding.engineering, evidence: [...finding.engineering.evidence], notChecked: [...finding.engineering.notChecked] },
  };
  const limits = validateFinding(legacy);
  if (!limits.ok) return `Not recorded:\n- ${limits.errors.join("\n- ")}`;
  const incident = await ports.incident(auth.row.subject);
  const env = incident ? ports.options.apps[incident.app]?.environments[incident.environment] : undefined;
  const directory = await ports.worktree(auth.row.thread_id);
  const shown = await ports.read((db) => shownFor(db, sessionId!));
  const checked = await verifyCitations(legacy, { shown, sources: Object.keys(env?.sources ?? {}), ...(directory ? { directory } : {}) });
  if (checked.errors.length) return `Not recorded. Fix these and file again:\n- ${checked.errors.join("\n- ")}`;
  const recorded: Finding = {
    product: finding.product,
    engineering: {
      ...finding.engineering,
      evidence: checked.finding.engineering.evidence.map((e) => ({ source: e.source, quote: e.quote, verified: e.verified === true })),
    },
    ruledOut: [...(finding.ruledOut ?? [])],
  };
  await ports.complete(auth.row.run_id, sessionId!, recorded);
  return "Recorded. Stop now.";
}

/** The whole MCP server as a Layer: the hand-written tools and the allowlisted model reads. */
export function mcpLayer(ports: McpPorts, version: string) {
  const tools = McpServer.toolkit(SessionTools).pipe(Layer.provide(sessionToolsLayer(ports)));
  const reads = DomainAi.toMcp(OverwatchApi, { expose: [...EXPOSED] });
  return Layer.mergeAll(tools, reads).pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name: MCP_SERVER_NAME,
        version,
        path: "/mcp",
        protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
      }),
    ),
  );
}
