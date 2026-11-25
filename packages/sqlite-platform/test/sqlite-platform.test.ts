import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  EvidenceId,
  GLOBAL_VIEW_KEY,
  Incident,
  IncidentId,
  NowView,
  OpenCodeExternal,
  OpenIncident,
  OverwatchHandlersLive,
  OverwatchModel,
} from "@overwatch/domain";
import { makeDemoGitHubLayer, SilentNotifierLive } from "@overwatch/connectors";
import { makeSqlitePlatformLayer } from "../src/index.ts";

const DummyOpenCodeLayer = OpenCodeExternal.toLayer(
  Effect.succeed({
    createSession: ({ sessionId }) =>
      Effect.succeed({ sessionId, serviceUrl: "http://127.0.0.1:4096" }),
    promptSession: () => Effect.succeed({ accepted: true }),
    replyPermission: () => Effect.succeed({ replied: true }),
    createWorktree: ({ directory, branch }) => Effect.succeed({ directory, branch }),
    interruptSession: () => Effect.succeed({ interrupted: true }),
  }),
);

describe("SqlitePlatform (Zero-Postgres Alchemy Domain Host on bun:sqlite WAL)", () => {
  test("Persists aggregate events and view state across full SQLite reopen and dedupes commandId", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overwatch-sqlite-test-"));
    const dbPath = path.join(tmpDir, "overwatch.sqlite");

    try {
      const incidentId = "inc-persist-1" as IncidentId;

      // Boot #1: open incident and send duplicate commandId
      const boot1 = makeSqlitePlatformLayer({ dbPath });
      const externals = Layer.mergeAll(
        DummyOpenCodeLayer,
        makeDemoGitHubLayer(),
        SilentNotifierLive,
      );
      const modelLayer1 = OverwatchModel.layer(OverwatchHandlersLive).pipe(
        Layer.provide(externals),
        Layer.provide(boot1.layer),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const incidents = yield* Incident;
          const nowView = yield* NowView;

          const cmd = new OpenIncident({
            appId: "checkout-api",
            envId: "prod",
            headline: "checkout-api prod p95 jumped 0.9s -> 2.1s",
            severity: "page",
            signal: {
              signalId: "sig-p1",
              watchRuleId: "rule-p95",
              fingerprint: "fp-persist",
              summary: "p95 > 1200ms",
              severity: "page",
              evidenceId: "ev_persist_1" as EvidenceId,
              observedAtMs: Date.now(),
            },
          });

          const r1 = yield* incidents.send(incidentId, cmd, { commandId: "cmd-open-1" });
          const r2 = yield* incidents.send(incidentId, cmd, { commandId: "cmd-open-1" });
          expect(r1.version).toBe(1);
          expect(r2.version).toBe(1); // commandId deduped!

          const nowOpt = yield* nowView.get(GLOBAL_VIEW_KEY, {
            atLeast: r1,
            timeout: "10 seconds",
          });
          expect(Option.isSome(nowOpt)).toBe(true);
          if (Option.isSome(nowOpt)) {
            expect(nowOpt.value.incidents[incidentId]?.headline).toBe(
              "checkout-api prod p95 jumped 0.9s -> 2.1s",
            );
          }
        }).pipe(Effect.provide(modelLayer1)),
      );
      await Effect.runPromise(boot1.close);

      // Boot #2: completely fresh process/host instance against same SQLite file!
      const boot2 = makeSqlitePlatformLayer({ dbPath });
      const modelLayer2 = OverwatchModel.layer(OverwatchHandlersLive).pipe(
        Layer.provide(externals),
        Layer.provide(boot2.layer),
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const nowView = yield* NowView;
          const nowOpt = yield* nowView.get(GLOBAL_VIEW_KEY);
          expect(Option.isSome(nowOpt)).toBe(true);
          if (Option.isSome(nowOpt)) {
            expect(nowOpt.value.incidents[incidentId]?.headline).toBe(
              "checkout-api prod p95 jumped 0.9s -> 2.1s",
            );
            expect(nowOpt.value.incidents[incidentId]?.status).toBe("investigating");
          }
        }).pipe(Effect.provide(modelLayer2)),
      );
      await Effect.runPromise(boot2.close);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
