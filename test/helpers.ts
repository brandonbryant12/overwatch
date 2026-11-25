import type { Exec, ExecOptions, ExecResult } from "../src/collect/exec.ts";
import { parseOptions, type Options } from "../src/collect/options.ts";
import type { Finding } from "../src/collect/report.ts";
import type { Runtime } from "../src/collect/runtime.ts";

export interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ExecOptions;
}

/** A fake exec: `handler` answers each call; every call is recorded. Unhandled calls fail loudly. */
export function fakeExec(handler: (call: Call) => Partial<ExecResult> | undefined, fallback?: Exec): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const answer = handler(call);
    if (answer) return { code: 0, stdout: "", stderr: "", killed: false, ...answer };
    if (fallback) return fallback(command, args, options);
    return { code: 127, stdout: "", stderr: `unexpected call: ${command} ${args.join(" ")}`, killed: false };
  }) as Exec & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export function options(raw: Record<string, unknown>): Options {
  const parsed = parseOptions(raw);
  if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
  return parsed.options;
}

export function runtime(opts: Options, overrides: Partial<Runtime> = {}): Runtime & { clock: { now: number } } {
  const clock = { now: Date.parse("2026-11-25T12:00:00Z") };
  return {
    options: opts,
    exec: fakeExec(() => undefined),
    fetch: (async () => new Response("not faked", { status: 500 })) as unknown as typeof fetch,
    now: () => clock.now,
    log: () => undefined,
    clock,
    ...overrides,
  };
}

export const realFinding: Finding = {
  product: {
    impact: "Some card payments fail at checkout",
    affected: "customers paying by card",
    since: "2026-11-25 10:05 UTC",
    status: "ongoing",
  },
  engineering: {
    verdict: "real",
    confidence: "high",
    cause: "The payments client timeout dropped to 300ms in the deployed commit.",
    causeBasis: "observed",
    evidence: [
      { source: "errors", quote: "2026-11-25T10:05:00Z shop-api error payment 42 timed out after 300ms" },
      { source: "payments.ts", quote: "const TIMEOUT_MS = 300" },
    ],
    codeLocation: "payments.ts:1",
    notChecked: ["payment provider status page"],
    nextCheck: "Compare p95 of the provider call before and after the deploy.",
  },
  fix: { possible: true, plan: "Restore the timeout to 3000ms." },
};
