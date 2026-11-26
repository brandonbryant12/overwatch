/**
 * The investigation tools a session calls through MCP. A call is tied to its run only by the session ID OpenCode
 * attaches to it; nothing in a prompt or an argument grants access.
 *
 * Evidence by handle: every piece of telemetry, code or history is cut into pieces, cleaned, bounded to 16 KiB and
 * stored with an unpredictable handle *before* it is returned. A filing cites handles; it never supplies a quote or a
 * source. Every cited handle must have been delivered to this same attempt, or the whole filing is refused with the
 * handles that are valid. The owner's question, instructions, tool arguments and other findings get no handle, so
 * they cannot be cited.
 */
import { createHash, randomBytes } from "node:crypto";
import { LIMITS, type Config } from "./config.ts";
import { afterFinding } from "./inbox.ts";
import { clock } from "./clock.ts";
import { run as exec } from "./exec.ts";
import { clean, truncate } from "./redact.ts";
import { json, type Clean, type Store } from "./store.ts";

export interface Code {
  readonly expected: string | null;
  readonly read: string | null;
  readonly deployed: boolean;
}

/** What a run may read: its telemetry lines (by source name) and the repository its pinned commit is in. */
export type Origin = "telemetry" | "code" | "history" | "generated";
export interface RunContext {
  readonly telemetry: Readonly<Record<string, ReadonlyArray<{ at: number; text: string; origin?: Origin }>>>;
  readonly repo: string | null;
  /** The run's end on the service's monotonic clock: the same value the driver waits on. */
  readonly deadline: number;
  /** What the run may do: an investigator files a finding, a challenger a challenge, a responder only reads, a fixer selects. */
  readonly role?: "investigator" | "challenger" | "responder" | "fixer";
  /** A fixer's choices, computed by code: the commits it may revert and the JSON keys it may restore. */
  readonly options?: Options;
}
export interface Options {
  readonly commits: ReadonlyArray<{ sha: string; subject: string }>;
  readonly keys: ReadonlyArray<{ path: string; key: string }>;
}
export type Proposal = { kind: "revert"; commit: string } | { kind: "setting"; path: string; key: string } | { kind: "abstain" };

/**
 * The owner's own operations, for ordinary OpenCode sessions: the same functions the page calls. `exists` asks the
 * OpenCode peer whether a session is there; a session Overwatch runs (any role, even retired) is never an owner.
 */
export interface Owner {
  exists(sessionId: string): Promise<boolean>;
  inbox(): unknown;
  get(id: string): unknown;
  search(text: string): unknown;
  act(id: string, body: Record<string, unknown>): unknown;
}
const OWNER_TOOLS = ["ow_inbox", "ow_get", "ow_search", "ow_act"];

export interface Piece {
  readonly handle: string;
  readonly source: string;
  readonly text: string;
}

export class Refusal extends Error {}

/** Pieces one telemetry call returns at most. */
const PAGE = 50;

interface RunRow {
  id: string;
  session_id: string;
  state: string;
  calls: number;
  code: string;
}

const FINDING_KEYS = ["verdict", "cause", "claims", "ruled_out", "not_checked", "next_check", "impact", "affected", "since", "status"];

export class Tools {
  /** Runs this process dispatched, with what they may read. A run from another process or timeline has none. */
  readonly contexts = new Map<string, RunContext>();
  /** What each run's model wrote into tool arguments, for the trial's "obeyed" check. */
  readonly authored = new Map<string, string[]>();

  private readonly store: Store;
  owner: Owner | null = null;
  constructor(store: Store) {
    this.store = store;
  }

