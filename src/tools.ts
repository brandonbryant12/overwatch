/**
 * The investigation tools a session calls through MCP. A call is tied to its run only by the session ID OpenCode
 * attaches to it; nothing in a prompt or an argument grants access.
 *
 * Evidence by handle: every piece of telemetry, code or history is cut into pieces, cleaned, bounded to 16 KiB and
 * stored with an unpredictable handle *before* it is returned. A filing cites handles; it never supplies a quote or a
 * source. Every cited handle must have been delivered to this same attempt, or the whole filing is refused with the
 * handles that are valid. The owner's question, instructions, tool arguments and other findings get no handle, so
 * they cannot be cited.
 *
 * Each tool's parameters are a Schema: it is published as the tool's input schema (closed objects) and decodes the
 * arguments. The raw arguments reach `call`, so a call counts toward the run's budget and a fixer's malformed
 * proposal is stored as refused, whatever its shape.
 */
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { createHash, randomBytes } from "node:crypto";
import { LIMITS } from "./config.ts";
import { clock } from "./clock.ts";
import { type ApiError, Refusal } from "./errors.ts";
import { run as exec } from "./exec.ts";
import { afterFinding } from "./inbox.ts";
import { clean, truncate } from "./redact.ts";
import { type Full, json, type Clean, Store } from "./store.ts";

export { Refusal };

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
  readonly exists: (sessionId: string) => Effect.Effect<boolean>;
  readonly inbox: Effect.Effect<unknown, ApiError | Full>;
  readonly get: (id: string) => Effect.Effect<unknown, ApiError | Full>;
  readonly search: (text: string) => Effect.Effect<unknown, ApiError | Full>;
  readonly act: (id: string, body: Record<string, unknown>) => Effect.Effect<unknown, ApiError | Full>;
}

export interface Piece {
  readonly handle: string;
  readonly source: string;
  readonly text: string;
}

// ---- the tools' parameters

const Int = Schema.Int;
const Text = Schema.String;
const Texts = Schema.Array(Schema.String);
const Telemetry = Schema.Struct({
  source: Text,
  since: Schema.optionalKey(Schema.NullOr(Int)),
  until: Schema.optionalKey(Schema.NullOr(Int)),
  query: Schema.optionalKey(Text),
  cursor: Schema.optionalKey(Text),
});
const CodeSearch = Schema.Struct({ pattern: Text, path: Schema.optionalKey(Text) });
const CodeRead = Schema.Struct({ path: Text, from: Int, to: Int });
const History = Schema.Struct({ path: Schema.optionalKey(Text), ref: Schema.optionalKey(Text) });
const ChallengeInput = Schema.Struct({ outcome: Schema.Literals(["upheld", "disproved", "unsure"]), reason: Text, evidence: Texts });
const Kind = Schema.Literals(["revert", "setting", "abstain"]);
const ProposalInput = Schema.Struct({ kind: Kind, commit: Schema.optionalKey(Text), path: Schema.optionalKey(Text), key: Schema.optionalKey(Text) });
/** No arguments: a closed, empty object. */
const Empty = Schema.Record(Schema.String, Schema.Never);
const GetInput = Schema.Struct({ id: Text });
const SearchInput = Schema.Struct({ text: Text });
const ActInput = Schema.Struct({
  id: Text,
  action: Schema.Literals(["done", "later", "never", "undo", "seen"]),
  until: Schema.optionalKey(Int),
  when: Schema.optionalKey(Text),
  reason: Schema.optionalKey(Text),
  actionSeq: Schema.optionalKey(Int),
  throughSeq: Schema.optionalKey(Int),
});
const Claim = Schema.Struct({ statement: Text, evidence: Texts });
const findingFields = {
  verdict: Schema.Literals(["real", "not_real", "unsure"]),
  cause: Text,
  ruled_out: Texts,
  not_checked: Texts,
  next_check: Text,
  impact: Text,
  affected: Texts,
  since: Schema.NullOr(Int),
  status: Text,
};
const FindingInput = Schema.Struct({ ...findingFields, claims: Schema.Array(Claim) });
/** The finding with its claims undecoded: each claim is judged on its own, with the handles the run may cite. */
const FindingShape = Schema.Struct({ ...findingFields, claims: Schema.Array(Schema.Unknown) });

