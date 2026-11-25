import * as os from "node:os";
import * as path from "node:path";
import config from "../../../overwatch.config.ts";
import { startOverwatchDaemon } from "./daemon.ts";

const mode = config.mode ?? "demo";
const host = process.env.OVERWATCH_HOST ?? "127.0.0.1";
const port = Number(process.env.OVERWATCH_PORT ?? "4720");
// Demo and live state never share a file: demo incidents must not show up beside real ones.
const dbPath =
  process.env.OVERWATCH_DB ??
  path.join(os.homedir(), ".local", "share", "overwatch", `overwatch-${mode}.sqlite`);
const cadenceEnv = Number(process.env.OVERWATCH_CADENCE_SECONDS);
// The demo collects every 10 seconds so a simulated regression is detected while you watch.
const cadenceOverrideSeconds =
  Number.isFinite(cadenceEnv) && cadenceEnv > 0 ? cadenceEnv : mode === "demo" ? 10 : undefined;

const daemon = await startOverwatchDaemon({
  config,
  dbPath,
  host,
  port,
  cadenceOverrideSeconds,
  silentNotifications: process.env.OVERWATCH_SILENT_NOTIFY === "1",
  allowedHosts: (process.env.OVERWATCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
});

console.info(`Overwatch daemon listening on ${daemon.url} (mode=${mode}, db=${dbPath})`);

const shutdown = async () => {
  console.info("Shutting down Overwatch daemon...");
  await daemon.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
