/**
 * Automation Grant (design plan §10).
 *
 * A grant lets an orchestrating agent open further runs inside a task the
 * author already sent by hand. It is the one place where something other than
 * a click causes a model call, so its limits are the interesting part:
 *
 *   - it binds to one task and one session, and does not survive either
 *     changing;
 *   - it names the agents that may run, and refuses the rest;
 *   - it can be unlimited, and says so as `null` rather than as a large
 *     number that pretends to be a limit;
 *   - it can be revoked, and revocation is recorded rather than deleting the
 *     evidence that it once existed.
 *
 * What it can never do is merge anything. There is no field here for accepting
 * a proposal, and a test asserts that absence — because the guarantee this
 * application makes is that no configuration reaches the manuscript without a
 * human click, and a grant is exactly where such a configuration would hide.
 */

export interface Grant {
  readonly id: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly sessionId: string;
  /** null means the author declined to set a ceiling, which is their right. */
  readonly maxRuns: number | null;
  readonly allowedAgentIds: readonly string[];
  readonly spent: readonly string[];
  readonly remaining: number | null;
  readonly issuedAt: string;
  readonly revokedAt?: string;
}

export type GrantRefusal =
  | "revoked"
  | "wrong-task"
  | "session-changed"
  | "agent-not-granted"
  | "exhausted";

export type GrantVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GrantRefusal };

export interface GrantRequest {
  readonly agentId: string;
  readonly taskId: string;
  readonly sessionId?: string;
}

let sequence = 0;

export const issueGrant = (spec: {
  taskId: string;
  agentId: string;
  sessionId: string;
  maxRuns: number | null;
  allowedAgentIds: readonly string[];
}): Grant => ({
  id: `grant${++sequence}`,
  taskId: spec.taskId,
  agentId: spec.agentId,
  sessionId: spec.sessionId,
  maxRuns: spec.maxRuns,
  allowedAgentIds: [...spec.allowedAgentIds],
  spent: [],
  remaining: spec.maxRuns,
  issuedAt: new Date().toISOString(),
});

export const grantAllows = (grant: Grant, request: GrantRequest): GrantVerdict => {
  if (grant.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  if (request.taskId !== grant.taskId) return { ok: false, reason: "wrong-task" };
  if (request.sessionId !== undefined && request.sessionId !== grant.sessionId)
    return { ok: false, reason: "session-changed" };
  if (!grant.allowedAgentIds.includes(request.agentId))
    return { ok: false, reason: "agent-not-granted" };
  if (grant.remaining !== null && grant.remaining <= 0) return { ok: false, reason: "exhausted" };
  return { ok: true };
};

/** Idempotent by run id: a retry must not consume a second unit of the budget. */
export const spendGrant = (grant: Grant, runId: string): Grant => {
  if (grant.spent.includes(runId)) return grant;
  return {
    ...grant,
    spent: [...grant.spent, runId],
    remaining: grant.remaining === null ? null : grant.remaining - 1,
  };
};

export const revokeGrant = (grant: Grant): Grant => ({
  ...grant,
  revokedAt: new Date().toISOString(),
});
