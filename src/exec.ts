/**
 * The only module that starts another program, through Effect's `ChildProcessSpawner`. Reads (kubectl, git, security,
 * launchctl, tar) run through `run` or `stream`. Anything that leaves the laptop as an effect (a `gh` call, a
 * `git push`, a desktop notice) runs only through `effect`, with a Permit made in the transaction that recorded its
 * intent; `run` refuses it. A build test checks that no other module starts a process.
 */
import { Clock, Effect, Fiber, FileSystem, Option, Path, PlatformError, Redacted, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Permit } from "./store.ts";

export interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Killed at its time limit (the code is then 137). */
  readonly timedOut?: boolean;
  readonly elapsedMs?: number;
}
export interface Options {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly env?: Record<string, string | undefined>;
  /** Only `env`, not the service's own environment. */
  readonly exactEnv?: boolean;
  /** The program and its descendants are one process group, killed whole. */
  readonly group?: boolean;
}

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
    return start(command, args, options);
  });

const notFound = (error: PlatformError.PlatformError) => /ENOENT|NotFound/.test(`${error.reason._tag} ${error.message}`);
const decoder = () => new TextDecoder("utf-8");

const start = (command: string, args: ReadonlyArray<string>, o: Options): Effect.Effect<Result, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const began = yield* Clock.currentTimeMillis;
      const spawned = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make(command, [...args], {
            ...(o.cwd ? { cwd: o.cwd } : {}),
            ...(o.env ? { env: o.env, extendEnv: !o.exactEnv } : {}),
            // A group is killed whole, descendants included, at the limit and again when the leader exits.
            detached: Boolean(o.group),
            stdin: "ignore",
          }),
        ),
      );
      if (spawned._tag === "Failure") {
        return { code: 127, stdout: "", stderr: `${command}: ${notFound(spawned.failure) ? "not found" : String(spawned.failure)}` };
      }
      const handle = spawned.success;
      const bytes = yield* Ref.make(0);
      const kill = handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
      const max = o.maxBytes ?? 64 * 1024 * 1024;
      // Each stream is collected while the total stays under the cap; past it the program is killed.
      const collect = (stream: Stream.Stream<Uint8Array, unknown>, keep: (text: string, chunk: string) => string) =>
        Effect.suspend(() => {
          const text = decoder();
          return Stream.runFoldEffect(stream, () => "", (acc, chunk: Uint8Array) =>
            Ref.updateAndGet(bytes, (n) => n + chunk.length).pipe(
              Effect.flatMap((n) => (n > max ? Effect.as(kill, acc) : Effect.succeed(keep(acc, text.decode(chunk, { stream: true }))))),
            ),
          ).pipe(Effect.orElseSucceed(() => ""));
        });
      const work = Effect.all(
        [
          collect(handle.stdout, (acc, chunk) => acc + chunk),
          collect(handle.stderr, (acc, chunk) => (acc.length < 65_536 ? acc + chunk : acc)),
          handle.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => 137), // ended by a signal
          ),
        ],
        { concurrency: "unbounded" },
      );
      const outcome = yield* work.pipe(Effect.timeoutOption(o.timeoutMs ?? 60_000));
      const elapsedMs = (yield* Clock.currentTimeMillis) - began;
      if (Option.isNone(outcome)) {
        yield* kill;
        return { code: 137, stdout: "", stderr: "", timedOut: true, elapsedMs };
      }
      const [stdout, stderr, code] = outcome.value;
      if (o.group) yield* kill;
      return { code, stdout, stderr, timedOut: false, elapsedMs };
    }),
  );

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
export const stream = <E = never, R = never>(
  command: string,
  args: ReadonlyArray<string>,
  maxBytes: number,
  line: (text: string) => Effect.Effect<boolean | void, E, R>,
): Effect.Effect<StreamRead, E, R | ChildProcessSpawner.ChildProcessSpawner> => {
  if (outbound(command, args)) return Effect.die(new Error(`${command} is an outbound effect`));
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Effect.result(spawner.spawn(ChildProcess.make(command, [...args], { stdin: "ignore", detached: false })));
      if (spawned._tag === "Failure") return { code: 127, stderr: "", capped: false, cutTail: false, stopped: false };
      const handle = spawned.success;
      const kill = handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore);
      let bytes = 0, capped = false, stopped = false, pending = "";
      const text = decoder();
      const stderr = yield* Stream.runFold(handle.stderr, () => "", (acc, chunk: Uint8Array) => (acc.length < 8192 ? acc + text.decode(chunk) : acc)).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.forkScoped,
      );
      const out = decoder();
      const read = Stream.runForEachWhile(handle.stdout, (chunk: Uint8Array) =>
        Effect.gen(function* () {
          let piece = chunk;
          if (bytes + chunk.length > maxBytes) {
            piece = chunk.subarray(0, Math.max(0, maxBytes - bytes));
            capped = true;
          }
          bytes += piece.length;
          pending += out.decode(piece, { stream: !capped });
          for (let cut; (cut = pending.indexOf("\n")) >= 0; ) {
            const raw = pending.slice(0, cut);
            pending = pending.slice(cut + 1);
            if ((yield* line(raw)) === false) {
              stopped = true;
              capped = false;
              return false;
            }
          }
          return !capped;
        }),
      ).pipe(Effect.catchIf(PlatformError.isPlatformError, () => Effect.void));
      const limit = yield* read.pipe(Effect.timeoutOption(120_000));
      if (capped || stopped || Option.isNone(limit)) yield* kill;
      const code = capped || stopped ? 0 : yield* handle.exitCode.pipe(Effect.map(Number), Effect.orElseSucceed(() => 1));
      return { code, stderr: yield* Fiber.join(stderr), capped, cutTail: !capped && !stopped && pending.length > 0, stopped };
    }),
  );
};

/** `env:NAME` or `keychain:service/account`. The value is used for transport only and never stored. */
export const secret = (ref: string): Effect.Effect<Redacted.Redacted<string> | null, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    if (ref.startsWith("env:")) {
      const value = process.env[ref.slice(4)];
      return value ? Redacted.make(value) : null;
    }
    const m = /^keychain:([^/]+)\/(.+)$/.exec(ref);
    if (!m) return null;
    const r = yield* run("security", ["find-generic-password", "-s", m[1]!, "-a", m[2]!, "-w"], { timeoutMs: 10_000 });
    const value = r.code === 0 ? r.stdout.trim() : "";
    return value ? Redacted.make(value) : null;
  });

/** A private scratch folder named for this process, so a later start can tell an orphan from a live one. */
export const scratch = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ prefix: `${prefix}${process.pid}-` });
  }).pipe(Effect.orDie);

/** At start: remove the scratch of processes that no longer run (a killed verify, demo, trial or calibration). */
export const sweep = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { tmpdir } = yield* Effect.sync(() => process.getBuiltinModule("node:os"));
  const dir = tmpdir();
  for (const n of yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))) {
    const pid = Number(/^(?:overwatch-(?:demo|trial)|ow-(?:verify|fix|pr|calibration|calibration-work))-(\d+)-/.exec(n)?.[1] ?? 0);
    if (!pid || pid === process.pid) continue;
    const gone = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    if (gone) yield* fs.remove(path.join(dir, n), { recursive: true, force: true }).pipe(Effect.ignore);
  }
});
