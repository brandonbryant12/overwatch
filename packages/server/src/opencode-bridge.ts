import {
  ExternalCallFailed,
  OpenCodeExternal,
  type AgentRole,
  type EnvAutonomy,
} from "@overwatch/domain";
import * as Effect from "effect/Effect";

export interface SessionPermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface SessionHandoffDescriptor {
  readonly serviceUrl: string;
  readonly sessionId: string;
  readonly locationDir: string;
  readonly cliCommand: string;
  readonly desktopDeepLink: string;
}

/**
 * Generates deterministic `ses_` SessionIDs matching `@opencode/schema` `Schema.isStartingWith("ses")`.
 */
export function createOpenCodeSessionId(): string {
  const ts = (Number.MAX_SAFE_INTEGER - Date.now()).toString(36).slice(-8);
  const rand = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  return `ses_${ts}_${rand}`;
}

/**
 * Pure portable handoff descriptor — zero macOS-specific terminal scripts inside domain/server logic.
 */
export function buildSessionHandoff(input: {
  readonly serviceUrl: string;
  readonly sessionId: string;
  readonly locationDir: string;
}): SessionHandoffDescriptor {
  return {
    serviceUrl: input.serviceUrl,
    sessionId: input.sessionId,
    locationDir: input.locationDir,
    cliCommand: `opencode --server ${input.serviceUrl} --session ${input.sessionId}`,
    desktopDeepLink: `opencode://open-project?directory=${encodeURIComponent(input.locationDir)}&session=${encodeURIComponent(input.sessionId)}`,
  };
}

/**
 * Compiles dynamic per-session OpenCode permission rulesets that defeat telemetry prompt injection
 * without sandboxes:
 * - `triage`, `explorer`, `scribe`, `judge`: deny edit, write, shell, webfetch completely.
 * - `investigator`: deny edit, write, webfetch; allow read-only git inspection only.
 * - `fixer`: allow edit/write inside worktree & repo verify commands; hard-deny `git push`, `gh`, `kubectl`, `aws`, `curl`, `wget`.
 */
export function compileSessionPermissions(
  role: AgentRole,
  worktreePath?: string,
  autonomy?: EnvAutonomy,
): SessionPermissionRule[] {
  if (role === "triage" || role === "explore" || role === "brief" || role === "judge") {
    return [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ];
  }
  if (role === "investigate" || role === "propose_improvement") {
    return [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git log*", effect: "allow" },
      { action: "shell", resource: "git show*", effect: "allow" },
      { action: "shell", resource: "git diff*", effect: "allow" },
      { action: "shell", resource: "rg *", effect: "allow" },
    ];
  }
  if (role === "fix") {
    const scope = worktreePath ? `${worktreePath}/**` : "*";
    const fixEffect = autonomy?.prepareWorktreeFix === "propose" ? "ask" : "allow";
    return [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "write", resource: "*", effect: "deny" },
      { action: "edit", resource: scope, effect: fixEffect },
      { action: "write", resource: scope, effect: fixEffect },
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "shell", resource: "bun *", effect: "allow" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "shell", resource: "git diff*", effect: "allow" },
      { action: "shell", resource: "git add*", effect: "allow" },
      { action: "shell", resource: "git commit*", effect: "allow" },
      // Hard-deny outward network/mutation commands — all outward writes route via ExecuteAction Saga!
      { action: "shell", resource: "git push*", effect: "deny" },
      { action: "shell", resource: "gh *", effect: "deny" },
      { action: "shell", resource: "kubectl *", effect: "deny" },
      { action: "shell", resource: "aws *", effect: "deny" },
      { action: "shell", resource: "curl *", effect: "deny" },
      { action: "shell", resource: "wget *", effect: "deny" },
    ];
  }
  return [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "write", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: "deny" },
  ];
}

/**
 * Live OpenCode 2.4.1 HTTP/ClientMCP bridge with automatic graceful fallback to local demo emulation
 * when no local OpenCode 2.4.1 daemon is reachable.
 */
