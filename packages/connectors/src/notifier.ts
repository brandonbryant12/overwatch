import { NotifierExternal } from "@overwatch/domain";
import * as Effect from "effect/Effect";

function escapeAppleScript(str: string): string {
  return str.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * macOS native User Notification + local brief outbox log.
 */
export const MacOsNotifierLive = NotifierExternal.toLayer(
  Effect.succeed({
    notifyOperator: ({ title, subtitle, body }) =>
      Effect.tryPromise({
        try: async () => {
          if (process.platform === "darwin" && process.env.OVERWATCH_SILENT_NOTIFY !== "1") {
            const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(subtitle)}"`;
            const proc = Bun.spawn(["osascript", "-e", script], {
              stdout: "ignore",
              stderr: "ignore",
            });
            await proc.exited;
          }
          return { delivered: true };
        },
        catch: () => ({ delivered: false }),
      }).pipe(Effect.catch(() => Effect.succeed({ delivered: false }))),

    sendBriefEmail: ({ briefId, subject, recipients }) =>
      Effect.sync(() => {
        const messageId = `msg_${briefId}_${Date.now()}`;
        console.info(
          `[Overwatch Notifier] Queued brief "${subject}" to ${recipients.join(", ")} (${messageId})`,
        );
        return { messageId };
      }),
  }),
);

/**
 * Silent headless notifier Layer (for CI, tests, and server deployments).
 */
export const SilentNotifierLive = NotifierExternal.toLayer(
  Effect.succeed({
    notifyOperator: () => Effect.succeed({ delivered: true }),
    sendBriefEmail: ({ briefId }) =>
      Effect.succeed({ messageId: `msg_${briefId}_headless` }),
  }),
);
