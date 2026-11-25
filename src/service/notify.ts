/**
 * Telling the owner. One notification when an incident opens in an environment that notifies (production by
 * default), and one when a finding arrives for it, once per incident per kind. The intent is recorded from the
 * journal, then delivered, then its result recorded; a failed delivery is tried again a bounded number of times.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Exec } from "../collect/exec.ts";
import type { Options } from "../collect/options.ts";
import { productSummary } from "../domain/finding.ts";

export type Notifier = (title: string, body: string) => Promise<void>;

const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** A macOS notification through osascript; nothing elsewhere. */
export const macNotifier =
  (exec: Exec): Notifier =>
  async (title, body) => {
    if (process.platform !== "darwin") return;
    const script = `display notification "${escape(body.slice(0, 240))}" with title "${escape(title.slice(0, 80))}"`;
    await exec("osascript", ["-e", script], { timeoutMs: 10_000 }).catch(() => undefined);
  };

/**
 * Records what should be said, from the journal since it last read: one intent per incident and kind, in the same
 * transaction as the reader's position. Nothing is sent here.
 */
export function recordNotificationIntents(db: DatabaseSync, options: Options, now: number): number {
  const state = db.prepare("SELECT position FROM projections WHERE name = 'notify'").get() as { position: number } | undefined;
  const rows = db
    .prepare("SELECT position, stream, type, data FROM journal WHERE position > ? AND type IN ('IncidentOpened', 'FindingRecorded') ORDER BY position")
    .all(state?.position ?? 0) as Array<{ position: number; stream: string; type: string; data: string }>;
  const end = (db.prepare("SELECT max(position) AS p FROM journal").get() as { p: number | null }).p ?? 0;
  let recorded = 0;
  for (const row of rows) {
    const incident = row.stream.slice(row.stream.indexOf("/") + 1);
    const opened = db.prepare("SELECT data FROM journal WHERE stream = ? AND type = 'IncidentOpened' ORDER BY position LIMIT 1").get(row.stream) as { data: string } | undefined;
    if (!opened) continue;
    const signal = JSON.parse(opened.data) as { app: string; environment: string; title: string; sample?: string };
    if (!options.notify || !options.apps[signal.app]?.environments[signal.environment]?.notify) continue;
    const kind = row.type === "IncidentOpened" ? "opened" : "finding";
    const where = `${signal.app}/${signal.environment}`;
    const title = kind === "opened" ? `New incident in ${where}` : `Finding for ${where}`;
    const body =
      kind === "opened"
        ? signal.sample
          ? `${signal.title}: ${signal.sample}`
          : signal.title
        : productSummary((JSON.parse(row.data) as { finding: { product: Parameters<typeof productSummary>[0] } }).finding.product);
    recorded += Number(
      db
        .prepare("INSERT OR IGNORE INTO notified (incident, kind, at, title, body, status, attempts, next_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)")
        .run(incident, kind, now, title, body, now).changes,
    );
  }
  db.prepare("INSERT INTO projections (name, position, version) VALUES ('notify', ?, 1) ON CONFLICT (name) DO UPDATE SET position = excluded.position").run(end);
  return recorded;
}

/** Attempts before a notification is given up as failed, and the first wait between attempts (doubling). */
export const NOTIFY_ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;

/**
 * Sends what is due: intent first (recorded), then delivery, then the result (sent, or another attempt later with a
 * growing wait, or failed with its reason after the last attempt). A crash between delivery and the result can repeat
 * one notification; it never loses one.
 */
export async function deliverNotifications(
  ports: { readonly atomically: <A>(work: (db: DatabaseSync) => A) => Promise<A>; readonly notify: Notifier },
  now: number,
): Promise<number> {
  const due = await ports.atomically(
    (db) =>
      db.prepare("SELECT incident, kind, title, body, attempts FROM notified WHERE status = 'pending' AND next_at <= ? ORDER BY at").all(now) as Array<{
        incident: string;
        kind: string;
        title: string;
        body: string;
        attempts: number;
      }>,
  );
  let sent = 0;
  for (const n of due) {
    let error: string | undefined;
    try {
      await ports.notify(n.title, n.body);
    } catch (e) {
      error = (e as Error).message.slice(0, 300);
    }
    const attempts = n.attempts + 1;
    await ports.atomically((db) => {
      if (error === undefined) db.prepare("UPDATE notified SET status = 'sent', attempts = ? WHERE incident = ? AND kind = ?").run(attempts, n.incident, n.kind);
      else
        db.prepare("UPDATE notified SET status = ?, attempts = ?, last_error = ?, next_at = ? WHERE incident = ? AND kind = ?").run(
          attempts >= NOTIFY_ATTEMPTS ? "failed" : "pending",
          attempts,
          error,
          now + FIRST_WAIT_MS * 2 ** (attempts - 1),
          n.incident,
          n.kind,
        );
    });
    if (error === undefined) sent++;
  }
  return sent;
}
