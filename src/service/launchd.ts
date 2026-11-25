/**
 * Keeping the service running with launchd: a per-user agent that starts it at login and restarts it if it dies.
 *
 * launchd starts programs with a bare environment: no shell PATH, none of the variables a terminal has, no
 * interactive login. Install records the PATH it was run with and the absolute paths of the tools the service needs,
 * so `kubectl` (and its login helper), `git` and `gh` resolve the same way they do in the terminal it was installed
 * from. Secrets are not copied: they come from the keychain or the environment at run time.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const LABEL = "dev.overwatch.service";

export interface PlistInput {
  readonly node: string;
  readonly main: string;
  readonly config: string;
  readonly logDir: string;
  readonly path: string;
  readonly home: string;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(input: PlistInput): string {
  const args = [input.node, "--experimental-strip-types", "--no-warnings", input.main, "serve", "--config", input.config];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escape(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(input.path)}</string>
    <key>HOME</key>
    <string>${escape(input.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escape(join(input.logDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(join(input.logDir, "service.log"))}</string>
</dict>
</plist>
`;
}

/** Where a tool resolves on this PATH, or undefined. */
export function which(tool: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) {
    const candidate = join(dir, tool);
    if (dir && existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface InstallOptions {
  /** The LaunchAgents directory. Tests pass a temporary one. */
  readonly agentsDir?: string;
  readonly config: string;
  readonly logDir: string;
  readonly main: string;
  readonly node?: string;
  readonly path?: string;
  /** Load the agent with launchctl. Off in tests. */
  readonly load?: boolean;
  readonly run?: (command: string, args: string[]) => void;
}

export interface InstallResult {
  readonly plistPath: string;
  readonly tools: Record<string, string | undefined>;
  readonly loaded: boolean;
}

const defaultRun = (command: string, args: string[]) => void execFileSync(command, args, { stdio: "inherit" });

export function install(options: InstallOptions): InstallResult {
  const agentsDir = options.agentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const path = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
  const tools = Object.fromEntries(["kubectl", "git", "gh", "security"].map((tool) => [tool, which(tool, path)]));
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(options.logDir, { recursive: true });
  const plistPath = join(agentsDir, `${LABEL}.plist`);
  writeFileSync(plistPath, plist({ node: options.node ?? process.execPath, main: options.main, config: options.config, logDir: options.logDir, path, home: homedir() }));
  if (options.load) {
    const run = options.run ?? defaultRun;
    const domain = `gui/${process.getuid?.() ?? 501}`;
    try {
      run("launchctl", ["bootout", `${domain}/${LABEL}`]);
    } catch {
      // Not loaded yet.
    }
    run("launchctl", ["bootstrap", domain, plistPath]);
  }
  return { plistPath, tools, loaded: options.load === true };
}

export function uninstall(options: { readonly agentsDir?: string; readonly unload?: boolean; readonly run?: (command: string, args: string[]) => void }) {
  const agentsDir = options.agentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${LABEL}.plist`);
  if (options.unload) {
    try {
      (options.run ?? defaultRun)("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    } catch {
      // Not loaded.
    }
  }
  rmSync(plistPath, { force: true });
  return { plistPath };
}
