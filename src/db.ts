/**
 * Read-only database queries (`ow_db`): static SQL gate, strict parameter binding, and engine-level read-only CLI
 * execution (`sqlite3`, `psql`, `mysql`) strictly through `exec.run` (no shell, env-only credentials).
 */
import { Effect, Redacted } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { existsSync } from "node:fs";
import { LIMITS, type DbTarget } from "./config.ts";
import { Refusal } from "./errors.ts";
import { run as exec, secret } from "./exec.ts";
import { clean, truncate } from "./redact.ts";

const MAX_SQL = 2_000, TIMEOUT_MS = 10_000, MAX_BYTES = 65_536;
const SAFE_PARAM = /^[A-Za-z0-9._:@/-]{1,120}$/;
const FORBIDDEN_SQL = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|deallocate|attach|detach|pragma|vacuum|reindex|lock|set|reset|replace|merge|upsert|load_extension|into\s+outfile|into\s+dumpfile|load_file|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_terminate_backend|pg_cancel_backend|lo_import|lo_export|dblink|query_to_xml)\b/i;

/** Returns null when `sql` is a single read-only statement allowed by `ow_db`, or the reason it is refused. */
export function checkSql(sql: string): string | null {
  const s = sql.trim();
  if (!s) return "SQL query must not be empty";
  if (s.length > MAX_SQL) return `SQL query exceeds ${MAX_SQL} characters`;
  if (/[\0\\]/.test(s)) return "SQL query must not contain backslashes or NUL bytes";
  if (/(^|[\r\n])\s*\./.test(s)) return "SQL query must not contain CLI dot-commands";
  if (/--|\/\*|\*\//.test(s)) return "SQL comments are not allowed";
  const body = s.replace(/;\s*$/, "");
  if (body.includes(";")) return "only a single SQL statement is allowed";
  if (!/^(select|with|explain|show)\b/i.test(body)) return "only SELECT, WITH, EXPLAIN, or SHOW statements are allowed";
  if (/\bexplain\b(?:\s+analyze\b|\s*\([^)]*\banalyze\b)/i.test(body)) return "EXPLAIN ANALYZE is not allowed";
  const bad = FORBIDDEN_SQL.exec(body);
  return bad ? `disallowed SQL keyword or function: ${bad[1]}` : null;
}

/** Binds declared `:param` placeholders with strictly typed scalars and re-validates the rendered SQL. */
export function renderQuery(template: string, declared?: ReadonlyArray<string>, given?: Readonly<Record<string, unknown>>): { sql: string } | { error: string } {
  const expected = new Set(declared ?? []), provided = given ?? {}, bound: Record<string, string> = {};
  for (const k of Object.keys(provided)) if (!expected.has(k)) return { error: `unexpected parameter "${k}"` };
  for (const k of expected) {
    if (!(k in provided)) return { error: `missing required parameter "${k}"` };
    const v = provided[k];
    if (typeof v === "number" && Number.isFinite(v)) bound[k] = String(v);
    else if (typeof v === "boolean") bound[k] = v ? "TRUE" : "FALSE";
    else if (typeof v === "string" && SAFE_PARAM.test(v)) bound[k] = `'${v}'`;
    else return { error: `parameter "${k}" must be a finite number, boolean, or safe identifier string` };
  }
  let missing: string | null = null;
  const sql = template.replace(/(^|[^:]):([A-Za-z0-9_]+)/g, (m, pre: string, name: string) => (name in bound ? `${pre}${bound[name]}` : ((missing ??= name), m)));
  if (missing) return { error: `undeclared parameter placeholder ":${missing}"` };
  const err = checkSql(sql);
  return err ? { error: err } : { sql: sql.trim().replace(/;\s*$/, "") };
}

export interface DbRequest { readonly target: string; readonly query?: string; readonly params?: Readonly<Record<string, unknown>>; readonly sql?: string }
const refuse = (message: string) => new Refusal({ message });

/** Executes a named query or allowed SELECT against a configured DB target in read-only mode via `exec.run`. */
export const queryDb = Effect.fn("db.query")(function* (target: DbTarget, req: DbRequest): Effect.fn.Return<{ output: string; truncated: boolean }, Refusal, ChildProcessSpawner.ChildProcessSpawner> {
  if (Boolean(req.query) === Boolean(req.sql)) return yield* refuse('provide either "query" (named query) or "sql", not both');
  let statement: string;
  if (req.query) {
    const q = target.queries[req.query];
    if (!q) return yield* refuse(`unknown query "${clean(req.query, 60)}" on ${target.name}; available: ${Object.keys(target.queries).join(", ") || "none"}`);
    const rendered = renderQuery(q.sql, q.params, req.params);
    if ("error" in rendered) return yield* refuse(rendered.error);
    statement = rendered.sql;
  } else {
    if (!target.allowSelect) return yield* refuse(`ad-hoc SQL is disabled on ${target.name}; use a named query: ${Object.keys(target.queries).join(", ") || "none"}`);
    if (req.params && Object.keys(req.params).length) return yield* refuse("params are only used with named queries");
    const err = checkSql(req.sql!);
    if (err) return yield* refuse(err);
    statement = req.sql!.trim().replace(/;\s*$/, "");
  }
  const runCli = (cmd: string, args: ReadonlyArray<string>, env?: Record<string, string | undefined>) => exec(cmd, args, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, ...(env ? { env } : {}) });
  let r;
  if (target.driver === "sqlite") {
    if (!target.file || !existsSync(target.file)) return yield* refuse(`sqlite database file not found for ${target.name}`);
    r = yield* runCli("sqlite3", ["-bail", "-readonly", "-json", target.file, statement]);
  } else {
    const raw = yield* secret(target.dsn!);
    if (!raw) return yield* refuse(`database secret ${target.dsn} is not set`);
    let u: URL;
    try { u = new URL(Redacted.value(raw)); } catch { return yield* refuse(`invalid database URL in ${target.dsn}`); }
    const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (target.driver === "postgres") {
      r = yield* runCli("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-A", "-F", "\t", "-c", statement], {
        ...(u.hostname ? { PGHOST: u.hostname } : {}), ...(u.port ? { PGPORT: u.port } : {}), ...(db ? { PGDATABASE: db } : {}),
        ...(u.username ? { PGUSER: decodeURIComponent(u.username) } : {}), ...(u.password ? { PGPASSWORD: decodeURIComponent(u.password) } : {}),
        ...(u.searchParams.get("sslmode") ? { PGSSLMODE: u.searchParams.get("sslmode")! } : {}), PGOPTIONS: `-c default_transaction_read_only=on -c statement_timeout=${TIMEOUT_MS}`, });
    } else {
      const args = [...(u.hostname ? ["--host", u.hostname] : []), ...(u.port ? ["--port", u.port] : []), ...(u.username ? ["--user", decodeURIComponent(u.username)] : []), ...(db ? ["--database", db] : []), "--batch", "--quick", "--init-command=SET SESSION TRANSACTION READ ONLY", "-e", statement];
      r = yield* runCli("mysql", args, u.password ? { MYSQL_PWD: decodeURIComponent(u.password) } : undefined);
    }
  }
  if (r.timedOut) return yield* refuse(`database query on ${target.name} timed out after ${TIMEOUT_MS / 1000}s`);
  if (r.code !== 0) return yield* refuse(clean(r.stderr.trim() || r.stdout.trim() || `${target.driver} exited ${r.code}`, 300));
  return { output: r.stdout.trim() || (target.driver === "sqlite" ? "[]" : ""), truncated: Buffer.byteLength(r.stdout) >= MAX_BYTES };
});

/** Owner MCP lookup by `app/env/name` or unique `name`, returning cleaned output capped at `LIMITS.pieceBytes`. */
export const queryOwnerDb = Effect.fn("db.owner")(function* (databases: ReadonlyArray<DbTarget>, req: DbRequest) {
  const byName = databases.filter((d) => d.name === req.target);
  const target = databases.find((d) => d.id === req.target) ?? (byName.length === 1 ? byName[0] : undefined);
  if (!target) return yield* refuse(byName.length > 1 ? `target "${clean(req.target, 60)}" matches multiple environments; use one of: ${byName.map((d) => d.id).join(", ")}` : `unknown database target "${clean(req.target, 60)}"; configured: ${databases.map((d) => d.id).join(", ") || "none"}`);
  const res = yield* queryDb(target, req), bounded = clean(res.output, LIMITS.pieceBytes * 4), output = truncate(bounded, LIMITS.pieceBytes);
  return { target: target.id, output, truncated: res.truncated || output !== bounded }; });
