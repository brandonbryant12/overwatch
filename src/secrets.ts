import { exec as defaultExec, type Exec } from "./exec.ts";

/**
 * Resolves `env:NAME` from the environment and `keychain:service/account` from the macOS keychain.
 * Values are returned to the caller only; they are never stored, logged or put in a prompt.
 */
export async function resolveSecret(ref: string, run: Exec = defaultExec): Promise<string> {
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    const value = process.env[name];
    if (!value) throw new Error(`Environment variable ${name} is not set`);
    return value;
  }
  if (ref.startsWith("keychain:")) {
    const rest = ref.slice(9);
    const slash = rest.indexOf("/");
    if (slash <= 0) throw new Error(`Keychain reference must be keychain:service/account`);
    const result = await run(
      "security",
      ["find-generic-password", "-s", rest.slice(0, slash), "-a", rest.slice(slash + 1), "-w"],
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0) throw new Error(`Keychain entry ${rest} not found`);
    return result.stdout.trim();
  }
  throw new Error(`Unsupported secret reference; use env:NAME or keychain:service/account`);
}
