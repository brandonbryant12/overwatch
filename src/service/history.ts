/**
 * Code history for investigators, as structured read operations. The investigator has no shell: it asks for a log,
 * a commit, a blame or a diff, each field is checked against what is allowed, and the service builds the git
 * command itself. Nothing an agent sends becomes an option, and paths come after `--`, inside the thread's worktree.
 * Git features that run programs or write files are switched off for every call.
 */
const COMMIT = /^([0-9a-f]{7,40}|HEAD(~\d{1,3})?)$/;
const PATH = /^[A-Za-z0-9_@+][A-Za-z0-9._@+/ -]{0,400}$/;

/** Run before every subcommand: no pager, no external diff or text conversion, no fsmonitor program, no hooks. */
const SAFE = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "core.pager=cat"];

export type HistoryRequest =
  | { readonly operation: "log"; readonly path?: string; readonly max?: number }
  | { readonly operation: "show"; readonly commit: string; readonly path?: string }
  | { readonly operation: "blame"; readonly path: string; readonly from?: number; readonly to?: number }
  | { readonly operation: "diff"; readonly from: string; readonly to: string; readonly path?: string };

const commit = (value: unknown, name: string) => {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${name} must be a commit hash or HEAD~n`);
  return value;
};
const path = (value: unknown, required: boolean) => {
  if (value === undefined && !required) return [];
  if (typeof value !== "string" || !PATH.test(value) || value.split("/").includes("..")) {
    throw new Error("path must be a relative path inside the working directory");
  }
  return ["--", value];
};
const int = (value: unknown, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`a number from 1 to ${max} was expected`);
  return value;
};

/** The git arguments for a request, or throws with why it is not allowed. */
export function gitHistoryArgs(input: Record<string, unknown>): string[] {
  switch (input.operation) {
    case "log":
      return [...SAFE, "log", "--no-color", "--date=iso", "--format=%H %ad %an%n    %s", "-n", String(int(input.max, 20, 200)), ...path(input.path, false)];
    case "show":
      return [...SAFE, "show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", commit(input.commit, "commit"), ...path(input.path, false)];
    case "blame": {
      const from = int(input.from, 1, 1_000_000);
      const to = int(input.to, from + 80, 1_000_000);
      return [...SAFE, "blame", "--date=short", "-L", `${from},${Math.max(from, to)}`, ...path(input.path, true)];
    }
    case "diff":
      return [...SAFE, "diff", "--no-color", "--no-ext-diff", "--no-textconv", commit(input.from, "from"), commit(input.to, "to"), ...path(input.path, false)];
    default:
      throw new Error('operation must be "log", "show", "blame" or "diff"');
  }
}
