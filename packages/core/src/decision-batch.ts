import type { TextChange, TextHead } from "./domain.ts";
import type { Proposal } from "./review.ts";
import { sliceProposal } from "./review.ts";
import { applyTextAction, blockAt } from "./text-engine.ts";
import type { Verdict } from "./verdict.ts";
import { isAccepted } from "./verdict.ts";

export type BatchRefusal = "nothing-staged" | "stale-baseline" | "overlapping-scopes";

export type DecisionBatchResult =
  | { readonly ok: true; readonly head: TextHead; readonly verdicts: readonly Verdict[] }
  | { readonly ok: false; readonly reason: BatchRefusal; readonly detail: readonly string[] };

const scopeText = (head: TextHead, proposal: Proposal): string | undefined => {
  const texts = proposal.scope.blockIds.map((id) => blockAt(head, id)?.text);
  return texts.some((t) => t === undefined) ? undefined : texts.join("\n\n");
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

  return sliceProposal(proposal)
    .flatMap((slice) => {
      const verdict = bySlice.get(slice.id);
      if (slice.kind === "same") return [slice.text];
      if (slice.kind === "del") return isAccepted(verdict) ? [] : [slice.text];
      return isAccepted(verdict) ? [verdict?.finalText ?? slice.text] : [];
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
