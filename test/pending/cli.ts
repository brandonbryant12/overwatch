import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tempDir } from "../fixtures/support.ts";
const exec = promisify(execFile);
export const root = resolve(".");
export function laptop(extra: Record<string, unknown> = {}) {
  const home = tempDir("pending-laptop");
  const config = join(home, "overwatch.json");
  const local = join(home, "local");
  mkdirSync(local, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    KUBECONFIG: join(home, "kubeconfig"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    NO_PROXY: "127.0.0.1,localhost",
  };
  writeFileSync(
    config,
    JSON.stringify({
      apps: {
        "shop-api": {
          checkout: home,
          environments: {
            production: { sources: { pods: { type: "kubernetes", context: "prod", namespace: "shop", selector: "app=shop" } } },
          },
        },
      },
      watchers: [{ app: "shop-api", environment: "production" }],
      dataDir: join(home, "overwatch-data"),
      localDir: local,
      notify: false,
      ...extra,
    }),
  );
  const run = async (args: readonly string[]) => {
    try {
      const r = await exec(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", join(root, "src/service/main.ts"), ...args, "--config", config],
        { cwd: home, env, timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      if (typeof e.code !== "number" || e.killed) throw error;
      return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };
  return { home, env, config, local, run };
}
