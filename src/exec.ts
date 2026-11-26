/**
 * The only module that starts another program. Reads (kubectl, git, security, launchctl, tar) run through `run` or
 * `stream`. Anything that leaves the laptop as an effect (a `gh` call, a `git push`, a desktop notice) runs only
 * through `effect`, with a Permit made in the transaction that recorded its intent; `run` refuses it. A build test
 * checks that no other module imports child_process.
 */
import { spawn } from "node:child_process";
import type { Permit } from "./store.ts";

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Killed at its time limit (the code is then 137). */
  readonly timedOut?: boolean;
  readonly elapsedMs?: number;
}
interface Options { cwd?: string; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv; exactEnv?: boolean; group?: boolean }

/** What kind of outbound effect a command is, or null for a read. */
export function outbound(command: string, args: ReadonlyArray<string>): string | null {
  const name = command.split("/").at(-1);
  return name === "gh" ? "host" : name === "terminal-notifier" ? "notice" : name === "git" && args.includes("push") ? "push" : null;
}

/** Runs a read to completion, without a shell, and never throws: a missing program is exit code 127. */
export function run(command: string, args: ReadonlyArray<string>, options: Options = {}): Promise<Result> {
  const kind = outbound(command, args);
  if (kind) throw new Error(`${command} is an outbound ${kind}: it runs only as an effect with a committed intent`);
  return start(command, args, options);
}

/** An outbound effect: its permit is spent first, so it runs at most once per recorded intent. */
export function effect(permit: Permit, command: string, args: ReadonlyArray<string>, options: Options = {}): Promise<Result> {
  permit.spend(outbound(command, args) ?? "read");
  return start(command, args, options);
}

function start(command: string, args: ReadonlyArray<string>, o: Options): Promise<Result> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", bytes = 0, timedOut = false;
    const began = Date.now();
    const env = o.exactEnv ? o.env : o.env ? { ...process.env, ...o.env } : undefined;
    const child = spawn(command, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: Boolean(o.group), ...(env ? { env } : {}) });
    // A group is killed whole, descendants included, at the limit and again when the leader exits.
    const kill = () => {
      try {
        if (o.group) process.kill(-child.pid!, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => ((timedOut = true), kill()), o.timeoutMs ?? 60_000);
    const take = (chunk: Buffer, err: boolean) => {
      bytes += chunk.length;
      if (bytes > (o.maxBytes ?? 64 * 1024 * 1024)) return kill();
      if (err) stderr += stderr.length < 65_536 ? chunk : "";
      else stdout += chunk;
    };
    child.stdout.on("data", (c: Buffer) => take(c, false));
    child.stderr.on("data", (c: Buffer) => take(c, true));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: `${command}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (o.group) kill();
      resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr, timedOut, elapsedMs: Date.now() - began });
    });
  });
}

export interface StreamRead {
  readonly code: number;
  readonly stderr: string;
  /** Stopped at the byte cap: what was not read is unknown. */
  readonly capped: boolean;
  /** The last line had no newline (a killed or capped command): it was dropped. */
  readonly cutTail: boolean;
  /** The caller stopped the read. */
  readonly stopped: boolean;
}
/**
 * Streams a read line by line, calling `line` for each complete one. Raw bytes count toward `maxBytes`; past it the
 * process is killed and the rest is capped. `line` returns false to stop the read.
 */
export function stream(command: string, args: ReadonlyArray<string>, maxBytes: number, line: (text: string) => boolean | void): Promise<StreamRead> {
  if (outbound(command, args)) throw new Error(`${command} is an outbound effect`);
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, capped = false, stopped = false, pending = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (capped || stopped) return;
      let text = chunk;
      if (bytes + Buffer.byteLength(chunk) > maxBytes) {
        text = Buffer.from(chunk).subarray(0, maxBytes - bytes).toString("utf8");
        capped = true;
        child.kill("SIGKILL");
      }
      bytes += Buffer.byteLength(text);
      pending += text;
      for (let cut; (cut = pending.indexOf("\n")) >= 0; ) {
        const raw = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        if (line(raw) === false) {
          stopped = true;
          capped = false;
          child.kill("SIGKILL");
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => void (stderr.length < 8192 && (stderr += chunk)));
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({ code: capped || stopped ? 0 : code, stderr, capped, cutTail: !capped && !stopped && pending.length > 0, stopped });
    };
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
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
