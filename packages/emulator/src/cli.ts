import { startOverwatchEmulatorStack } from "./index.ts";

const basePort = Number(process.env.OVERWATCH_EMULATOR_PORT ?? "4810");
const stack = await startOverwatchEmulatorStack({ basePort });

console.info("Overwatch Stateful Emulator Stack (powered by vercel-labs/emulate) is running:");
console.info(`  Kubernetes API : ${stack.kubernetesUrl}`);
console.info(`  Datadog API    : ${stack.datadogUrl}`);
console.info(`  Jenkins API    : ${stack.jenkinsUrl}`);
console.info(`  GitHub API     : ${stack.githubUrl} (token: ${stack.githubToken})`);

const shutdown = async () => {
  await stack.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