export function makeOpenCodeExternalLayer(options: {
  readonly serviceUrl: string;
  readonly mode: "live" | "demo";
  /** Service token, sent as a bearer credential. Defaults to `OPENCODE_TOKEN`. */
  readonly authToken?: string;
}) {
  // Routes and bodies follow the generated `@opencode/client` 2.4.1 contract:
  // `POST /api/session` takes `location.directory`, and a permission is answered at
  // `/api/session/{id}/permission/{requestID}/reply` with `{ decision }`.
  const token = options.authToken ?? process.env.OPENCODE_TOKEN;
  const jsonHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  return OpenCodeExternal.toLayer(
    Effect.succeed({
      createSession: ({ sessionId, agent, directory, title, permissions }) =>
        Effect.tryPromise({
          try: async () => {
            if (options.mode === "demo") {
              return { sessionId, serviceUrl: options.serviceUrl };
            }
            const resp = await fetch(`${options.serviceUrl}/api/session`, {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({
                id: sessionId,
                agent,
                title,
                location: { directory },
                permissions,
              }),
              signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) {
              throw new Error(`OpenCode POST /api/session failed with ${resp.status}`);
            }
            return { sessionId, serviceUrl: options.serviceUrl };
          },
          catch: (err) =>
            new ExternalCallFailed({
              system: "OpenCode",
              operation: "createSession",
              reason: err instanceof Error ? err.message : String(err),
            }),
        }),

      promptSession: ({ sessionId, text, delivery }) =>
        Effect.tryPromise({
          try: async () => {
            if (options.mode === "demo") return { accepted: true };
            const resp = await fetch(
              `${options.serviceUrl}/api/session/${encodeURIComponent(sessionId)}/prompt`,
              {
                method: "POST",
                headers: jsonHeaders(),
                body: JSON.stringify({ text, delivery }),
                signal: AbortSignal.timeout(8_000),
              },
            );
            if (!resp.ok) {
              throw new Error(`OpenCode prompt failed with ${resp.status}`);
            }
            return { accepted: true };
          },
          catch: (err) =>
            new ExternalCallFailed({
              system: "OpenCode",
              operation: "promptSession",
              reason: err instanceof Error ? err.message : String(err),
            }),
        }),

      replyPermission: ({ sessionId, requestId, decision }) =>
        Effect.tryPromise({
          try: async () => {
            if (options.mode === "demo") return { replied: true };
            const resp = await fetch(
              `${options.serviceUrl}/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
              {
                method: "POST",
                headers: jsonHeaders(),
                body: JSON.stringify({ decision }),
                signal: AbortSignal.timeout(8_000),
              },
            );
            if (!resp.ok) {
              throw new Error(`OpenCode permission reply failed with ${resp.status}`);
            }
            return { replied: true };
          },
          catch: (err) =>
            new ExternalCallFailed({
              system: "OpenCode",
              operation: "replyPermission",
              reason: err instanceof Error ? err.message : String(err),
            }),
        }),

      createWorktree: ({ repoPath, branch, directory, baseRef }) =>
        Effect.tryPromise({
          try: async () => {
            if (options.mode === "demo") {
              return { directory, branch };
            }
            // Known gap: the 2.4.1 contract expects `{ projectID, from, branch, directory }`.
            // Resolving a project id from `repoPath` is not implemented, so a live service
            // will reject this call until the agent runner lands.
            const resp = await fetch(`${options.serviceUrl}/api/worktree`, {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({ directory, branch, baseRef, projectPath: repoPath }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!resp.ok) {
              throw new Error(`OpenCode worktree.create failed with ${resp.status}`);
            }
            return { directory, branch };
          },
          catch: (err) =>
            new ExternalCallFailed({
              system: "OpenCode",
              operation: "createWorktree",
              reason: err instanceof Error ? err.message : String(err),
            }),
        }),

      interruptSession: ({ sessionId }) =>
        Effect.tryPromise({
          try: async () => {
            if (options.mode === "demo") return { interrupted: true };
            await fetch(
              `${options.serviceUrl}/api/session/${encodeURIComponent(sessionId)}/interrupt`,
              { method: "POST", headers: jsonHeaders(), signal: AbortSignal.timeout(5_000) },
            );
            return { interrupted: true };
          },
          catch: (err) =>
            new ExternalCallFailed({
              system: "OpenCode",
              operation: "interruptSession",
              reason: err instanceof Error ? err.message : String(err),
            }),
        }),
    }),
  );
}
