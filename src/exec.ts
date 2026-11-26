/** Running other programs (kubectl, git, gh, opencode, launchctl, security), and resolving secret references. */
import { spawn } from "node:child_process";

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program to completion, without a shell, and never throws: a missing program is exit code 127. */
export function run(command: string, args: ReadonlyArray<string>, options: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Promise<Result> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", bytes = 0;
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= (options.maxBytes ?? 64 * 1024 * 1024)) stdout += chunk;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: `${command}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr });
    });
  });
}

/** `env:NAME` or `keychain:service/account`. The value is used for transport only and never stored. */
export async function secret(ref: string): Promise<string | null> {
  if (ref.startsWith("env:")) return process.env[ref.slice(4)] || null;
  const m = /^keychain:([^/]+)\/(.+)$/.exec(ref);
  if (!m) return null;
  const r = await run("security", ["find-generic-password", "-s", m[1]!, "-a", m[2]!, "-w"], { timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}
