import { formatDuration, iso } from "../collect/duration.ts";
import { errorText } from "../domain/redact.ts";
import type { Exec } from "../collect/exec.ts";
import { redactText } from "../collect/redact.ts";
import { sourceContext, type Runtime } from "../collect/runtime.ts";
import { kubernetesConfig, kubectl, parsePods, parseWorkloads, revisionOf, WORKLOAD_RESOURCES, type PodInfo, type ReplicaSetInfo } from "../collect/sources/kubernetes.ts";

/**
 * What is deployed and since when, for an investigation's brief. "Did something ship just before this started?"
 * is the first question in most incidents, and the cluster and the repository can answer it without a model.
 */
export interface DeployContext {
  /** The ref of what is running: the configured command's answer, or the revision most pods carry. */
  readonly ref?: string;
  /** The ref that ran before the current rollout, when the cluster still remembers it. */
  readonly previousRef?: string;
  /** When the current revision started rolling out. */
  readonly rolledOutAt?: number;
  /** Lines for the brief, from the cluster. */
  readonly lines: ReadonlyArray<string>;
  /** What could not be read. */
  readonly notes: ReadonlyArray<string>;
}

const oldest = (pods: ReadonlyArray<PodInfo>) => Math.min(...pods.flatMap((pod) => (pod.startedAt !== undefined ? [pod.startedAt] : [])));

/** The ReplicaSet serving now and the one before it, by the revision number their Deployment gave them. */
export function rollout(replicaSets: ReadonlyArray<ReplicaSetInfo>): { current?: ReplicaSetInfo; previous?: ReplicaSetInfo; rolledBack: boolean } {
  const ordered = replicaSets.filter((rs) => rs.revision !== undefined).sort((a, b) => b.revision! - a.revision!);
  const current = ordered.find((rs) => rs.replicas > 0);
  if (!current) return { rolledBack: false };
  const previous = ordered.find((rs) => rs.owner === current.owner && rs.revision! < current.revision!);
  // A rollback reuses an old ReplicaSet under a new revision number, so its creation time is not the rollout time.
  const rolledBack = ordered.some((rs) => rs.owner === current.owner && rs.revision! < current.revision! && (rs.createdAt ?? 0) > (current.createdAt ?? 0));
  return { current, ...(previous ? { previous } : {}), rolledBack };
}

export async function deployContext(runtime: Runtime, appName: string, environment: string, signal: AbortSignal): Promise<DeployContext> {
  const app = runtime.options.apps[appName];
  const env = app?.environments[environment];
  if (!app || !env) return { lines: [], notes: [] };
  const setting = env.deployedCommit;
  const lines: string[] = [];
  const notes: string[] = [];
  let ref: string | undefined;
  let previousRef: string | undefined;
  let rolledOutAt: number | undefined;

  if (setting?.command?.length) {
    const [program, ...args] = setting.command;
    const result = await runtime.exec(program!, args, { cwd: app.checkout, timeoutMs: runtime.options.timeouts.sourceMs, signal });
    const value = result.stdout.trim().split(/\s+/)[0];
    if (result.code === 0 && value) ref = value;
    else notes.push(`deployedCommit.command did not print a commit (${redactText(result.stderr.trim() || `exit ${result.code}`, { maxBytes: 120 })})`);
  }

  const name = setting?.source ?? Object.entries(env.sources).find(([, source]) => source.type === "kubernetes")?.[0];
  const source = name ? env.sources[name] : undefined;
  if (!name || !source || source.type !== "kubernetes") return { ...(ref ? { ref } : {}), lines, notes };

  const config = kubernetesConfig(source);
  const from = setting?.from ?? "image-tag";
  const context = sourceContext(runtime, appName, environment, name, signal);
  const listed = await kubectl(config, "get", ["pods", "-l", config.selector, "-o", "json"], context);
  if (listed.code !== 0) {
    notes.push(`deploy context not read from ${name} (${redactText(listed.stderr.trim() || `exit ${listed.code}`, { maxBytes: 120 })})`);
    return { ...(ref ? { ref } : {}), lines, notes };
  }
  let pods: PodInfo[];
  try {
    pods = parsePods(listed.stdout);
  } catch (error) {
    notes.push(`deploy context not read from ${name} (${errorText(error, 200)})`);
    return { ...(ref ? { ref } : {}), lines, notes };
  }

  const byRevision = new Map<string, PodInfo[]>();
  for (const pod of pods) {
    const revision = revisionOf({ image: pod.containers[0]?.image ?? "", labels: pod.labels, annotations: pod.annotations }, from) ?? "(unknown revision)";
    byRevision.set(revision, [...(byRevision.get(revision) ?? []), pod]);
  }
  const running = [...byRevision.entries()].sort((a, b) => b[1].length - a[1].length);
  ref ??= running.find(([revision]) => revision !== "(unknown revision)")?.[0];
  if (running.length) {
    const parts = running.map(([revision, group]) => `${revision} on ${group.length} of ${pods.length} pods (oldest started ${Number.isFinite(oldest(group)) ? iso(oldest(group)) : "not yet"})`);
    lines.push(`Running in ${name}: ${parts.join("; ")}.${running.length > 1 ? " More than one revision is running: a rollout is under way or stopped part way." : ""}`);
  } else lines.push(`No pods are running for ${config.selector} in ${name}.`);

  const workloads = await kubectl(config, "get", [WORKLOAD_RESOURCES, "-o", "json"], context);
  let replicaSets: ReadonlyArray<ReplicaSetInfo> = [];
  try {
    replicaSets = parseWorkloads(workloads.stdout, config.selector, config.workload).replicaSets;
  } catch {
    notes.push(`rollout history not read from ${name}; the rollout time is taken from pod start times`);
  }
  const { current, previous, rolledBack } = rollout(replicaSets);
  if (current) {
    const started = oldest(pods.filter((pod) => pod.owner === current.name));
    rolledOutAt = rolledBack ? (Number.isFinite(started) ? started : undefined) : current.createdAt;
    const what = revisionOf(current, from);
    lines.push(
      `Current rollout: revision ${current.revision}${what ? ` (${what})` : ""}${rolledOutAt !== undefined ? ` began ${iso(rolledOutAt)}` : ""}${rolledBack ? "; this is a rollback to an earlier revision" : ""}.`,
    );
    if (previous) {
      previousRef = revisionOf(previous, from);
      lines.push(`Before it: revision ${previous.revision}${previousRef ? ` (${previousRef})` : ""}${previous.createdAt !== undefined ? `, first rolled out ${iso(previous.createdAt)}` : ""}.`);
    }
  } else if (pods.length && Number.isFinite(oldest(pods))) {
    // No Deployment history (a StatefulSet, a DaemonSet, or no permission): pod start times are the best signal.
    rolledOutAt = oldest(byRevision.get(ref ?? "") ?? pods);
  }
  const restarted = pods.filter((pod) => pod.restarts > 0);
  if (restarted.length) lines.push(`Container restarts: ${restarted.slice(0, 5).map((pod) => `${pod.name} ${pod.restarts}`).join(", ")}.`);

  return { ...(ref ? { ref } : {}), ...(previousRef ? { previousRef } : {}), ...(rolledOutAt !== undefined ? { rolledOutAt } : {}), lines, notes };
}

