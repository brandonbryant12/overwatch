/**
 * Briefs: what changed between two event positions, for the owner (technical) or a team (plain language). Built
 * only from stored facts inside the fence, so the same fence gives the same text, also after a restart. Nothing is
 * invented: no impact, fix or answer that was not recorded. A part of the interval that compaction removed is
 * named. Copy-only: the owner sends it.
 */
import type { Config } from "./config.ts";
import { HttpError } from "./inbox.ts";
import type { Store } from "./store.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function brief(store: Store, config: Config, audience: string, after = 0, through = store.seq()) {
  if (audience !== "owner" && audience !== "team") throw new HttpError(400, "audience is owner or team");
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after < 0 || through < after || through > store.seq()) throw new HttpError(400, "afterSeq and throughSeq must satisfy 0 ≤ afterSeq ≤ throughSeq ≤ the current seq");
  const team = audience === "team";
  const inside = (sql: string) => `${sql} > ${after} AND ${sql} <= ${through}`;
  const places = config.watchers.map((w) => ({ app: w.app, environment: w.environment }));
  const name = (p: { app: string; environment: string }) => `${p.app} ${p.environment}`;
  const fresh = store.all<{ app: string; environment: string; title: string; severity: string }>(`SELECT * FROM incidents WHERE ${inside("first_seq")} ORDER BY first_seq, id`);
  const returned = store.all<{ subject: string; data: string }>(`SELECT subject, data FROM events WHERE kind = 'returned' AND ${inside("seq")} ORDER BY seq`);
  const decided = store.all<{ subject: string; data: string }>(`SELECT subject, data FROM events WHERE kind = 'adjudicated' AND ${inside("seq")} ORDER BY seq`);
  const deploys = store.all<{ app: string; environment: string; revision: string }>(`SELECT * FROM deploys WHERE ${inside("seq")} ORDER BY seq`);
  const failed = store.all<{ subject: string; data: string }>(`SELECT subject, data FROM events WHERE kind = 'source_failed' AND ${inside("seq")} ORDER BY seq`);
  const gaps = store.all<{ source: string; reading: string; state: string }>(`SELECT DISTINCT source, reading, state FROM coverage WHERE state <> 'ok' AND ${inside("seq")}`);
  // Open as of the fence: the disposition and quiet state are replayed from events up to `through`, so a later
  // Done, return or quiet cannot rewrite a past brief.
  const open = store.all<{ id: string; app: string; environment: string; title: string; severity: string; active: number }>(
    `SELECT id, app, environment, title, severity, active FROM incidents WHERE first_seq <= ${through} ORDER BY severity, first_seq`)
    .filter((i) => {
      const last = (kinds: string, cmp: string) => store.get<{ kind: string; data: string }>(`SELECT kind, data FROM events WHERE subject = ? AND kind IN (${kinds}) AND seq ${cmp} ${through} ORDER BY seq DESC LIMIT 1`, i.id);
      const way = last("'action','returned'", "<=");
      if (way?.kind === "action" && (JSON.parse(way.data) as { way: unknown }).way) return false;
      const quiet = last("'quieted','returned'", "<=");
      return quiet ? quiet.kind === "returned" : i.active === 1 || !!last("'quieted'", ">");
    });
  const earliest = store.get<{ s: number | null }>("SELECT min(seq) AS s FROM events")?.s ?? null;
  const title = (id: string) => store.get<{ title: string; app: string; environment: string }>("SELECT title, app, environment FROM incidents WHERE id = ?", id);
  // The evidence a decision rests on: the handles cited by the readings that agree with the verdict.
  const cited = (findings: string[]) => findings.length
    ? store.all<{ handle: string }>(`SELECT DISTINCT handle FROM citations WHERE finding IN (${findings.map(() => "?").join(",")}) ORDER BY handle`, ...findings).map((c) => c.handle)
    : [];

  const changed: string[] = [];
  for (const p of places) {
    const here = fresh.filter((i) => i.app === p.app && i.environment === p.environment);
    if (here.length) {
      changed.push(team
        ? `${name(p)}: ${plural(here.filter((i) => i.severity === "error").length, "new error")} and ${plural(here.filter((i) => i.severity !== "error").length, "new warning")} appeared.`
        : `${name(p)}: new ${here.map((i) => `${i.severity} «${i.title}»`).join("; ")}.`);
    }
  }
  for (const d of deploys) changed.push(team ? `${d.app} ${d.environment} received a new release.` : `${d.app} ${d.environment}: deployed ${d.revision.slice(0, 12)}.`);
  for (const r of returned) {
    const t = title(r.subject), data = JSON.parse(r.data) as { reason: string };
    if (t) changed.push(team ? `A known ${t.app} ${t.environment} problem came back.` : `${t.app} ${t.environment}: «${t.title}» came back: ${data.reason}`);
  }
  for (const d of decided) {
    const t = title(d.subject), r = (JSON.parse(d.data) as { result: { verdict: string; counts: Record<string, number>; planned: number; challenge: { outcome: string | null } | null; readings?: Array<{ verdict: string | null; findingId: string | null }> } }).result;
    if (!t) continue;
    const votes = `${r.counts.real ?? 0} of ${r.planned} said real`;
    const overturned = (r.counts.real ?? 0) > r.planned / 2 && r.challenge?.outcome === "disproved";
    const handles = cited((r.readings ?? []).filter((x) => x.verdict === r.verdict && x.findingId).map((x) => x.findingId!));
    changed.push(team
      ? `An investigation of a ${t.app} ${t.environment} problem concluded: ${r.verdict === "real" ? "it is real" : r.verdict === "not_real" ? "it is not a real problem" : "it could not decide"}${overturned ? " (most investigators said real, but a challenger disproved that, so the majority was overturned)" : r.counts.real && r.counts.real < r.planned ? " (the investigators disagreed)" : ""}.`
      : `${t.app} ${t.environment}: «${t.title}» investigated: ${r.verdict.replace("_", " ")} (${votes}${r.challenge ? `, challenger ${r.challenge.outcome ?? "did not file"}` : ""}${overturned ? "; majority overturned" : ""})${handles.length ? `; evidence ${handles.join(", ")}` : ""}.`);
  }

  const impact = places.flatMap((p) => {
    const errors = open.filter((i) => i.app === p.app && i.environment === p.environment && i.severity === "error");
    if (!errors.length) return [];
    return [team ? `${name(p)}: ${plural(errors.length, "error problem")} active; the effect on people is not recorded.` : `${name(p)}: ${errors.map((i) => `«${i.title}»`).join("; ")}; impact not recorded.`];
  });

  const still = places.flatMap((p) => {
    const here = open.filter((i) => i.app === p.app && i.environment === p.environment);
    if (!here.length) return [];
    return [team ? `${name(p)}: ${plural(here.length, "problem")} still open.` : `${name(p)}: ${here.map((i) => `${i.severity} «${i.title}»`).join("; ")}.`];
  });

  const next: string[] = [];
  const unchecked = new Map<string, Set<string>>();
  for (const f of failed) (unchecked.get(f.subject) ?? unchecked.set(f.subject, new Set()).get(f.subject)!).add((JSON.parse(f.data) as { kind: string }).kind);
  for (const g of gaps) (unchecked.get(g.source) ?? unchecked.set(g.source, new Set()).get(g.source)!).add(g.state);
  for (const [source, kinds] of unchecked) {
    const [app = source, environment = ""] = source.split("/");
    next.push(team ? `Part of ${app} ${environment} could not be checked; what happened there is unknown.` : `${source} could not be checked fully (${[...kinds].join(", ")}): unknown until it is read again.`);
  }
  if (earliest !== null && earliest > after + 1) next.push(team ? "Part of this period is no longer kept, so it is unknown." : `Events ${after + 1}–${earliest - 1} were compacted: unknown.`);

  const section = (heading: string, lines: string[], none: string) => `${heading}\n${lines.length ? lines.map((l) => `- ${l}`).join("\n") : `- ${none}`}`;
  const text = [
    team ? `Update on ${places.map(name).join(", ")}` : `Overwatch brief, events ${after + 1}–${through}: ${places.map(name).join(", ")}`,
    section("What changed", [...new Set(changed)], "None recorded."),
    section("Impact", impact, "None recorded."),
    section("Still open", still, "None recorded."),
    section("Next check", [...new Set(next)], "None recorded."),
  ].join("\n\n");
  return { audience, afterSeq: after, throughSeq: through, text };
}
