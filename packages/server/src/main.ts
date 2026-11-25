import * as os from "node:os";
import * as path from "node:path";
import config from "../../../overwatch.config.ts";
import { startOverwatchDaemon } from "./daemon.ts";

const host = process.env.OVERWATCH_HOST ?? "127.0.0.1";
const port = Number(process.env.OVERWATCH_PORT ?? "4720");
const dbPath =
  process.env.OVERWATCH_DB ??
  path.join(os.homedir(), ".local", "share", "overwatch", "overwatch.sqlite");

const daemon = await startOverwatchDaemon({
  config,
  dbPath,
  host,
  port,
});

console.info(`Overwatch daemon listening on ${daemon.url} (mode=${config.mode ?? "demo"}, db=${dbPath})`);

const shutdown = async () => {
  console.info("Shutting down Overwatch daemon...");
  await daemon.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