/**
 * What the repository says about the deployed commit: when it was committed, and what the rollout brought in.
 * Commit subjects are written by whoever committed, so the brief presents them as data.
 */
export async function commitContext(exec: Exec, checkout: string, commit: string, previous: string | undefined): Promise<string[]> {
  const git = (args: string[]) => exec("git", args, { cwd: checkout, timeoutMs: 30_000 });
  const lines: string[] = [];
  const head = await git(["log", "-1", "--format=%cI%x09%s", commit, "--"]);
  if (head.code === 0 && head.stdout.trim()) {
    const [date, subject] = head.stdout.trim().split("\t");
    lines.push(`Deployed commit ${commit.slice(0, 12)}, committed ${date}: ${redactText(subject ?? "", { maxBytes: 160 })}`);
  }
  if (previous && previous !== commit) {
    const count = await git(["rev-list", "--count", `${previous}..${commit}`, "--"]);
    const total = Number(count.stdout.trim());
    if (count.code === 0 && total > 0) {
      const log = await git(["log", "--no-merges", "--format=%h %cs %s", "-n", "15", `${previous}..${commit}`]);
      const subjects = log.stdout.trim().split("\n").filter(Boolean);
      lines.push(`The current rollout brought in ${total} commit(s) since ${previous.slice(0, 12)}${subjects.length < total ? ` (newest ${subjects.length} shown)` : ""}:`);
      lines.push(...subjects.map((subject) => `  ${redactText(subject, { maxBytes: 160 })}`));
    } else if (count.code === 0) {
      const back = await git(["rev-list", "--count", `${commit}..${previous}`]);
      if (Number(back.stdout.trim()) > 0) lines.push(`The deployed commit is ${back.stdout.trim()} commit(s) behind the previous revision ${previous.slice(0, 12)}: this rollout moved backwards.`);
    }
  }
  return lines;
}

/** Where the rollout sits against the investigation window, in one line. */
export function rolloutTiming(rolledOutAt: number | undefined, window: { readonly from: number; readonly to: number }): string | undefined {
  if (rolledOutAt === undefined) return undefined;
  const span = (ms: number) => formatDuration(Math.max(60_000, Math.round(Math.abs(ms) / 60_000) * 60_000));
  if (rolledOutAt > window.to) return `The current rollout began ${span(rolledOutAt - window.to)} after the investigation window ends.`;
  if (rolledOutAt >= window.from) {
    return `The current rollout began inside the investigation window, ${span(rolledOutAt - window.from)} after it starts. Check whether the problem starts with it.`;
  }
  return `The current rollout began ${span(window.from - rolledOutAt)} before the investigation window starts.`;
}

/** The full commit a ref names in the checkout, or undefined. Refs that look like options are not looked up. */
export async function resolveCommit(exec: Exec, checkout: string, ref: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(ref)) return undefined;
  const result = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: checkout, timeoutMs: 30_000 });
  const commit = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}
