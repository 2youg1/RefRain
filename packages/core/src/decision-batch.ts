import type { TextChange, TextHead } from "./domain.ts";
import type { Proposal } from "./review.ts";
import { sliceProposal } from "./review.ts";
import { applyTextAction, blockAt } from "./text-engine.ts";
import type { Verdict } from "./verdict.ts";
import { isAccepted } from "./verdict.ts";

export type BatchRefusal =
  | "nothing-staged"
  | "invalid-verdicts"
  | "stale-baseline"
  | "overlapping-scopes";

export type DecisionBatchResult =
  | { readonly ok: true; readonly head: TextHead; readonly verdicts: readonly Verdict[] }
  | { readonly ok: false; readonly reason: BatchRefusal; readonly detail: readonly string[] };

const scopeText = (head: TextHead, proposal: Proposal): string | undefined => {
  const texts = proposal.scope.blockIds.map((id) => blockAt(head, id)?.text);
  return texts.some((t) => t === undefined) ? undefined : texts.join("\n\n");
};

const invalidVerdicts = (
  proposals: readonly Proposal[],
  verdicts: readonly Verdict[],
): string[] => {
  const byProposal = new Map(proposals.map((proposal) => [proposal.id, proposal] as const));
  const sliceIds = new Map(
    proposals.map((proposal) => [
      proposal.id,
      new Set(
        sliceProposal(proposal)
          .filter((slice) => slice.kind !== "same")
          .map((slice) => slice.id),
      ),
    ]),
  );
  const judged = new Set<string>();
  const invalid: string[] = [];

  for (const verdict of verdicts) {
    const proposal = byProposal.get(verdict.proposalId);
    if (!proposal) {
      invalid.push(`${verdict.id}: unknown Proposal ${verdict.proposalId}`);
      continue;
    }
    if (verdict.baseline !== proposal.baseline)
      invalid.push(`${verdict.id}: baseline does not match Proposal ${proposal.id}`);
    if (verdict.sliceId === undefined) {
      invalid.push(`${verdict.id}: Decision Batch requires a Review Slice`);
      continue;
    }
    if (!sliceIds.get(proposal.id)?.has(verdict.sliceId))
      invalid.push(`${verdict.id}: unknown Review Slice ${verdict.sliceId}`);
    const key = `${proposal.id}\0${verdict.sliceId}`;
    if (judged.has(key))
      invalid.push(`${verdict.id}: Review Slice ${verdict.sliceId} is judged twice`);
    judged.add(key);
    if (verdict.kind === "accept-modified" && verdict.finalText === undefined)
      invalid.push(`${verdict.id}: accept-modified requires finalText`);
    if (verdict.kind !== "accept-modified" && verdict.finalText !== undefined)
      invalid.push(`${verdict.id}: ${verdict.kind} cannot carry finalText`);
  }

  return invalid;
};

/**
 * Rebuild one Edit Scope's final replacement from the verdicts on its slices
 * (SPEC 7.4 rule 2).
 *
 * An unjudged slice counts as rejected. The conservative reading keeps the
 * author's text, so a forgotten slice can never smuggle agent wording into the
 * manuscript.
 */
export const rebuildReplacement = (proposal: Proposal, verdicts: readonly Verdict[]): string => {
  const bySlice = new Map(verdicts.filter((v) => v.sliceId).map((v) => [v.sliceId, v] as const));

  // Each kept slice carries the whitespace it sat behind, so rejecting
  // everything reproduces `proposal.before` byte for byte. Joining trimmed
  // sentences instead — which is what this did — closed every sentence gap and
  // every paragraph break, so a proposal the author had refused in full still
  // came back having rewritten their spacing.
  return sliceProposal(proposal)
    .flatMap((slice) => {
      const verdict = bySlice.get(slice.id);
      const kept = (text: string) => [slice.lead + text + slice.trail];
      if (slice.kind === "same") return kept(slice.text);
      if (slice.kind === "del") return isAccepted(verdict) ? [] : kept(slice.text);
      return isAccepted(verdict) ? kept(verdict?.finalText ?? slice.text) : [];
    })
    .join("");
};

/**
 * Compile staged verdicts into one Text Action (SPEC 7.4).
 *
 * The batch is all-or-nothing. On any conflict it refuses and names what
 * conflicted, because the system must never pick a winner by hidden ordering —
 * that adjudication belongs to the human.
 */
export const commitDecisionBatch = (
  commitBasis: TextHead,
  proposals: readonly Proposal[],
  verdicts: readonly Verdict[],
): DecisionBatchResult => {
  if (verdicts.length === 0) return { ok: false, reason: "nothing-staged", detail: [] };

  const invalid = invalidVerdicts(proposals, verdicts);
  if (invalid.length > 0) return { ok: false, reason: "invalid-verdicts", detail: invalid };

  const judged = new Set(verdicts.map((v) => v.proposalId));
  const staged = proposals.filter((p) => judged.has(p.id));

  const stale = staged.filter((p) => scopeText(commitBasis, p) !== p.before);
  if (stale.length > 0)
    return {
      ok: false,
      reason: "stale-baseline",
      detail: stale.map(
        (p) =>
          `${p.id}: the manuscript changed under scope ${p.scope.id} since revision ${p.baseline}`,
      ),
    };

  const changes: TextChange[] = staged
    .map((p) => {
      const text = rebuildReplacement(
        p,
        verdicts.filter((v) => v.proposalId === p.id),
      );
      return { blockIds: p.scope.blockIds, text: text.length === 0 ? null : text };
    })
    .filter((change, index) => change.text !== staged[index]?.before);

  const overlaps = staged.flatMap((a, i) =>
    staged.slice(i + 1).flatMap((b) => {
      const shared = a.scope.blockIds.filter((id) => b.scope.blockIds.includes(id));
      return shared.length === 0 ? [] : [`${a.id} and ${b.id} both replace ${shared.join(", ")}`];
    }),
  );
  if (overlaps.length > 0)
    return {
      ok: false,
      reason: "overlapping-scopes",
      detail: [...overlaps, "stage one of them, or write a single replacement over the union"],
    };

  // A batch of pure rejections is a real commit: nothing moves in the
  // manuscript, but the judgments enter the ledger.
  const head =
    changes.length === 0
      ? commitBasis
      : applyTextAction(
          commitBasis,
          changes,
          `decision-batch(${staged.map((p) => p.id).join(",")})`,
        );

  return { ok: true, head, verdicts };
};
