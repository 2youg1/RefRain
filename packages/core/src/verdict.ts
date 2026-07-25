import type { RevisionId } from "./domain.ts";

export type VerdictKind = "accept" | "accept-modified" | "reject" | "comment-only";

/**
 * A human judgment on one Review Slice, or on a whole Proposal when sliceId is
 * absent. The ledger's unit.
 *
 * `reason` is the ledger's most valuable field: a judgment with stated
 * reasoning is what makes a verdict worth replaying to an agent. Presence and
 * absence stay distinguishable — an unstated reason is never an empty string.
 */
export interface Verdict {
  readonly id: string;
  readonly proposalId: string;
  readonly sliceId?: string;
  readonly kind: VerdictKind;
  /** Required when kind is accept-modified: the author's own wording. */
  readonly finalText?: string;
  readonly reason?: string;
  readonly baseline: RevisionId;
  readonly decidedAt: string;
}

export const isAccepted = (verdict: Verdict | undefined): boolean =>
  verdict?.kind === "accept" || verdict?.kind === "accept-modified";
