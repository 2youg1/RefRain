import type { Proposal } from "@refrain/core";
import type { Agent, ReviewTask } from "./types.ts";

/**
 * Asking several agents the same question (design plan §8.1).
 *
 * Competing readings are the point, not a conflict to be avoided: when two
 * agents rewrite the same paragraph the author wants both in front of them.
 * Overlapping Edit Scopes therefore do not block a parallel run — they only
 * block a *merge*, which the Decision Batch already refuses on overlap.
 *
 * One broadcast is one Round. Every task in it shares a baseline, so the
 * results are comparable; each carries its own identifier, so the runs stay
 * independent; and choosing one deletes none of the others, because a reading
 * the author refused is still evidence about the passage.
 */

export interface Round {
  readonly id: string;
  readonly agentIds: readonly string[];
  readonly tasks: readonly ReviewTask[];
  readonly askedAt: string;
}

let sequence = 0;

export const broadcast = (request: ReviewTask, agents: readonly Agent[]): Round => {
  const id = `round${++sequence}`;
  const askedAt = new Date().toISOString();

  return {
    id,
    agentIds: agents.map((a) => a.id),
    askedAt,
    tasks: agents.map((agent, index) => ({
      ...request,
      id: `${id}:${index}:${agent.id}`,
      agentId: agent.id,
    })),
  };
};

/**
 * The other readings of the same passage.
 *
 * Scope identity rather than block overlap: two proposals compete when they
 * answer the same request, and the request is what an Edit Scope names.
 */
export const competitorsFor = (
  proposals: readonly Proposal[],
  proposalId: string,
): readonly Proposal[] => {
  const subject = proposals.find((p) => p.id === proposalId);
  if (!subject) return [];
  return proposals.filter((p) => p.id !== proposalId && p.scope.id === subject.scope.id);
};

export const roundOf = (round: Round, taskId: string): string | undefined =>
  round.tasks.some((t) => t.id === taskId) ? round.id : undefined;
