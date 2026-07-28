import type { RevisionId } from "@refrain/core";

/**
 * Discussion rounds (design plan §8.2).
 *
 * A round is one question put to a chosen set of agents, each answering
 * independently. It ends when every run reaches a terminal state — success,
 * failure, or cancellation are all terminal — or when the author closes it
 * without waiting.
 *
 * What a round deliberately does not do is start the next one. Recursive
 * discussion is the shape this kind of tool drifts into: agents replying to
 * agents, a budget consumed by a conversation nobody read. The author names
 * the participants each time, which costs a click and buys the guarantee that
 * every model call was asked for.
 *
 * A run that finishes after the close is kept as a late arrival rather than
 * discarded — the work was paid for — but it does not reopen the round and
 * does not join the next one.
 */

export type RunOutcome = "completed" | "failed" | "cancelled";

export interface DiscussionRound {
  readonly id: string;
  readonly agentIds: readonly string[];
  readonly prompt: string;
  readonly baseline: RevisionId;
  readonly state: "open" | "closed";
  readonly settled: Readonly<Record<string, RunOutcome>>;
  readonly late: readonly { agentId: string; runId: string }[];
  /** Participants do not see each other's output within the round. */
  readonly independent: true;
  readonly openedAt: string;
  readonly closedBy?: "author" | "runs-settled";
  readonly closedAt?: string;
}

let sequence = 0;

export const openRound = (spec: {
  agentIds: readonly string[];
  prompt: string;
  baseline: RevisionId;
}): DiscussionRound => ({
  id: `disc${++sequence}`,
  agentIds: [...spec.agentIds],
  prompt: spec.prompt,
  baseline: spec.baseline,
  state: "open",
  settled: {},
  late: [],
  independent: true,
  openedAt: new Date().toISOString(),
});

const allSettled = (round: DiscussionRound): boolean =>
  round.agentIds.every((id) => round.settled[id] !== undefined);

export const settleRun = (
  round: DiscussionRound,
  agentId: string,
  outcome: RunOutcome,
): DiscussionRound => {
  if (round.state === "closed") return round;

  const settled = { ...round.settled, [agentId]: outcome };
  const next: DiscussionRound = { ...round, settled };

  return allSettled(next)
    ? { ...next, state: "closed", closedBy: "runs-settled", closedAt: new Date().toISOString() }
    : next;
};

export const closeRound = (round: DiscussionRound): DiscussionRound =>
  round.state === "closed"
    ? round
    : { ...round, state: "closed", closedBy: "author", closedAt: new Date().toISOString() };

export const isRoundOver = (round: DiscussionRound): boolean => round.state === "closed";

/** Work that arrived after the close: kept as material, not folded into a round. */
export const lateArrival = (
  round: DiscussionRound,
  agentId: string,
  runId: string,
): DiscussionRound =>
  round.state === "open" ? round : { ...round, late: [...round.late, { agentId, runId }] };