  list() {
    const str = { type: "string" }, int = { type: "integer" };
    const closed = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
    return [
      {
        name: "ow_telemetry",
        description: "Read this investigation's telemetry as evidence pieces, 50 per call, oldest first. To read further, call again with the same arguments and cursor set to nextCursor.",
        inputSchema: closed({ source: str, since: int, until: int, query: str, cursor: str }, ["source"]),
      },
      { name: "ow_code_search", description: "Search the pinned commit for literal text.", inputSchema: closed({ pattern: str, path: str }, ["pattern"]) },
      { name: "ow_code_read", description: "Read lines of a file at the pinned commit.", inputSchema: closed({ path: str, from: int, to: int }, ["path", "from", "to"]) },
      { name: "ow_history", description: "Commits at the pinned commit.", inputSchema: closed({ path: str, ref: str }) },
      { name: "ow_challenge", description: "File the challenge: upheld, disproved or unsure, with a reason and evidence handles you were given.", inputSchema: closed({ outcome: { type: "string", enum: ["upheld", "disproved", "unsure"] }, reason: str, evidence: { type: "array", items: str } }, ["outcome", "reason", "evidence"]) },
      {
        name: "ow_proposal",
        description: "Select exactly one change from the options you were given: {kind:\"revert\", commit} (commit may be left out when there is one), {kind:\"setting\", path, key}, or {kind:\"abstain\"}. You never write the change itself.",
        inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["revert", "setting", "abstain"] }, commit: str, path: str, key: str }, required: ["kind"], additionalProperties: false },
      },
      { name: "ow_inbox", description: "The owner's inbox: four groups of problem IDs, as the page shows them.", inputSchema: closed({}) },
      { name: "ow_get", description: "One problem in full: counts, way out, history, findings, investigations, questions.", inputSchema: closed({ id: str }, ["id"]) },
      { name: "ow_search", description: "Literal, case-insensitive search over problems, evidence, findings and questions.", inputSchema: closed({ text: str }, ["text"]) },
      {
        name: "ow_act",
        description: "Put a problem away (done, later, never), undo the current way out (with its actionSeq), or mark it seen. Confirm with the owner first.",
        inputSchema: closed({ id: str, action: { type: "string", enum: ["done", "later", "never", "undo", "seen"] }, until: int, when: str, reason: str, actionSeq: int, throughSeq: int }, ["id", "action"]),
      },
      {
        name: "ow_finding",
        description: "File the finding. Each claim cites evidence handles you were given.",
        inputSchema: closed(
          {
            verdict: { type: "string", enum: ["real", "not_real", "unsure"] },
            cause: str,
            claims: { type: "array", items: closed({ statement: str, evidence: { type: "array", items: str } }, ["statement", "evidence"]) },
            ruled_out: { type: "array", items: str },
            not_checked: { type: "array", items: str },
            next_check: str,
            impact: str,
            affected: { type: "array", items: str },
            since: { type: ["integer", "null"] },
            status: str,
          },
          FINDING_KEYS,
        ),
      },
    ];
  }

  private ownerCall(sessionId: string, name: string, input: Record<string, unknown>) {
    return ownerCall.call(this, this.store, sessionId, name, input);
  }

  /** One tool call. Counts toward the run's budget whether it succeeds or not. */
  async call(sessionId: unknown, name: string, args: unknown): Promise<unknown> {
    if (typeof sessionId !== "string" || !sessionId) throw new Refusal("the call carries no OpenCode session id");
    if (OWNER_TOOLS.includes(name)) return this.ownerCall(sessionId, name, object(args, name));
    const run = this.store.get<RunRow>("SELECT id, session_id, state, calls, code FROM runs WHERE session_id = ?", sessionId);
    const context = run ? this.contexts.get(run.id) : undefined;
    if (!run || run.state !== "active" || !context) throw new Refusal("this session has no active Overwatch investigation");
    if (run.calls >= LIMITS.toolCallsPerRun) throw new Refusal(`this investigation has used its ${LIMITS.toolCallsPerRun} tool calls`);
    if (clock.mono() >= context.deadline) throw new Refusal("this investigation's five minutes have passed");
    this.authored.get(run.id)?.push(JSON.stringify(args));
    this.store.tx((w) => {
      w.run("UPDATE runs SET calls = calls + 1 WHERE id = ?", run.id as Clean);
      w.event("run", run.id as Clean, { tool: name, call: run.calls + 1 });
    });
    const input = object(args, name);
    const code = JSON.parse(run.code) as Code;
    const role = context.role ?? "investigator";
    if (name === "ow_finding" && role !== "investigator") throw new Refusal("this session cannot file a finding");
    if (name === "ow_challenge" && role !== "challenger") throw new Refusal("only a challenger files a challenge");
    if (role === "fixer" ? name !== "ow_telemetry" && name !== "ow_proposal" : name === "ow_proposal") throw new Refusal(role === "fixer" ? "a fixer reads telemetry and files one proposal" : "only a fixer files a proposal");
    switch (name) {
      case "ow_telemetry":
        return this.telemetry(run, context, input);
      case "ow_code_read":
      case "ow_code_search":
      case "ow_history":
        return { ...(await this.code(run, context, code, name, input)), code };
      case "ow_finding":
        return this.finding(run, code, input);
      case "ow_challenge":
        return this.challenge(run, code, input);
      case "ow_proposal":
        return this.proposal(run, context.options ?? { commits: [], keys: [] }, input);
      default:
        throw new Refusal(`unknown tool ${name}`);
    }
  }

  /** Stores pieces for a run (reusing a handle for the same text) and returns them, within the session's limits. */
  /** Stores pieces with their typed origin: what the evidence is (observed telemetry, code, history, generated text), whatever its source is called. */
  private deliver(run: RunRow, source: string, texts: ReadonlyArray<string>, origin: Origin | ReadonlyArray<Origin>): { pieces: Piece[]; truncated: boolean } {
    let truncated = false;
    const pieces: Piece[] = [];
    this.store.tx((w) => {
      for (const [n, raw] of texts.entries()) {
        const bounded = clean(raw, LIMITS.pieceBytes * 4);
        const text = truncate(bounded, LIMITS.pieceBytes) as Clean;
        if (text !== bounded) truncated = true;
        const ordinal = parseInt(createHash("sha256").update(text).digest("hex").slice(0, 12), 16);
        const existing = this.store.get<{ handle: string }>("SELECT handle FROM evidence WHERE run_id = ? AND source = ? AND ordinal = ?", run.id, source, ordinal);
        if (existing) {
          pieces.push({ handle: existing.handle, source, text });
          continue;
        }
        const count = this.store.get<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE run_id = ?", run.id)!.n;
        if (count >= LIMITS.piecesPerSession) {
          truncated = true;
          continue;
        }
        const handle = `e_${randomBytes(12).toString("hex")}`;
        w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, ?, ?, ?)", handle as Clean, run.id as Clean, run.session_id as Clean, source as Clean, text, ordinal);
        w.run("INSERT INTO origins (handle, origin) VALUES (?, ?)", handle as Clean, (typeof origin === "string" ? origin : origin[n]!) as Clean);
        pieces.push({ handle, source, text });
      }
      w.event("evidence", run.id as Clean, { source, pieces: pieces.length, truncated });
    });
    return { pieces, truncated };
  }

  private telemetry(run: RunRow, context: RunContext, input: Record<string, unknown>) {
    only(input, ["source", "since", "until", "query", "cursor"]);
    const source = input.source;
    if (typeof source !== "string" || !(source in context.telemetry)) throw new Refusal(`source must be one of: ${Object.keys(context.telemetry).join(", ")}`);
    const since = optionalInt(input.since, "since"), until = optionalInt(input.until, "until");
    if (input.query !== undefined && typeof input.query !== "string") throw new Refusal("query must be text");
    const query = input.query as string | undefined;
    const lines = context.telemetry[source]!.filter((l) => (since === null || l.at >= since) && (until === null || l.at <= until) && (!query || l.text.includes(query)));
    // One page per call in a stable order (time, then position). The cursor is bound to this run, source and filters:
    // following it resumes strictly after the page it came with; the same page again reuses its handles.
    const bind = createHash("sha256").update(JSON.stringify([run.id, source, since, until, query ?? null])).digest("hex").slice(0, 16);
    let offset = 0;
    if (input.cursor !== undefined) {
      const m = typeof input.cursor === "string" ? /^c(\d{1,9})_([0-9a-f]{16})$/.exec(input.cursor) : null;
      if (!m || m[2] !== bind) throw new Refusal("cursor is not one this investigation was given for these arguments");
      offset = Number(m[1]);
    }
    const ordered = lines.map((l, i) => ({ ...l, i })).sort((a, b) => a.at - b.at || a.i - b.i);
    const slice = ordered.slice(offset, offset + PAGE);
    const page = this.deliver(run, source, slice.map((l) => `${new Date(l.at).toISOString()} ${l.text}`), slice.map((l) => l.origin ?? "telemetry"));
    const nextCursor = offset + PAGE < ordered.length ? `c${offset + PAGE}_${bind}` : null;
    return { pieces: page.pieces, truncated: page.truncated, nextCursor };
  }

  private async code(run: RunRow, context: RunContext, code: Code, name: string, input: Record<string, unknown>) {
    if (!context.repo || !code.read) return { pieces: [], truncated: false };
    const git = (...args: string[]) => exec("git", ["-C", context.repo!, ...args], { timeoutMs: 30_000 });
    const path = (value: unknown, required: boolean) => {
      if (value === undefined && !required) return null;
      if (typeof value !== "string" || !/^[A-Za-z0-9._\-/]{1,300}$/.test(value) || value.split("/").includes("..") || value.startsWith("/")) throw new Refusal("path must be a relative path in the repository");
      return value;
    };
    if (name === "ow_code_read") {
      only(input, ["path", "from", "to"]);
      const file = path(input.path, true)!;
      const from = optionalInt(input.from, "from"), to = optionalInt(input.to, "to");
      if (from === null || to === null || from < 1 || to < from || to - from > 400) throw new Refusal("from and to are line numbers, from ≤ to, at most 400 lines");
      const r = await git("show", `${code.read}:${file}`);
      if (r.code !== 0) throw new Refusal(`${file} is not in commit ${code.read.slice(0, 12)}`);
      const lines = r.stdout.split("\n").slice(from - 1, to);
      return this.deliver(run, "code", [`${file}:${from}-${to}\n${lines.join("\n")}`], "code");
    }
    if (name === "ow_code_search") {
      only(input, ["pattern", "path"]);
      if (typeof input.pattern !== "string" || !input.pattern) throw new Refusal("pattern must be literal text");
      const file = path(input.path, false);
      const r = await git("grep", "-n", "-F", "-e", input.pattern, code.read, ...(file ? ["--", file] : []));
      const matches = r.stdout.split("\n").filter(Boolean).slice(0, 50).map((l) => l.slice(code.read!.length + 1));
      return this.deliver(run, "code", matches, "code");
    }
    only(input, ["path", "ref"]);
    if (input.ref !== undefined && input.ref !== code.read) throw new Refusal(`ref must be the pinned commit ${code.read}`);
    const file = path(input.path, false);
    const r = await git("log", "-n", "20", "--format=%H %ad %s", "--date=iso-strict", code.read, ...(file ? ["--", file] : []));
    return this.deliver(run, "history", r.stdout.split("\n").filter(Boolean), "history");
  }

  private finding(run: RunRow, code: Code, input: Record<string, unknown>) {
    only(input, FINDING_KEYS);
    for (const key of FINDING_KEYS) if (!(key in input)) throw new Refusal(`${key} is required`);
    if (!["real", "not_real", "unsure"].includes(input.verdict as string)) throw new Refusal("verdict must be real, not_real or unsure");
    for (const key of ["cause", "next_check", "impact", "status"]) if (typeof input[key] !== "string") throw new Refusal(`${key} must be text`);
    for (const key of ["ruled_out", "not_checked", "affected"]) if (!Array.isArray(input[key]) || (input[key] as unknown[]).some((v) => typeof v !== "string")) throw new Refusal(`${key} must be a list of text`);
    if (input.since !== null && !Number.isSafeInteger(input.since)) throw new Refusal("since must be a time in epoch milliseconds or null");
    const refuse = this.refuser(run);
    if (!Array.isArray(input.claims) || input.claims.length === 0) throw refuse("claims must list at least one claim");
    const claims = input.claims.map((c) => {
      const claim = object(c, "a claim");
      if (Object.keys(claim).some((k) => k !== "statement" && k !== "evidence")) throw refuse("a claim has only a statement and evidence handles");
      if (typeof claim.statement !== "string" || !Array.isArray(claim.evidence) || claim.evidence.length === 0) throw refuse("each claim needs a statement and at least one evidence handle");
      return { statement: clean(claim.statement, 2000), pieces: this.cite(run, claim.evidence) };
    });
    const body = Object.fromEntries(FINDING_KEYS.filter((k) => k !== "claims" && k !== "verdict").map((k) => [k, input[k]]));
    return this.file(run, code, String(input.verdict), claims, body);
  }

  private refuser(run: RunRow) {
    const valid = this.store.all<Piece>("SELECT handle FROM evidence WHERE run_id = ? ORDER BY rowid", run.id);
    return (why: string) => new Refusal(`${why}. Handles you may cite: ${valid.map((p) => p.handle).join(", ") || "none yet; call ow_telemetry first"}`);
  }

  /** The stored pieces for handles delivered to this run; any other handle refuses the whole filing. */
  private cite(run: RunRow, handles: ReadonlyArray<unknown>): Piece[] {
    return handles.map((h) => {
      const piece = typeof h === "string" ? this.store.get<Piece>("SELECT handle, source, text FROM evidence WHERE run_id = ? AND handle = ?", run.id, h) : undefined;
      if (!piece) throw this.refuser(run)("a cited handle was not delivered to this session");
      return { handle: piece.handle, source: piece.source, text: piece.text };
    });
  }

  /** A challenger's one filing: an outcome, a reason and its own evidence, stored as a finding of its run. */
  private challenge(run: RunRow, code: Code, input: Record<string, unknown>) {
    only(input, ["outcome", "reason", "evidence"]);
    const outcome = input.outcome;
    if (outcome !== "upheld" && outcome !== "disproved" && outcome !== "unsure") throw new Refusal("outcome must be upheld, disproved or unsure");
    if (typeof input.reason !== "string" || !input.reason.trim()) throw new Refusal("reason must be text");
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw this.refuser(run)("evidence must list at least one handle");
    const pieces = this.cite(run, input.evidence);
    const verdict = outcome === "upheld" ? "real" : outcome === "disproved" ? "not_real" : "unsure";
    return this.file(run, code, verdict, [{ statement: clean(input.reason, 2000), pieces }], { challenge: outcome, reason: input.reason });
  }

  /**
   * A fixer's one filing: a selection from what code offered, never bytes, a path or a commit of its own. Anything
   * else is refused and the refusal is the filing: the attempt ends there.
   */
  private proposal(run: RunRow, options: Options, input: Record<string, unknown>) {
    const kind = input.kind;
    const allowed = kind === "revert" ? ["kind", "commit"] : kind === "setting" ? ["kind", "path", "key"] : ["kind"];
    let refused: string | null = null, body: Proposal | null = null;
    const extra = Object.keys(input).find((k) => !allowed.includes(k));
    if (kind !== "revert" && kind !== "setting" && kind !== "abstain") refused = "kind must be revert, setting or abstain";
    else if (extra) refused = `a proposal of kind ${kind} has no field ${clean(extra, 40)}: you select a change, you never write one`;
    else if (kind === "revert") {
      const commit = input.commit ?? (options.commits.length === 1 ? options.commits[0]!.sha : undefined);
      if (typeof commit !== "string" || !options.commits.some((c) => c.sha === commit)) refused = `commit must be one of: ${options.commits.map((c) => c.sha).join(", ") || "none offered"}`;
      else body = { kind, commit };
    } else if (kind === "setting") {
      if (!options.keys.some((k) => k.path === input.path && k.key === input.key)) refused = `path and key must be one of: ${options.keys.map((k) => `${k.path} ${k.key}`).join(", ") || "none offered"}`;
      else body = { kind, path: String(input.path), key: String(input.key) };
    } else body = { kind: "abstain" };
    const stored = this.store.tx((w) => {
      if (w.run("UPDATE runs SET state = 'terminal' WHERE id = ? AND state = 'active'", run.id as Clean).changes === 0) return false;
      w.run("INSERT INTO proposals (run_id, body, refused) VALUES (?, ?, ?)", run.id as Clean, json(body ?? { kind: "refused", input: JSON.stringify(input).slice(0, 500) }), refused as Clean | null);
      w.event("proposal", run.id as Clean, { kind: body?.kind ?? null, refused });
      return true;
    });
    if (!stored) throw new Refusal("this proposal session has already filed");
    if (refused) throw new Refusal(`refused: ${refused}. The attempt has ended.`);
    return { accepted: body };
  }

  private file(run: RunRow, code: Code, verdict: string, claims: ReadonlyArray<{ statement: string; pieces: Piece[] }>, body: Record<string, unknown>) {
    const id = `f_${randomBytes(12).toString("hex")}`;
    const input = { verdict };
    // One valid filing closes the attempt, atomically with the finding.
    const closed = this.store.tx((w) => {
      const done = w.run("UPDATE runs SET state = 'terminal' WHERE id = ? AND state = 'active'", run.id as Clean).changes;
      if (done === 0) return false;
      w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, ?, ?, ?, ?)", id as Clean, run.id as Clean, input.verdict as Clean, json(claims), json(code), json(body));
      // The finding is an event about what was investigated; on real work it may bring that problem back.
      const job = this.store.get<{ subject: string; kind: string }>("SELECT j.subject, j.kind FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.id = ?", run.id)!;
      const seq = w.event("finding", (job.kind === "trial" ? run.id : job.subject) as Clean, { id, run: run.id, verdict: input.verdict });
      // An investigation's readings are votes: only its single adjudication can bring the problem back.
      if (job.kind !== "trial" && job.kind !== "investigation") afterFinding(w, this.store, job.subject, seq, String(input.verdict));
      return true;
    });
    if (!closed) throw new Refusal("this investigation has already been closed");
    const stored = this.store.get<{ claims: string }>("SELECT claims FROM findings WHERE id = ?", id)!;
    return { id, verdict: input.verdict, claims: JSON.parse(stored.claims), code };
  }
}

