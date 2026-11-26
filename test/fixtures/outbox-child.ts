import { testService, watcher } from "./scenario.ts";

const [directory, point, epoch, count] = process.argv.slice(2);
const boundaries = {
  checkpoint: "BEFORE INSERT ON checkpoints",
  intent: "AFTER INSERT ON pending_reports",
  event: "AFTER INSERT ON journal WHEN NEW.type='IncidentOpened'",
  acknowledgement: "BEFORE DELETE ON pending_reports",
} as const;
if (!directory || !point || !(point in boundaries)) throw Error("Missing fixture arguments");
const f = await testService({ dataDir: directory });
for (let i = 0; i < Number(count); i++) f.cluster.log(Number(epoch) + i, "ERROR payment " + (42 + i) + " timed out after 300ms");
await f.service.atomically((db) => {
  db.function("fixture_power_loss", () => {
    process.kill(process.pid, "SIGKILL");
    return 0;
  });
  db.exec("CREATE TEMP TRIGGER fixture_cut " + boundaries[point as keyof typeof boundaries] + " BEGIN SELECT fixture_power_loss(); END");
});
await f.service.collect(watcher);
throw Error("The test fixture failed to reach its requested kill point");
