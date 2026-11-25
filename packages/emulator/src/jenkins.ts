import { defineEmulator } from "emulate";

export interface EmulatedJenkinsBuild {
  number: number;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE";
  timestamp: number;
  duration: number;
  commitSha: string;
  commitMessage: string;
  author: string;
  consoleText: string;
}

export interface JenkinsEmulatorState {
  builds: EmulatedJenkinsBuild[];
}

export function initialJenkinsState(): JenkinsEmulatorState {
  const now = Date.now();
  return {
    builds: [
      {
        number: 482,
        result: "SUCCESS",
        timestamp: now - 14 * 60_000,
        duration: 184_000,
        commitSha: "9f31c2a7b4d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5",
        commitMessage: "feat(promos): evaluate tiered bundle discounts per cart item",
        author: "m.patel",
        consoleText:
          "[Jenkins] Build #482 Checkout 9f31c2a\n[Jenkins] bun test -> PASS\n[Jenkins] Deploying image registry.local/checkout-api:9f31c2a to eks-prod-us-east-1/checkout\n[Jenkins] Finished: SUCCESS",
      },
      {
        number: 481,
        result: "SUCCESS",
        timestamp: now - 6 * 3600_000,
        duration: 171_000,
        commitSha: "4c88e1b0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        commitMessage: "chore(metrics): emit replica revision label on checkout spans",
        author: "b.bryant",
        consoleText: "[Jenkins] Build #481 Finished: SUCCESS",
      },
    ],
  };
}

/**
 * Stateful Jenkins Pipeline Emulator built on `vercel-labs/emulate`.
 * Matches real Jenkins `/api/json?tree=...` shape consumed by `@overwatch/connectors`!
 */
export const jenkinsEmulator = defineEmulator<JenkinsEmulatorState>({
  name: "overwatch-jenkins",
  stateVersion: 1,
  state: initialJenkinsState,
  setup({ app, state, baseUrl }) {
    app.get("/job/:team/job/:app/job/:branch/api/json", (c) => {
      const team = c.req.param("team");
      const appName = c.req.param("app");
      const branch = c.req.param("branch");
      return c.json({
        name: branch,
        builds: state.builds.map((b) => ({
          number: b.number,
          result: b.result,
          timestamp: b.timestamp,
          duration: b.duration,
          url: `${baseUrl}/job/${team}/job/${appName}/job/${branch}/${b.number}`,
          actions: [{ lastBuiltRevision: { SHA1: b.commitSha } }],
          changeSets: [{ items: [{ msg: b.commitMessage, author: { fullName: b.author } }] }],
        })),
      });
    });

    app.get("/job/:team/job/:app/job/:branch/:buildNumber/consoleText", (c) => {
      const num = Number(c.req.param("buildNumber"));
      const b = state.builds.find((x) => x.number === num);
      if (!b) return c.text("Build not found", 404);
      return c.text(b.consoleText);
    });

    app.post("/overwatch-control/trigger-build", async (c) => {
      const body = (await c.req.json()) as {
        commitSha: string;
        commitMessage: string;
        author?: string;
        result?: "SUCCESS" | "FAILURE";
      };
      const nextNum = (state.builds[0]?.number ?? 482) + 1;
      const build: EmulatedJenkinsBuild = {
        number: nextNum,
        result: body.result ?? "SUCCESS",
        timestamp: Date.now(),
        duration: 148_000,
        commitSha: body.commitSha,
        commitMessage: body.commitMessage,
        author: body.author ?? "overwatch-fixer",
        consoleText: `[Jenkins] Build #${nextNum} (${body.commitSha.slice(0, 7)})\n[Jenkins] ${body.commitMessage}\n[Jenkins] bun test -> PASS\n[Jenkins] Deployed to eks-prod-us-east-1/checkout\n[Jenkins] Finished: ${body.result ?? "SUCCESS"}`,
      };
      state.builds.unshift(build);
      return c.json({ ok: true, buildNumber: nextNum, commitSha: build.commitSha });
    });
  },
});
