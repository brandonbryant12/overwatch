/**
 * The only module that starts another program, through Effect's `ChildProcessSpawner`. Reads (kubectl, git, security,
 * launchctl, tar) run through `run` or `stream`. Anything that leaves the laptop as an effect (a `gh` call, a
 * `git push`, a desktop notice) runs only through `effect`, with a Permit made in the transaction that recorded its
 * intent; `run` refuses it. A build test checks that no other module starts a process.
 */
import { Clock, Effect, Fiber, FileSystem, Option, Path, PlatformError, Redacted, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Permit } from "./store.ts";

export interface Result { readonly code: number; readonly stdout: string; readonly stderr: string; readonly timedOut?: boolean; readonly elapsedMs?: number }
export interface Options { readonly cwd?: string; readonly timeoutMs?: number; readonly maxBytes?: number; readonly env?: Record<string, string | undefined>; readonly exactEnv?: boolean; readonly group?: boolean }

/** What kind of outbound effect a command is, or null for a read. */
export function outbound(command: string, args: ReadonlyArray<string>): string | null {
  const name = command.split("/").at(-1);
  return name === "gh" && args[0] !== "--version" ? "host" : name === "terminal-notifier" ? "notice" : name === "git" && args.includes("push") ? "push" : null;
}

/** Runs a read to completion, without a shell, and never fails: a missing program is exit code 127. */
export const run = (command: string, args: ReadonlyArray<string>, options: Options = {}): Effect.Effect<Result, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const kind = outbound(command, args);
  if (kind) return Effect.die(new Error(`${command} is an outbound ${kind}: it runs only as an effect with a committed intent`));
  return start(command, args, options);
};

/** An outbound effect: its permit is spent first, so it runs at most once per recorded intent. */
export const effect = (permit: Permit, command: string, args: ReadonlyArray<string>, options: Options = {}): Effect.Effect<Result, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.suspend(() => {
    permit.spend(outbound(command, args) ?? "read", args);
    return start(command, args, options); });

const notFound = (error: PlatformError.PlatformError) => /ENOENT|NotFound/.test(`${error.reason._tag} ${error.message}`);
const decoder = () => new TextDecoder("utf-8");

const start = (command: string, args: ReadonlyArray<string>, o: Options): Effect.Effect<Result, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const began = yield* Clock.currentTimeMillis;
    // A group is killed whole, descendants included, at the limit and again when the leader exits.
    const options = { ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.env ? { env: o.env, extendEnv: !o.exactEnv } : {}), detached: Boolean(o.group), stdin: "ignore" as const };
    const spawned = yield* Effect.result(spawner.spawn(ChildProcess.make(command, [...args], options)));
    if (spawned._tag === "Failure") return { code: 127, stdout: "", stderr: `${command}: ${notFound(spawned.failure) ? "not found" : String(spawned.failure)}` };
    const handle = spawned.success;
    const kill = handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
    const max = o.maxBytes ?? 64 * 1024 * 1024;
    // What has been read so far, kept when the time limit kills the program. Past the byte cap it is killed too.
    const read = { bytes: 0, stdout: "", stderr: "" };
    const collect = (stream: Stream.Stream<Uint8Array, unknown>, key: "stdout" | "stderr") => Effect.suspend(() => {
      const text = decoder();
      return Stream.runForEach(stream, (chunk: Uint8Array) => {
        read.bytes += chunk.length;
        if (read.bytes > max) return kill;
        if (key === "stdout" || read.stderr.length < 65_536) read[key] += text.decode(chunk, { stream: true });
        return Effect.void;
      }).pipe(Effect.ignore);
    });
    const code = handle.exitCode.pipe(Effect.map(Number), Effect.orElseSucceed(() => 137)); // 137: ended by a signal
    const outcome = yield* Effect.all([collect(handle.stdout, "stdout"), collect(handle.stderr, "stderr"), code], { concurrency: "unbounded" }).pipe(Effect.timeoutOption(o.timeoutMs ?? 60_000));
    const elapsedMs = (yield* Clock.currentTimeMillis) - began;
    if (Option.isNone(outcome) || o.group) yield* kill;
    return { code: Option.isNone(outcome) ? 137 : outcome.value[2], stdout: read.stdout, stderr: read.stderr, timedOut: Option.isNone(outcome), elapsedMs };
  }));