/** Every tool: its name, what the model is told, and its parameters. */
export const TOOLS = [
  { name: "ow_telemetry", description: "Read this investigation's telemetry as evidence pieces, 50 per call, oldest first. To read further, call again with the same arguments and cursor set to nextCursor.", parameters: Telemetry },
  { name: "ow_code_search", description: "Search the pinned commit for literal text.", parameters: CodeSearch },
  { name: "ow_code_read", description: "Read lines of a file at the pinned commit.", parameters: CodeRead },
  { name: "ow_history", description: "Commits at the pinned commit.", parameters: History },
  { name: "ow_challenge", description: "File the challenge: upheld, disproved or unsure, with a reason and evidence handles you were given.", parameters: ChallengeInput },
  {
    name: "ow_proposal",
    description: "Select exactly one change from the options you were given: {kind:\"revert\", commit} (commit may be left out when there is one), {kind:\"setting\", path, key}, or {kind:\"abstain\"}. You never write the change itself.",
    parameters: ProposalInput,
  },
  { name: "ow_inbox", description: "The owner's inbox: four groups of problem IDs, as the page shows them.", parameters: Empty },
  { name: "ow_get", description: "One problem in full: counts, way out, history, findings, investigations, questions.", parameters: GetInput },
  { name: "ow_search", description: "Literal, case-insensitive search over problems, evidence, findings and questions.", parameters: SearchInput },
  { name: "ow_act", description: "Put a problem away (done, later, never), undo the current way out (with its actionSeq), or mark it seen. Confirm with the owner first.", parameters: ActInput },
  { name: "ow_finding", description: "File the finding. Each claim cites evidence handles you were given.", parameters: FindingInput },
] as const;
export type ToolName = (typeof TOOLS)[number]["name"];
const OWNER_TOOLS: ReadonlyArray<string> = ["ow_inbox", "ow_get", "ow_search", "ow_act"];

/** A tool's parameters as a closed JSON Schema object, for MCP's tools/list. */
export const inputSchema = (parameters: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(parameters, { onExcessProperty: "error" });
  return Object.keys(document.definitions).length ? { ...document.schema, $defs: document.definitions } : { ...document.schema };
};

/** Decodes a tool's arguments with its Schema, extra fields refused; a mismatch is a Refusal the model reads. */
const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown, what: string): Effect.Effect<S["Type"], Refusal> =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((e) => new Refusal({ message: `${what}: ${clean(e.message.replace(/\s*\n\s*/g, " "), 600)}` })),
  ) as Effect.Effect<S["Type"], Refusal>;

const refusal = (message: string) => new Refusal({ message });

/** Pieces one telemetry call returns at most. */
const PAGE = 50;

interface RunRow {
  id: string;
  session_id: string;
  state: string;
  calls: number;
  code: string;
}

export interface ToolsShape {
  /** Runs this process dispatched, with what they may read. A run from another process or timeline has none. */
  readonly contexts: Map<string, RunContext>;
  /** What each run's model wrote into tool arguments, for the trial's "obeyed" check. */
  readonly authored: Map<string, string[]>;
  /** The tools as MCP lists them. */
  readonly list: () => ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }>;
  /**
   * One tool call, from the OpenCode session that made it. Counts toward the run's budget whether it succeeds or not.
   * `owner` serves the owner tools (MCP passes the page's own operations); without it they are refused.
   */
  readonly call: (sessionId: unknown, name: string, args: unknown, owner?: Owner | null) => Effect.Effect<unknown, Refusal | ApiError | Full>;
}

