#!/usr/bin/env node
/**
 * The `overwatch` command.
 *
 *   overwatch serve [--config <file>]             run the service in the foreground
 *   overwatch status [--config <file>]            what the running service reports
 *   overwatch check [--config <file>]             validate the configuration
 *   overwatch backup <file> [--config <file>]     a consistent copy of the database, safe while it runs
 *   overwatch restore <file> [--config <file>]    replace the database with a backup (service stopped)
 *   overwatch rebuild-search [--config <file>]    rebuild the search index from the journal at next start
 *   overwatch launchd install|uninstall|print [--config <file>] [--agents-dir <dir>] [--no-load]
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { install, plist, uninstall } from "./launchd.ts";
import { startService } from "./service.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const configPath = flag("--config") ?? defaultConfigPath();
const command = args[0] ?? "help";
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));

const dbFile = () => join(loadConfig(configPath).dataDir, "overwatch.sqlite");
const running = async () => {
  const config = loadConfig(configPath);
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

async function main() {
  switch (command) {
    case "serve": {
      const config = loadConfig(configPath);
      const service = await startService(config);
      const stop = async () => {
        await service.stop();
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      return;
    }
    case "check": {
      const config = loadConfig(configPath);
      if (config.errors.length) {
        console.error(`${configPath} has problems:\n- ${config.errors.join("\n- ")}`);
        process.exitCode = 1;
      } else console.log(`${configPath} is valid: ${config.options.watchers.length} watcher(s), data in ${config.dataDir}`);
      return;
    }
    case "status": {
      const config = loadConfig(configPath);
      const response = await fetch(`http://127.0.0.1:${config.port}/status`).catch(() => undefined);
      if (!response) {
        console.error(`The service is not answering on port ${config.port}.`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await response.json(), null, 2));
      return;
    }
    case "backup": {
      const target = positional[1];
      if (!target) throw new Error("overwatch backup <file>");
      if (existsSync(target)) throw new Error(`${target} exists; choose a new file`);
      const db = new DatabaseSync(dbFile(), { readOnly: true });
      db.prepare("VACUUM INTO ?").run(target);
      db.close();
      console.log(`backed up to ${target}`);
      return;
    }
    case "restore": {
      const source = positional[1];
      if (!source || !existsSync(source)) throw new Error("overwatch restore <backup file>");
      if (await running()) throw new Error("Stop the service before restoring (overwatch launchd uninstall, or stop the terminal running it).");
      const file = dbFile();
      for (const suffix of ["-wal", "-shm"]) rmSync(file + suffix, { force: true });
      copyFileSync(source, file);
      console.log(`restored ${file} from ${source}`);
      return;
    }
    case "rebuild-search": {
      if (await running()) throw new Error("Stop the service first; the index is rebuilt when it starts.");
      const db = new DatabaseSync(dbFile());
      db.exec("DELETE FROM search_terms; DELETE FROM search_docs; DELETE FROM projections WHERE name = 'search';");
      db.close();
      console.log("search index cleared; it is rebuilt from the journal when the service starts");
      return;
    }
    case "launchd": {
      const config = loadConfig(configPath);
      const main = fileURLToPath(import.meta.url);
      const agentsDir = flag("--agents-dir");
      const action = positional[1];
      if (action === "print") {
        console.log(plist({ node: process.execPath, main, config: configPath, logDir: join(config.dataDir, "logs"), path: process.env.PATH ?? "", home: process.env.HOME ?? "" }));
      } else if (action === "install") {
        const result = install({ ...(agentsDir ? { agentsDir } : {}), config: configPath, logDir: join(config.dataDir, "logs"), main, load: !args.includes("--no-load") });
        console.log(`wrote ${result.plistPath}${result.loaded ? " and loaded it" : " (not loaded)"}`);
        for (const [tool, path] of Object.entries(result.tools)) console.log(`  ${tool}: ${path ?? "NOT FOUND on this PATH"}`);
      } else if (action === "uninstall") {
        const result = uninstall({ ...(agentsDir ? { agentsDir } : {}), unload: !args.includes("--no-load") });
        console.log(`removed ${result.plistPath}`);
      } else throw new Error("overwatch launchd install|uninstall|print");
      return;
    }
    default:
      console.log(`usage: overwatch serve|status|check|backup|restore|rebuild-search|launchd [--config <file>] (default config: ${defaultConfigPath()})`);
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
