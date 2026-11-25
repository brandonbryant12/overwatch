import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { SecretRef } from "@overwatch/domain";

export class SecretResolutionError extends Error {
  readonly _tag = "SecretResolutionError";
  constructor(
    readonly ref: string,
    readonly reason: string,
  ) {
    super(`Failed to resolve secret reference "${ref}": ${reason}`);
  }
}

export interface SecretVaultService {
  readonly resolve: (ref: SecretRef) => Effect.Effect<Redacted.Redacted<string>, SecretResolutionError>;
  readonly probe: (ref: SecretRef) => Effect.Effect<{ readonly available: boolean; readonly source: "keychain" | "env" }>;
}

export class SecretVault extends Context.Service<SecretVault, SecretVaultService>()(
  "Overwatch/SecretVault",
) {}

/**
 * Resolves `env:VAR_NAME` from process.env and `keychain:service/account` via macOS `security`.
 * Returns `Redacted<string>` so raw values never serialize into logs, SQLite, UI state, or prompts.
 */
export const LocalSecretVaultLive = Layer.succeed(SecretVault, {
  resolve: (ref) =>
    Effect.tryPromise({
      try: async () => {
        if (ref.startsWith("env:")) {
          const envVar = ref.slice("env:".length);
          const value = process.env[envVar];
          if (!value) {
            throw new SecretResolutionError(ref, `Environment variable ${envVar} is unset`);
          }
          return Redacted.make(value);
        }
        if (ref.startsWith("keychain:")) {
          const rest = ref.slice("keychain:".length);
          const slash = rest.indexOf("/");
          const service = slash >= 0 ? rest.slice(0, slash) : "overwatch";
          const account = slash >= 0 ? rest.slice(slash + 1) : rest;
          const proc = Bun.spawn(
            ["security", "find-generic-password", "-s", service, "-a", account, "-w"],
            { stdout: "pipe", stderr: "pipe" },
          );
          const code = await proc.exited;
          if (code !== 0) {
            const stderr = (await new Response(proc.stderr).text()).trim();
            throw new SecretResolutionError(
              ref,
              stderr || `Keychain entry ${service}/${account} not found`,
            );
          }
          const secret = (await new Response(proc.stdout).text()).trim();
          return Redacted.make(secret);
        }
        throw new SecretResolutionError(ref, "Unsupported secret scheme");
      },
      catch: (e) =>
        e instanceof SecretResolutionError
          ? e
          : new SecretResolutionError(ref, e instanceof Error ? e.message : String(e)),
    }),
  probe: (ref) =>
    Effect.gen(function* () {
      const source: "keychain" | "env" = ref.startsWith("keychain:") ? "keychain" : "env";
      if (source === "env") {
        const envVar = ref.slice("env:".length);
        return { available: Boolean(process.env[envVar]), source };
      }
      const available = yield* Effect.tryPromise({
        try: async () => {
          const rest = ref.slice("keychain:".length);
          const slash = rest.indexOf("/");
          const service = slash >= 0 ? rest.slice(0, slash) : "overwatch";
          const account = slash >= 0 ? rest.slice(slash + 1) : rest;
          const proc = Bun.spawn(
            ["security", "find-generic-password", "-s", service, "-a", account],
            { stdout: "ignore", stderr: "ignore" },
          );
          return (await proc.exited) === 0;
        },
        catch: () => false,
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      return { available, source };
    }),
});

/**
 * Env-only SecretVault Layer for headless Linux/container deployments.
 */
export const EnvSecretVaultLive = Layer.succeed(SecretVault, {
  resolve: (ref) =>
    Effect.try({
      try: () => {
        const key = ref.startsWith("env:")
          ? ref.slice("env:".length)
          : ref.replace(/^keychain:/, "OVERWATCH_SECRET_").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
        const val = process.env[key];
        if (!val) throw new SecretResolutionError(ref, `Environment variable ${key} is unset`);
        return Redacted.make(val);
      },
      catch: (e) =>
        e instanceof SecretResolutionError
          ? e
          : new SecretResolutionError(ref, e instanceof Error ? e.message : String(e)),
    }),
  probe: (ref) =>
    Effect.succeed({
      available: Boolean(
        process.env[
          ref.startsWith("env:")
            ? ref.slice("env:".length)
            : ref.replace(/^keychain:/, "OVERWATCH_SECRET_").replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()
        ],
      ),
      source: "env" as const,
    }),
});
