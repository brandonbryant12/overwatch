/**
 * The service's configuration file. JSON (comments allowed), read once at start. Apps, environments, sources and
 * watchers are parsed by `src/collect/options.ts`; this adds where the service listens and how it reaches OpenCode.
 * Nothing has an environment-specific default.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseOptions, type Options } from "../collect/options.ts";
import { validateSources } from "../collect/runtime.ts";

export interface ServiceConfig {
  readonly file: string | undefined;
  readonly options: Options;
  readonly errors: ReadonlyArray<string>;
  readonly port: number;
  /** Where the database, backups, worktrees and logs live. */
  readonly dataDir: string;
  readonly opencode: {
    /** A fixed server URL. Without it the service finds the local OpenCode server the way the OpenCode client does. */
    readonly url?: string;
    readonly username?: string;
    /** A secret reference: `env:NAME` or `keychain:service/account`. */
    readonly password?: string;
    /** Start an investigation for every new incident. */
    readonly autoInvestigate: boolean;
    /** How long a run may go without a finding before it is given up. */
    readonly runTimeoutMs: number;
  };
}

export const DEFAULT_PORT = 7450;

/** Strips `//` and `/* *\/` comments outside strings, so the file can carry notes. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out;
}

export const defaultConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "overwatch", "config.json");

export function parseConfig(raw: unknown, file?: string): ServiceConfig {
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { service, opencode, ...rest } = input as { service?: Record<string, unknown>; opencode?: Record<string, unknown> };
  const parsed = parseOptions(rest, file ? dirname(file) : undefined);
  const errors = [...parsed.errors, ...validateSources(parsed.options)];
  const port = service?.port === undefined ? DEFAULT_PORT : Number(service.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) errors.push("service.port must be a port number");
  const oc = opencode ?? {};
  const str = (key: string) => (typeof oc[key] === "string" ? (oc[key] as string) : undefined);
  const password = str("password");
  if (password !== undefined && !/^(env|keychain):.+/.test(password)) errors.push('opencode.password must be "env:NAME" or "keychain:service/account"');
  const runTimeout = typeof oc.runTimeoutMinutes === "number" ? oc.runTimeoutMinutes : 20;
  return {
    file,
    options: parsed.options,
    errors,
    port,
    dataDir: parsed.options.dataDir,
    opencode: {
      ...(str("url") ? { url: str("url")!.replace(/\/+$/, "") } : {}),
      ...(str("username") ? { username: str("username")! } : {}),
      ...(password ? { password } : {}),
      autoInvestigate: oc.autoInvestigate !== false,
      runTimeoutMs: runTimeout * 60_000,
    },
  };
}

export function loadConfig(file = defaultConfigPath()): ServiceConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the configuration file ${file}: ${(error as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw, file);
}
