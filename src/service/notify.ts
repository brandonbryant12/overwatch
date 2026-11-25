/**
 * Telling the owner. One notification when an incident opens in an environment that notifies (production by
 * default), and one when a finding arrives for it: never more than once per incident per kind. Notifications are a
 * reaction to the journal, recorded before they are sent, so a crash cannot repeat one.
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

/** Reads the journal from where it last stopped and returns the notifications to send, already recorded as sent. */
export function dueNotifications(db: DatabaseSync, options: Options): Array<{ title: string; body: string }> {
  const state = db.prepare("SELECT position FROM projections WHERE name = 'notify'").get() as { position: number } | undefined;
  const rows = db
    .prepare("SELECT position, stream, type, data FROM journal WHERE position > ? AND type IN ('IncidentOpened', 'FindingRecorded') ORDER BY position")
    .all(state?.position ?? 0) as Array<{ position: number; stream: string; type: string; data: string }>;
  const end = (db.prepare("SELECT max(position) AS p FROM journal").get() as { p: number | null }).p ?? 0;
  const out: Array<{ title: string; body: string }> = [];
  for (const row of rows) {
    const incident = row.stream.slice(row.stream.indexOf("/") + 1);
    const opened = db.prepare("SELECT data FROM journal WHERE stream = ? AND type = 'IncidentOpened' ORDER BY position LIMIT 1").get(row.stream) as { data: string } | undefined;
    if (!opened) continue;
    const signal = JSON.parse(opened.data) as { app: string; environment: string; title: string; sample?: string };
    if (!options.notify || !options.apps[signal.app]?.environments[signal.environment]?.notify) continue;
    const kind = row.type === "IncidentOpened" ? "opened" : "finding";
    const fresh = db.prepare("INSERT OR IGNORE INTO notified (incident, kind, at) VALUES (?, ?, ?)").run(incident, kind, Date.now()).changes > 0;
    if (!fresh) continue;
    const where = `${signal.app}/${signal.environment}`;
    if (kind === "opened") out.push({ title: `New incident in ${where}`, body: signal.sample ? `${signal.title}: ${signal.sample}` : signal.title });
    else out.push({ title: `Finding for ${where}`, body: productSummary((JSON.parse(row.data) as { finding: { product: Parameters<typeof productSummary>[0] } }).finding.product) });
  }
  db.prepare("INSERT INTO projections (name, position, version) VALUES ('notify', ?, 1) ON CONFLICT (name) DO UPDATE SET position = excluded.position").run(end);
  return out;
}
