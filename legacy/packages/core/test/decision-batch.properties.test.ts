import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Proposal, TextHead, Verdict } from "../src/index.ts";
import { commitDecisionBatch, currentText, sliceProposal } from "../src/index.ts";

/**
 * Properties, not examples (SPEC 7.4).
 *
 * The specification states an algebraic law — "Disjoint Proposals must satisfy
 * `merge(A, then B) == merge(B, then A)`" — and every test in this package was
 * an example test, so the law itself had no coverage. An example test proves
 * the pair it names commutes; a property test looks for the pair that does not.
 *
 * fast-check is a devDependency. `packages/core` keeps its zero runtime
 * dependencies: nothing here is imported by src.
 */

const BASELINE = "rev1";
const DECIDED = "2026-07-27T00:00:00.000Z";

const head = (blockCount: number): TextHead => ({
  id: "h1",
  blocks: Array.from({ length: blockCount }, (_, i) => ({ id: `b${i}`, text: `原文 ${i}。` })),
  cause: "property fixture",
});

const proposalOn = (head: TextHead, index: number, text: string): Proposal => {
  const block = head.blocks[index];
  if (!block) throw new Error(`no block at ${index}`);
  return {
    id: `p${index}`,
    runId: "run1",
    baseline: BASELINE,
    scope: { id: `s${index}`, blockIds: [block.id] },
    before: block.text,
    after: text,
  };
};

/**
 * Accepting every slice. A proposal-level accept is not enough — an unjudged
 * slice counts as rejected, so a bare accept would silently test the identity.
 */
const acceptAll = (proposal: Proposal): Verdict[] =>
  sliceProposal(proposal).map((slice, i) => ({
    id: `v-${proposal.id}-${i}`,
    proposalId: proposal.id,
    sliceId: slice.id,
    kind: "accept" as const,
    baseline: BASELINE,
    decidedAt: DECIDED,
  }));

/** Distinct block indices, so the proposals are disjoint by construction. */
const disjointIndices = (blockCount: number, count: number): fc.Arbitrary<number[]> =>
  fc
    .uniqueArray(fc.integer({ min: 0, max: blockCount - 1 }), {
      minLength: count,
      maxLength: count,
    })
    .map((indices) => [...indices].sort((a, b) => a - b));

describe("Decision Batch properties", () => {
  test("disjoint proposals commute: merge(A then B) == merge(B then A)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 24 }),
        fc.integer({ min: 2, max: 4 }),
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 4, maxLength: 4 }),
        (blockCount, proposalCount, texts) => {
          const start = head(blockCount);
          const indices = fc.sample(
            disjointIndices(blockCount, Math.min(proposalCount, blockCount)),
            1,
          )[0];
          if (!indices) return true;

          const proposals = indices.map((index, i) =>
            proposalOn(start, index, `改写 ${texts[i % texts.length]}`),
          );

          const forward = commitDecisionBatch(start, proposals, proposals.flatMap(acceptAll));
          const reversed = [...proposals].reverse();
          const backward = commitDecisionBatch(start, reversed, reversed.flatMap(acceptAll));

          expect(forward.ok).toBe(backward.ok);
          if (!forward.ok || !backward.ok) return true;
          // Head ids are minted per action and are expected to differ; the text
          // the author ends up with is what the law is about.
          expect(currentText(forward.head)).toBe(currentText(backward.head));
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a scope replaces its own slot and no other", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 20 }),
        fc.integer({ min: 1, max: 3 }),
        (blockCount, proposalCount) => {
          const start = head(blockCount);
          const indices = fc.sample(
            disjointIndices(blockCount, Math.min(proposalCount, blockCount)),
            1,
          )[0];
          if (!indices) return true;

          const proposals = indices.map((index) => proposalOn(start, index, `改写 ${index}。`));
          const result = commitDecisionBatch(start, proposals, proposals.flatMap(acceptAll));
          if (!result.ok) return true;

          const touched = new Set(indices);
          for (const [i, block] of result.head.blocks.entries()) {
            if (touched.has(i)) continue;
            expect(block.text).toBe(`原文 ${i}。`);
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  /*
   * The three properties above generate disjoint scopes by construction, so
   * none of them can reach the conflict branch — disabling it left all three
   * green. SPEC 7.4.4 is a rule about what happens when scopes *do* overlap,
   * and it needs a generator that produces overlap on purpose.
   */
  test("overlapping scopes refuse the batch rather than picking a winner", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 0, max: 19 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (blockCount, rawIndex, first, second) => {
          const start = head(blockCount);
          const index = rawIndex % blockCount;

          // Two proposals addressing the same block: whichever way the batch is
          // ordered, no ordering may be allowed to decide the outcome.
          const a = {
            ...proposalOn(start, index, `甲 ${first}`),
            id: "pa",
            scope: { id: "sa", blockIds: [`b${index}`] },
          };
          const b = {
            ...proposalOn(start, index, `乙 ${second}`),
            id: "pb",
            scope: { id: "sb", blockIds: [`b${index}`] },
          };

          const forward = commitDecisionBatch(start, [a, b], [...acceptAll(a), ...acceptAll(b)]);
          const backward = commitDecisionBatch(start, [b, a], [...acceptAll(b), ...acceptAll(a)]);

          // Refusal is the correct outcome. Committing at all would mean an
          // ordering picked a winner, and the two orders would disagree.
          expect(forward.ok).toBe(false);
          expect(backward.ok).toBe(false);
          if (!forward.ok) expect(forward.reason).toBe("overlapping-scopes");
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  test("rejecting every slice leaves the manuscript byte-identical", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1, max: 4 }),
        (blockCount, proposalCount) => {
          const start = head(blockCount);
          const indices = fc.sample(
            disjointIndices(blockCount, Math.min(proposalCount, blockCount)),
            1,
          )[0];
          if (!indices) return true;

          const proposals = indices.map((index) => proposalOn(start, index, `改写 ${index}。`));
          const rejections: Verdict[] = proposals.flatMap((proposal) =>
            sliceProposal(proposal).map((slice, i) => ({
              id: `v-${proposal.id}-${i}`,
              proposalId: proposal.id,
              sliceId: slice.id,
              kind: "reject" as const,
              baseline: BASELINE,
              decidedAt: DECIDED,
            })),
          );

          const result = commitDecisionBatch(start, proposals, rejections);
          if (!result.ok) return true;
          expect(currentText(result.head)).toBe(currentText(start));
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});
