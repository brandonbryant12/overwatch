import type { JenkinsEnvConfigSchema } from "@overwatch/domain";
import type * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { redactText } from "./redactor.ts";
import { SecretVault } from "./secrets.ts";
import type { BuildRecord, ConnectorProbeResult } from "./types.ts";

export type JenkinsEnvConfig = typeof JenkinsEnvConfigSchema.Type;

export function collectJenkinsBuilds(
  config: JenkinsEnvConfig,
): Effect.Effect<
  { readonly probe: ConnectorProbeResult; readonly builds: ReadonlyArray<BuildRecord> },
  never,
  SecretVault
> {
  return Effect.gen(function* () {
    const vault = yield* SecretVault;
    const now = Date.now();
    const userRes = yield* Effect.result(vault.resolve(config.username));
    const tokRes = yield* Effect.result(vault.resolve(config.token));
    if (userRes._tag === "Failure" || tokRes._tag === "Failure") {
      return {
        probe: {
          connector: "jenkins" as const,
          coverage: "auth_expired" as const,
          detail: "Jenkins credentials unavailable in SecretVault",
          remediation: `Configure ${config.username} and ${config.token}.`,
          checkedAtMs: now,
        },
        builds: [],
      };
    }

    const authHeader = `Basic ${Buffer.from(
      `${Redacted.value(userRes.success)}:${Redacted.value(tokRes.success)}`,
    ).toString("base64")}`;

    const endpoint = `${config.baseUrl.replace(/\/$/, "")}/${config.jobPath.replace(/^\//, "")}/api/json?tree=builds[number,result,timestamp,duration,url,actions[lastBuiltRevision[SHA1]],changeSets[items[msg,author[fullName]]]]{0,8}`;

    const fetched = yield* Effect.tryPromise({
      try: async () => {
        const resp = await fetch(endpoint, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) return { status: resp.status, data: null as any };
        return { status: resp.status, data: (await resp.json()) as any };
      },
      catch: () => ({ status: -1, data: null as any }),
    }).pipe(Effect.catch(() => Effect.succeed({ status: -1, data: null as any })));

    if (fetched.status === 401 || fetched.status === 403) {
      return {
        probe: {
          connector: "jenkins" as const,
          coverage: "auth_expired" as const,
          detail: `Jenkins returned HTTP ${fetched.status}`,
          remediation: "Refresh Jenkins PAT in macOS Keychain.",
          checkedAtMs: now,
        },
        builds: [],
      };
    }
    if (fetched.status !== 200 || !fetched.data) {
      return {
        probe: {
          connector: "jenkins" as const,
          coverage: "unreachable" as const,
          detail: `Could not reach Jenkins at ${config.baseUrl}`,
          remediation: "Check VPN / internal DNS for Jenkins.",
          checkedAtMs: now,
        },
        builds: [],
      };
    }

    const builds: BuildRecord[] = ((fetched.data.builds ?? []) as Array<any>).map((b) => {
      const sha: string =
        b.actions?.find((a: any) => a?.lastBuiltRevision?.SHA1)?.lastBuiltRevision?.SHA1 ??
        "unknown";
      const changeItem = b.changeSets?.[0]?.items?.[0];
      return {
        buildNumber: Number(b.number),
        jobPath: config.jobPath,
        result: b.result ?? "IN_PROGRESS",
        commitSha: sha.slice(0, 7),
        commitMessage: redactText(String(changeItem?.msg ?? "Build triggered"), { maxBytes: 180 }),
        author: String(changeItem?.author?.fullName ?? "ci"),
        durationMs: Number(b.duration ?? 0),
        timestampMs: Number(b.timestamp ?? now),
        url: String(b.url ?? `${config.baseUrl}/${config.jobPath}/${b.number}`),
      };
    });

    return {
      probe: {
        connector: "jenkins" as const,
        coverage: "healthy" as const,
        detail: `Fetched ${builds.length} builds from ${config.jobPath}`,
        checkedAtMs: now,
      },
      builds,
    };
  });
}