export class Tools extends Context.Service<Tools, ToolsShape>()("overwatch/Tools") {
  static readonly layer: Layer.Layer<Tools, never, Store | ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
    Tools,
    Effect.gen(function* () {
      const store = yield* Store;
      const services = yield* Effect.context<Store | ChildProcessSpawner.ChildProcessSpawner>();
      const contexts = new Map<string, RunContext>();
      const authored = new Map<string, string[]>();

      /** Stores pieces with their typed origin (what the evidence is, whatever its source is called), reusing a handle for the same text. */
      const deliver = (run: RunRow, source: string, texts: ReadonlyArray<string>, origin: Origin | ReadonlyArray<Origin>) =>
        Effect.gen(function* () {
          let truncated = false;
          const pieces: Piece[] = [];
          yield* store.tx((w) =>
            Effect.gen(function* () {
              for (const [n, raw] of texts.entries()) {
                const bounded = clean(raw, LIMITS.pieceBytes * 4);
                const text = truncate(bounded, LIMITS.pieceBytes) as Clean;
                if (text !== bounded) truncated = true;
                const ordinal = parseInt(createHash("sha256").update(text).digest("hex").slice(0, 12), 16);
                const existing = yield* store.get<{ handle: string }>("SELECT handle FROM evidence WHERE run_id = ? AND source = ? AND ordinal = ?", run.id, source, ordinal);
                if (existing) {
                  pieces.push({ handle: existing.handle, source, text });
                  continue;
                }
                const count = (yield* store.get<{ n: number }>("SELECT count(*) AS n FROM evidence WHERE run_id = ?", run.id))!.n;
                if (count >= LIMITS.piecesPerSession) {
                  truncated = true;
                  continue;
                }
                const handle = `e_${randomBytes(12).toString("hex")}`;
                yield* w.run("INSERT INTO evidence (handle, run_id, session_id, source, text, ordinal) VALUES (?, ?, ?, ?, ?, ?)", handle as Clean, run.id as Clean, run.session_id as Clean, source as Clean, text, ordinal);
                yield* w.run("INSERT INTO origins (handle, origin) VALUES (?, ?)", handle as Clean, (Predicate.isString(origin) ? origin : origin[n]!) as Clean);
                pieces.push({ handle, source, text });
              }
              yield* w.event("evidence", run.id as Clean, { source, pieces: pieces.length, truncated });
            }),
          );
          return { pieces, truncated };
        });

      const telemetry = Effect.fnUntraced(function* (run: RunRow, context: RunContext, args: unknown) {
        const input = yield* decode(Telemetry, args, "ow_telemetry");
        const source = input.source;
        if (!(source in context.telemetry)) return yield* refusal(`source must be one of: ${Object.keys(context.telemetry).join(", ")}`);
        const since = input.since ?? null, until = input.until ?? null, query = input.query;
        const lines = context.telemetry[source]!.filter((l) => (since === null || l.at >= since) && (until === null || l.at <= until) && (!query || l.text.includes(query)));
        // One page per call in a stable order (time, then position). The cursor is bound to this run, source and filters:
        // following it resumes strictly after the page it came with; the same page again reuses its handles.
        const bind = createHash("sha256").update(JSON.stringify([run.id, source, since, until, query ?? null])).digest("hex").slice(0, 16);
        let offset = 0;
        if (input.cursor !== undefined) {
          const m = /^c(\d{1,9})_([0-9a-f]{16})$/.exec(input.cursor);
          if (!m || m[2] !== bind) return yield* refusal("cursor is not one this investigation was given for these arguments");
          offset = Number(m[1]);
        }
        const ordered = lines.map((l, i) => ({ ...l, i })).sort((a, b) => a.at - b.at || a.i - b.i);
        const slice = ordered.slice(offset, offset + PAGE);
        const page = yield* deliver(run, source, slice.map((l) => `${new Date(l.at).toISOString()} ${l.text}`), slice.map((l) => l.origin ?? "telemetry"));
        const nextCursor = offset + PAGE < ordered.length ? `c${offset + PAGE}_${bind}` : null;
        return { pieces: page.pieces, truncated: page.truncated, nextCursor };
      });

      const relative = (value: string | undefined, required: boolean) => {
        if (value === undefined && !required) return Effect.succeed(null);
        if (value === undefined || !/^[A-Za-z0-9._\-/]{1,300}$/.test(value) || value.split("/").includes("..") || value.startsWith("/")) return Effect.fail(refusal("path must be a relative path in the repository"));
        return Effect.succeed(value);
      };

      const code = Effect.fnUntraced(function* (run: RunRow, context: RunContext, pinned: Code, name: string, args: unknown) {
        if (!context.repo || !pinned.read) return { pieces: [] as Piece[], truncated: false };
        const at = pinned.read;
        const git = (...a: string[]) => exec("git", ["-C", context.repo!, ...a], { timeoutMs: 30_000 });
        if (name === "ow_code_read") {
          const input = yield* decode(CodeRead, args, name);
          const file = (yield* relative(input.path, true))!;
          if (input.from < 1 || input.to < input.from || input.to - input.from > 400) return yield* refusal("from and to are line numbers, from ≤ to, at most 400 lines");
          const r = yield* git("show", `${at}:${file}`);
          if (r.code !== 0) return yield* refusal(`${file} is not in commit ${at.slice(0, 12)}`);
          const lines = r.stdout.split("\n").slice(input.from - 1, input.to);
          return yield* deliver(run, "code", [`${file}:${input.from}-${input.to}\n${lines.join("\n")}`], "code");
        }
        if (name === "ow_code_search") {
          const input = yield* decode(CodeSearch, args, name);
          if (!input.pattern) return yield* refusal("pattern must be literal text");
          const file = yield* relative(input.path, false);
          const r = yield* git("grep", "-n", "-F", "-e", input.pattern, at, ...(file ? ["--", file] : []));
          const matches = r.stdout.split("\n").filter(Boolean).slice(0, 50).map((l) => l.slice(at.length + 1));
          return yield* deliver(run, "code", matches, "code");
        }
        const input = yield* decode(History, args, name);
        if (input.ref !== undefined && input.ref !== at) return yield* refusal(`ref must be the pinned commit ${at}`);
        const file = yield* relative(input.path, false);
        const r = yield* git("log", "-n", "20", "--format=%H %ad %s", "--date=iso-strict", at, ...(file ? ["--", file] : []));
        return yield* deliver(run, "history", r.stdout.split("\n").filter(Boolean), "history");
      });

      const refuser = Effect.fnUntraced(function* (run: RunRow) {
        const valid = yield* store.all<Piece>("SELECT handle FROM evidence WHERE run_id = ? ORDER BY rowid", run.id);
        return (why: string) => refusal(`${why}. Handles you may cite: ${valid.map((p) => p.handle).join(", ") || "none yet; call ow_telemetry first"}`);
      });

      /** The stored pieces for handles delivered to this run; any other handle refuses the whole filing. */
      const cite = Effect.fnUntraced(function* (run: RunRow, handles: ReadonlyArray<string>) {
        const pieces: Piece[] = [];
        for (const h of handles) {
          const piece = yield* store.get<Piece>("SELECT handle, source, text FROM evidence WHERE run_id = ? AND handle = ?", run.id, h);
          if (!piece) return yield* (yield* refuser(run))("a cited handle was not delivered to this session");
          pieces.push({ handle: piece.handle, source: piece.source, text: piece.text });
        }
        return pieces;
      });

      const file = Effect.fnUntraced(function* (run: RunRow, pinned: Code, verdict: string, claims: ReadonlyArray<{ statement: string; pieces: Piece[] }>, body: Record<string, unknown>) {
        const id = `f_${randomBytes(12).toString("hex")}`;
        // One valid filing closes the attempt, atomically with the finding.
        const closed = yield* store.tx((w) =>
          Effect.gen(function* () {
            const done = (yield* w.run("UPDATE runs SET state = 'terminal' WHERE id = ? AND state = 'active'", run.id as Clean)).changes;
            if (done === 0) return false;
            yield* w.run("INSERT INTO findings (id, run_id, verdict, claims, code, body) VALUES (?, ?, ?, ?, ?, ?)", id as Clean, run.id as Clean, verdict as Clean, json(claims), json(pinned), json(body));
            // The finding is an event about what was investigated; on real work it may bring that problem back.
            const job = (yield* store.get<{ subject: string; kind: string }>("SELECT j.subject, j.kind FROM runs r JOIN jobs j ON j.id = r.job_id WHERE r.id = ?", run.id))!;
            const seq = yield* w.event("finding", (job.kind === "trial" ? run.id : job.subject) as Clean, { id, run: run.id, verdict });
            // An investigation's readings are votes: only its single adjudication can bring the problem back.
            if (job.kind !== "trial" && job.kind !== "investigation") yield* afterFinding(w, job.subject, seq, verdict);
            return true;
          }),
        );
        if (!closed) return yield* refusal("this investigation has already been closed");
        const stored = (yield* store.get<{ claims: string }>("SELECT claims FROM findings WHERE id = ?", id))!;
        return { id, verdict, claims: JSON.parse(stored.claims), code: pinned };
      });

      const finding = Effect.fnUntraced(function* (run: RunRow, pinned: Code, args: unknown) {
        const input = yield* decode(FindingShape, args, "ow_finding");
        const refuse = yield* refuser(run);
        if (input.claims.length === 0) return yield* refuse("claims must list at least one claim");
        const claims: Array<{ statement: string; pieces: Piece[] }> = [];
        for (const c of input.claims) {
          const claim = Schema.decodeUnknownOption(Claim, { onExcessProperty: "error" })(c);
          if (Option.isNone(claim)) {
            const extra = Predicate.isObject(c) && Object.keys(c).some((k) => k !== "statement" && k !== "evidence");
            return yield* refuse(extra ? "a claim has only a statement and evidence handles" : "each claim needs a statement and at least one evidence handle");
          }
          if (claim.value.evidence.length === 0) return yield* refuse("each claim needs a statement and at least one evidence handle");
          claims.push({ statement: clean(claim.value.statement, 2000), pieces: yield* cite(run, claim.value.evidence) });
        }
        const { verdict, claims: _, ...body } = input;
        return yield* file(run, pinned, verdict, claims, body);
      });

      /** A challenger's one filing: an outcome, a reason and its own evidence, stored as a finding of its run. */
      const challenge = Effect.fnUntraced(function* (run: RunRow, pinned: Code, args: unknown) {
        const input = yield* decode(ChallengeInput, args, "ow_challenge");
        if (!input.reason.trim()) return yield* refusal("reason must be text");
        if (input.evidence.length === 0) return yield* (yield* refuser(run))("evidence must list at least one handle");
        const pieces = yield* cite(run, input.evidence);
        const verdict = input.outcome === "upheld" ? "real" : input.outcome === "disproved" ? "not_real" : "unsure";
        return yield* file(run, pinned, verdict, [{ statement: clean(input.reason, 2000), pieces }], { challenge: input.outcome, reason: input.reason });
      });

      /**
       * A fixer's one filing: a selection from what code offered, never bytes, a path or a commit of its own. Anything
       * else is refused and the refusal is the filing: the attempt ends there.
       */
      const proposal = Effect.fnUntraced(function* (run: RunRow, options: Options, args: unknown) {
        const raw = Predicate.isObject(args) ? (args as Record<string, unknown>) : {};
        const kind = Schema.is(Kind)(raw.kind) ? raw.kind : null;
        const allowed = kind === "revert" ? ["kind", "commit"] : kind === "setting" ? ["kind", "path", "key"] : ["kind"];
        const extra = Object.keys(raw).find((k) => !allowed.includes(k));
        const input = yield* Effect.result(decode(ProposalInput, args, "ow_proposal"));
        let refused: string | null = null, body: Proposal | null = null;
        if (kind === null) refused = "kind must be revert, setting or abstain";
        else if (extra) refused = `a proposal of kind ${kind} has no field ${clean(extra, 40)}: you select a change, you never write one`;
        else if (input._tag === "Failure") refused = input.failure.message;
        else if (kind === "revert") {
          const commit = input.success.commit ?? (options.commits.length === 1 ? options.commits[0]!.sha : undefined);
          if (commit === undefined || !options.commits.some((c) => c.sha === commit)) refused = `commit must be one of: ${options.commits.map((c) => c.sha).join(", ") || "none offered"}`;
          else body = { kind, commit };
        } else if (kind === "setting") {
          const { path, key } = input.success;
          if (path === undefined || key === undefined || !options.keys.some((k) => k.path === path && k.key === key)) refused = `path and key must be one of: ${options.keys.map((k) => `${k.path} ${k.key}`).join(", ") || "none offered"}`;
          else body = { kind, path, key };
        } else body = { kind: "abstain" };
        const stored = yield* store.tx((w) =>
          Effect.gen(function* () {
            if ((yield* w.run("UPDATE runs SET state = 'terminal' WHERE id = ? AND state = 'active'", run.id as Clean)).changes === 0) return false;
            yield* w.run("INSERT INTO proposals (run_id, body, refused) VALUES (?, ?, ?)", run.id as Clean, json(body ?? { kind: "refused", input: JSON.stringify(args ?? null).slice(0, 500) }), refused as Clean | null);
            yield* w.event("proposal", run.id as Clean, { kind: body?.kind ?? null, refused });
            return true;
          }),
        );
        if (!stored) return yield* refusal("this proposal session has already filed");
        if (refused) return yield* refusal(`refused: ${refused}. The attempt has ended.`);
        return { accepted: body };
      });

      /** The owner tools, for a session OpenCode confirms and Overwatch does not run. */
      const ownerCall = Effect.fnUntraced(function* (sessionId: string, name: string, args: unknown, o: Owner | null) {
        if (yield* store.get("SELECT 1 FROM runs WHERE session_id = ?", sessionId)) return yield* refusal("this session is run by Overwatch; owner tools are for the owner's own sessions");
        if (!o || !(yield* o.exists(sessionId))) return yield* refusal("OpenCode does not know this session");
        if (name === "ow_inbox") return yield* decode(Empty, args, name).pipe(Effect.andThen(o.inbox));
        if (name === "ow_get") {
          const { id } = yield* decode(GetInput, args, name);
          if (!id) return yield* refusal("id is required");
          return yield* o.get(id);
        }
        if (name === "ow_search") {
          const { text } = yield* decode(SearchInput, args, name);
          if (!text) return yield* refusal("text is required");
          return yield* o.search(text);
        }
        const { id, until, ...rest } = yield* decode(ActInput, args, name);
        if (!id) return yield* refusal("id is required");
        return yield* o.act(id, { ...rest, ...(until === undefined ? {} : { untilMs: until }) });
      });

      const call = Effect.fnUntraced(function* (sessionId: unknown, name: string, args: unknown, owner: Owner | null) {
        if (!Predicate.isString(sessionId) || !sessionId) return yield* refusal("the call carries no OpenCode session id");
        if (OWNER_TOOLS.includes(name)) return yield* ownerCall(sessionId, name, args, owner);
        const run = yield* store.get<RunRow>("SELECT id, session_id, state, calls, code FROM runs WHERE session_id = ?", sessionId);
        const context = run ? contexts.get(run.id) : undefined;
        if (!run || run.state !== "active" || !context) return yield* refusal("this session has no active Overwatch investigation");
        if (run.calls >= LIMITS.toolCallsPerRun) return yield* refusal(`this investigation has used its ${LIMITS.toolCallsPerRun} tool calls`);
        if (clock.mono() >= context.deadline) return yield* refusal("this investigation's five minutes have passed");
        authored.get(run.id)?.push(JSON.stringify(args ?? null));
        yield* store.tx((w) => Effect.andThen(w.run("UPDATE runs SET calls = calls + 1 WHERE id = ?", run.id as Clean), w.event("run", run.id as Clean, { tool: name, call: run.calls + 1 })));
        const pinned = JSON.parse(run.code) as Code;
        const role = context.role ?? "investigator";
        if (name === "ow_finding" && role !== "investigator") return yield* refusal("this session cannot file a finding");
        if (name === "ow_challenge" && role !== "challenger") return yield* refusal("only a challenger files a challenge");
        if (role === "fixer" ? name !== "ow_telemetry" && name !== "ow_proposal" : name === "ow_proposal") return yield* refusal(role === "fixer" ? "a fixer reads telemetry and files one proposal" : "only a fixer files a proposal");
        switch (name) {
          case "ow_telemetry":
            return yield* telemetry(run, context, args);
          case "ow_code_read":
          case "ow_code_search":
          case "ow_history":
            return { ...(yield* code(run, context, pinned, name, args)), code: pinned };
          case "ow_finding":
            return yield* finding(run, pinned, args);
          case "ow_challenge":
            return yield* challenge(run, pinned, args);
          case "ow_proposal":
            return yield* proposal(run, context.options ?? { commits: [], keys: [] }, args);
          default:
            return yield* refusal(`unknown tool ${clean(name, 60)}`);
        }
      });

      return Tools.of({
        contexts,
        authored,
        list: () => TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.parameters) })),
        call: (sessionId, name, args, owner = null) => call(sessionId, name, args, owner).pipe(Effect.provide(services)),
      });
    }),
  );
}
