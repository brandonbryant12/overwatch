import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class ExternalCallFailed extends Domain.Rejection("ExternalCallFailed", {
  system: Schema.String,
  operation: Schema.String,
  reason: Schema.String,
}) {}

/**
 * OpenCode 2 shared service boundary (wrapped around `@opencode/client` promise/mcp APIs
 * so Effect 4.1.4 and @opencode/client's internal 4.1.0 never collide).
 */
export class OpenCodeExternal extends Domain.ExternalSystem("OpenCode", {
  createSession: {
    args: {
      sessionId: Schema.String,
      agent: Schema.String,
      directory: Schema.String,
      title: Schema.String,
      permissions: Schema.Array(
        Schema.Struct({
          action: Schema.String,
          resource: Schema.String,
          effect: Schema.Literals(["allow", "deny", "ask"]),
        }),
      ),
    },
    success: {
      sessionId: Schema.String,
      serviceUrl: Schema.String,
    },
    error: ExternalCallFailed,
  },
  promptSession: {
    args: {
      sessionId: Schema.String,
      text: Schema.String,
      delivery: Schema.Literals(["queue", "steer"]),
    },
    success: {
      accepted: Schema.Boolean,
    },
    error: ExternalCallFailed,
  },
  replyPermission: {
    args: {
      sessionId: Schema.String,
      requestId: Schema.String,
      decision: Schema.Literals(["once", "always", "reject"]),
    },
    success: {
      replied: Schema.Boolean,
    },
    error: ExternalCallFailed,
  },
  createWorktree: {
    args: {
      repoPath: Schema.String,
      branch: Schema.String,
      directory: Schema.String,
      baseRef: Schema.String,
    },
    success: {
      directory: Schema.String,
      branch: Schema.String,
    },
    error: ExternalCallFailed,
  },
  interruptSession: {
    args: {
      sessionId: Schema.String,
    },
    success: {
      interrupted: Schema.Boolean,
    },
    error: ExternalCallFailed,
  },
}) {}

/**
 * GitHub outward side-effect boundary with idempotent marker reconciliation.
 */
export class GitHubExternal extends Domain.ExternalSystem("GitHub", {
  findExistingArtifact: {
    args: {
      repo: Schema.String,
      actionId: Schema.String,
      kind: Schema.Literals(["create_github_issue", "open_draft_pr"]),
      branch: Schema.optional(Schema.String),
    },
    success: {
      found: Schema.Boolean,
      url: Schema.optional(Schema.String),
      number: Schema.optional(Schema.Number),
    },
    error: ExternalCallFailed,
  },
  createIssue: {
    args: {
      repo: Schema.String,
      actionId: Schema.String,
      title: Schema.String,
      body: Schema.String,
      labels: Schema.Array(Schema.String),
    },
    success: {
      url: Schema.String,
      number: Schema.Number,
    },
    error: ExternalCallFailed,
  },
  pushAndOpenDraftPr: {
    args: {
      repo: Schema.String,
      actionId: Schema.String,
      worktreePath: Schema.String,
      branch: Schema.String,
      baseBranch: Schema.String,
      title: Schema.String,
      body: Schema.String,
    },
    success: {
      url: Schema.String,
      number: Schema.Number,
    },
    error: ExternalCallFailed,
  },
}) {}

/**
 * Local macOS / Email / Webhook notification boundary (swappable per Effect Layer).
 */
export class NotifierExternal extends Domain.ExternalSystem("Notifier", {
  notifyOperator: {
    args: {
      title: Schema.String,
      subtitle: Schema.String,
      body: Schema.String,
      urgency: Schema.Literals(["page", "warn", "info"]),
    },
    success: {
      delivered: Schema.Boolean,
    },
    error: ExternalCallFailed,
  },
  sendBriefEmail: {
    args: {
      briefId: Schema.String,
      kind: Schema.String,
      recipients: Schema.Array(Schema.String),
      subject: Schema.String,
      markdownBody: Schema.String,
    },
    success: {
      messageId: Schema.String,
    },
    error: ExternalCallFailed,
  },
}) {}