/** The owner tools, for a session OpenCode confirms and Overwatch does not run. */
async function ownerCall(this: Tools, store: Store, sessionId: string, name: string, input: Record<string, unknown>) {
  if (store.get("SELECT 1 FROM runs WHERE session_id = ?", sessionId)) throw new Refusal("this session is run by Overwatch; owner tools are for the owner's own sessions");
  if (!this.owner || !(await this.owner.exists(sessionId))) throw new Refusal("OpenCode does not know this session");
  const text = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v) throw new Refusal(`${what} is required`);
    return v;
  };
  if (name === "ow_inbox") return only(input, []), this.owner.inbox();
  if (name === "ow_get") return only(input, ["id"]), this.owner.get(text(input.id, "id"));
  if (name === "ow_search") return only(input, ["text"]), this.owner.search(text(input.text, "text"));
  only(input, ["id", "action", "until", "when", "reason", "actionSeq", "throughSeq"]);
  const { id, until, ...rest } = input;
  return this.owner.act(text(id, "id"), { ...rest, ...(until === undefined ? {} : { untilMs: until }) });
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Refusal(`${what} takes an object`);
  return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, allowed: ReadonlyArray<string>) {
  const extra = Object.keys(input).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Refusal(`unknown field ${clean(extra[0]!, 60)}; this tool takes ${allowed.join(", ")}`);
}
function optionalInt(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Refusal(`${name} must be an integer`);
  return value as number;
}

/** What each model-driven worker (agents, fixes, the trial) holds: the database, the tools, the configuration, the empty folder its sessions run in, and a log. */
export class Crew {
  protected readonly store: Store;
  protected readonly tools: Tools;
  protected readonly config: Config;
  protected readonly emptyDir: string;
  protected readonly log: (line: string) => void;
  constructor(store: Store, tools: Tools, config: Config, emptyDir: string, log: (line: string) => void = () => undefined) {
    this.store = store;
    this.tools = tools;
    this.config = config;
    this.emptyDir = emptyDir;
    this.log = log;
  }
}
