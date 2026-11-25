/**
 * The search projection: documents built from the journal, in commit order, with a word index of their own (this
 * Node build has no SQLite full-text module; the data is thousands of items, not millions). Rebuilding deletes the
 * documents and replays the journal from the start; positions never change, so a rebuild gives the same index.
 */
import type { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SearchStore, type SearchHit } from "../domain/search.ts";
import type { Connection } from "../host/connection.ts";

export const SEARCH_VERSION = 1;
const NAME = "search";

interface JournalRow {
  readonly position: number;
  readonly stream: string;
  readonly type: string;
  readonly data: string;
  readonly at: number;
}

interface Doc {
  readonly doc: string;
  readonly kind: string;
  readonly ref: string;
  readonly title: string;
  readonly body: string;
  readonly app: string | null;
  readonly environment: string | null;
  readonly state: string | null;
  readonly at: number;
}

const words = (text: string) => [...new Set(text.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{1,}/g) ?? [])].slice(0, 400);

function upsert(db: DatabaseSync, doc: Doc) {
  db.prepare(
    "INSERT INTO search_docs (doc, kind, ref, title, body, app, environment, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (doc) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, title = excluded.title, body = excluded.body, app = excluded.app, environment = excluded.environment, state = excluded.state, at = excluded.at",
  ).run(doc.doc, doc.kind, doc.ref, doc.title, doc.body, doc.app, doc.environment, doc.state, doc.at);
  db.prepare("DELETE FROM search_terms WHERE doc = ?").run(doc.doc);
  const insert = db.prepare("INSERT OR IGNORE INTO search_terms (term, doc) VALUES (?, ?)");
  for (const term of words(`${doc.ref} ${doc.title} ${doc.body} ${doc.app ?? ""} ${doc.environment ?? ""}`)) insert.run(term, doc.doc);
}

const getDoc = (db: DatabaseSync, doc: string) => db.prepare("SELECT * FROM search_docs WHERE doc = ?").get(doc) as Doc | undefined;

/** Applies one journal row to the documents. Pure apart from the tables it writes. */
function apply(db: DatabaseSync, row: JournalRow) {
  const data = JSON.parse(row.data) as Record<string, any>;
  const id = row.stream.slice(row.stream.indexOf("/") + 1);
  const at = Number(data.at ?? row.at);
  switch (row.type) {
    case "IncidentOpened":
      upsert(db, {
        doc: `incident:${id}`,
        kind: "incident",
        ref: id,
        title: String(data.title),
        body: [data.sample, data.source, data.fingerprint, data.query].filter(Boolean).join("\n"),
        app: data.app,
        environment: data.environment,
        state: "inbox",
        at,
      });
      return;
    case "SignalRecurred":
    case "IncidentArchived": {
      const doc = getDoc(db, `incident:${id}`);
      if (doc) upsert(db, { ...doc, at: Math.max(doc.at, at), state: row.type === "IncidentArchived" ? "archived" : doc.state });
      return;
    }
    case "FindingRecorded": {
      const e = data.finding.engineering;
      const incident = getDoc(db, `incident:${id}`);
      upsert(db, {
        doc: `finding:${data.runId}`,
        kind: "finding",
        ref: id,
        title: `${e.verdict}: ${e.cause}`,
        body: [data.finding.product.impact, ...e.evidence.map((x: { quote: string }) => x.quote), ...(data.finding.ruledOut ?? [])].join("\n"),
        app: incident?.app ?? null,
        environment: incident?.environment ?? null,
        state: incident?.state ?? null,
        at,
      });
      return;
    }
    case "PromptAsked":
      upsert(db, {
        doc: `prompt:${id}:${data.promptId}`,
        kind: "prompt",
        ref: id,
        title: String(data.text).slice(0, 200),
        body: `${data.title}\n${data.reason}`,
        app: null,
        environment: null,
        state: data.held ? "held" : "asked",
        at,
      });
      return;
    case "HandoffRecorded":
      upsert(db, {
        doc: `thread:${id}`,
        kind: "thread",
        ref: id,
        title: String(data.handoff.concluded),
        body: [...data.handoff.ruledOut, ...data.handoff.open].join("\n"),
        app: null,
        environment: null,
        state: "active",
        at: Number(data.handoff.at),
      });
      return;
    case "ThreadArchived": {
      const doc = getDoc(db, `thread:${id}`);
      if (doc) upsert(db, { ...doc, state: "archived" });
      return;
    }
    case "RunFailed":
      upsert(db, { doc: `run:${id}`, kind: "run", ref: id, title: `run failed: ${data.reason}`, body: String(data.threadId), app: null, environment: null, state: "failed", at });
      return;
    default:
      return;
  }
}

/** Brings the projection up to the journal's end. Returns how many rows it applied. */
export function catchUp(db: DatabaseSync, batch = 500): number {
  const state = db.prepare("SELECT position, version FROM projections WHERE name = ?").get(NAME) as { position: number; version: number } | undefined;
  if (state && state.version !== SEARCH_VERSION) {
    rebuild(db);
    return catchUp(db, batch);
  }
  let position = state?.position ?? 0;
  let applied = 0;
  for (;;) {
    const rows = db.prepare("SELECT position, stream, type, data, at FROM journal WHERE position > ? ORDER BY position LIMIT ?").all(position, batch) as unknown as JournalRow[];
    if (rows.length === 0) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) apply(db, row);
      position = rows.at(-1)!.position;
      db.prepare("INSERT INTO projections (name, position, version) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET position = excluded.position, version = excluded.version").run(
        NAME,
        position,
        SEARCH_VERSION,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied += rows.length;
  }
  return applied;
}

/** Forgets the projection; the next catch-up replays the journal from the start. */
export function rebuild(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE; DELETE FROM search_terms; DELETE FROM search_docs; DELETE FROM projections WHERE name = 'search'; COMMIT;");
}

export function search(db: DatabaseSync, text: string, limit: number): SearchHit[] {
  const query = text.trim();
  if (!query) return [];
  const exact = db.prepare("SELECT * FROM search_docs WHERE ref = ? OR doc = ? ORDER BY at DESC LIMIT ?").all(query, query, limit) as unknown as Doc[];
  const terms = words(query);
  let docs: Doc[] = [];
  if (terms.length) {
    const clauses = terms.map(() => "doc IN (SELECT doc FROM search_terms WHERE term >= ? AND term < ?)").join(" AND ");
    const args = terms.flatMap((t) => [t, `${t}￿`]);
    docs = db.prepare(`SELECT * FROM search_docs WHERE ${clauses} ORDER BY at DESC, doc LIMIT ?`).all(...args, limit) as unknown as Doc[];
  }
  const seen = new Set<string>();
  return [...exact, ...docs]
    .filter((d) => (seen.has(d.doc) ? false : (seen.add(d.doc), true)))
    .slice(0, limit)
    .map((d) => ({
      kind: d.kind,
      id: d.ref,
      title: d.title,
      snippet: d.body.slice(0, 200),
      app: d.app,
      environment: d.environment,
      state: d.state,
      at: d.at,
    }));
}

/** The Search query's port over the projection. Each search first catches up with the journal. */
export const layerSearchStore = (connection: Connection) =>
  Layer.succeed(SearchStore, {
    search: (text, limit) =>
      connection.use((db) => {
        catchUp(db);
        return search(db, text, limit);
      }),
  });

void Effect;