export interface StreamRead { readonly code: number; readonly stderr: string; readonly capped: boolean; readonly cutTail: boolean; readonly stopped: boolean }

/**
 * Streams a read line by line, calling `line` for each complete one. Raw bytes count toward `maxBytes`; past it the
 * process is killed and the rest is capped. `line` returns false to stop the read.
 */
export const stream = <E = never, R = never>(command: string, args: ReadonlyArray<string>, maxBytes: number, line: (text: string) => Effect.Effect<boolean | void, E, R>): Effect.Effect<StreamRead, E, R | ChildProcessSpawner.ChildProcessSpawner> => {
  if (outbound(command, args)) return Effect.die(new Error(`${command} is an outbound effect`));
  return Effect.scoped(Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawned = yield* Effect.result(spawner.spawn(ChildProcess.make(command, [...args], { stdin: "ignore", detached: false })));
    if (spawned._tag === "Failure") return { code: 127, stderr: "", capped: false, cutTail: false, stopped: false };
    const handle = spawned.success, err = decoder(), out = decoder();
    let bytes = 0, capped = false, stopped = false, pending = "";
    const stderr = yield* Stream.runFold(handle.stderr, () => "", (acc, chunk: Uint8Array) => (acc.length < 8192 ? acc + err.decode(chunk) : acc)).pipe(Effect.orElseSucceed(() => ""), Effect.forkScoped);
    // Complete lines go to `line` while it wants more and the bytes stay under the cap; a cut last line is dropped.
    const read = Stream.runForEachWhile(handle.stdout, (chunk: Uint8Array) => Effect.gen(function* () {
      capped = bytes + chunk.length > maxBytes;
      const piece = capped ? chunk.subarray(0, Math.max(0, maxBytes - bytes)) : chunk;
      bytes += piece.length;
      pending += out.decode(piece, { stream: !capped });
      for (let cut; (cut = pending.indexOf("\n")) >= 0; pending = pending.slice(cut + 1)) {
        if ((yield* line(pending.slice(0, cut))) !== false) continue;
        [stopped, capped] = [true, false];
        return false;
      }
      return !capped;
    })).pipe(Effect.catchIf(PlatformError.isPlatformError, () => Effect.void));
    const finished = yield* read.pipe(Effect.timeoutOption(120_000));
    if (capped || stopped || Option.isNone(finished)) yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
    const code = capped || stopped ? 0 : yield* handle.exitCode.pipe(Effect.map(Number), Effect.orElseSucceed(() => 1));
    return { code, stderr: yield* Fiber.join(stderr), capped, cutTail: !capped && !stopped && pending.length > 0, stopped };
  }));
};

/** `env:NAME` or `keychain:service/account`. The value is used for transport only and never stored. */
export const secret = (ref: string): Effect.Effect<Redacted.Redacted<string> | null, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const m = /^keychain:([^/]+)\/(.+)$/.exec(ref);
  const value = ref.startsWith("env:")
    ? Effect.succeed(process.env[ref.slice(4)] ?? "")
    : m ? Effect.map(run("security", ["find-generic-password", "-s", m[1]!, "-a", m[2]!, "-w"], { timeoutMs: 10_000 }), (r) => (r.code === 0 ? r.stdout.trim() : "")) : Effect.succeed("");
  return Effect.map(value, (v) => (v ? Redacted.make(v) : null));
};

/** A private scratch folder named for this process, so a later start can tell an orphan from a live one. */
export const scratch = (prefix: string) => FileSystem.FileSystem.use((fs) => fs.makeTempDirectory({ prefix: `${prefix}${process.pid}-` })).pipe(Effect.orDie);

/** Whether a process is gone (not merely someone else's). */
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };
/** At start: remove the scratch of processes that no longer run (a killed verify, demo, trial or calibration). */
export const sweep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = process.getBuiltinModule("node:os").tmpdir();
  for (const n of yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))) {
    const pid = Number(/^(?:overwatch-(?:demo|trial)|ow-(?:verify|fix|pr|calibration|calibration-work))-(\d+)-/.exec(n)?.[1] ?? 0);
    if (pid && pid !== process.pid && gone(pid)) yield* fs.remove(path.join(dir, n), { recursive: true, force: true }).pipe(Effect.ignore);
  }
});
