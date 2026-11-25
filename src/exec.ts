import { spawn } from "node:child_process";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command hit its timeout or the signal aborted it. */
  readonly killed: boolean;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Stop reading after this many bytes of stdout. */
  readonly maxBytes?: number;
}

/** Runs a program without a shell. Injectable so tests and smoke runs can use fakes. */
export type Exec = (command: string, args: ReadonlyArray<string>, options: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < maxBytes) stdout += chunk;
      if (stdout.length >= maxBytes) {
        stdout = stdout.slice(0, maxBytes);
        stop();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, killed });
    };
    child.on("error", (error) => {
      stderr += error.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });

/** Runs `fn` with a wall-clock timeout, aborting its signal when the time is up. */
export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** Runs tasks with at most `limit` in flight. */
export function limiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
