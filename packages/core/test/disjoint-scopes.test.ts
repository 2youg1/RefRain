import { describe, expect, test } from "bun:test";
import type { Proposal, TextHead, Verdict } from "../src/index.ts";
import { commitDecisionBatch, parseAgentResult, sliceProposal } from "../src/index.ts";

/**
 * One Review Task, several disjoint Edit Scopes (SPEC 2.2).
 *
 * An older draft carried the opposite rule — one run binds one contiguous
 * scope, so anything else splits into separate runs. Two independent readers
 * costed that out the same way: a chapter with forty small problems becomes
 * forty runs, which is the difference between a line-editing tool and a
 * curiosity. The parser, the artifact schema and the batch commit were all
 * built plural from the start; only the prose said otherwise.
 *
 * These tests exist so the constraint cannot creep back in unnoticed.
 */

const head = (blocks: { id: string; text: string }[]): TextHead => ({
  id: "h1",
  blocks,
  cause: "test fixture",
});

const proposal = (id: string, blockIds: string[], before: string, after: string): Proposal => ({
  id,
  runId: "run1",
  baseline: "rev1",
  scope: { id: `s-${id}`, blockIds },
  before,
  after,
});

/**
 * Accepting every slice of a proposal. A bare proposal-level accept is not
 * enough: `rebuildReplacement` counts an unjudged slice as rejected, so the
 * author's text survives anything they forgot to look at.
 */
const acceptAll = (p: Proposal): Verdict[] =>
  sliceProposal(p).map((slice, i) => ({
    id: `v-${p.id}-${i}`,
    proposalId: p.id,
    sliceId: slice.id,
    kind: "accept" as const,
    baseline: "rev1",
    decidedAt: "2026-07-26T00:00:00.000Z",
  }));

describe("Disjoint Edit Scopes", () => {
  test("one result carries replacements for several scopes", () => {
    const parsed = parseAgentResult(`<agent-result version="1">
<replacement scope="b1">改过的第一段。</replacement>
<replacement scope="b7">改过的第七段。</replacement>
<replacement scope="b19">改过的第十九段。</replacement>
</agent-result>`);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.replacements).toHaveLength(3);
    expect(parsed.value.replacements.map((r) => r.scope)).toEqual(["b1", "b7", "b19"]);
  });

  test("the same scope cannot be replaced twice in one result", () => {
    const parsed = parseAgentResult(`<agent-result version="1">
<replacement scope="b1">第一次。</replacement>
<replacement scope="b1">第二次。</replacement>
</agent-result>`);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("duplicate-replacement");
  });

  test("forty scattered edits commit as one Decision Batch, not forty", () => {
    const blocks = Array.from({ length: 80 }, (_, i) => ({ id: `b${i}`, text: `原文 ${i}。` }));
    const targets = Array.from({ length: 40 }, (_, i) => i * 2);

    const proposals = targets.map((i) =>
      proposal(`p${i}`, [`b${i}`], `原文 ${i}。`, `改过 ${i}。`),
    );
    const result = commitDecisionBatch(head(blocks), proposals, proposals.flatMap(acceptAll));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head.blocks[0]?.text).toBe("改过 0。");
    expect(result.head.blocks[2]?.text).toBe("改过 2。");
    /* Untouched slots keep their text: a scope replaces its slot and nothing else. */
    expect(result.head.blocks[1]?.text).toBe("原文 1。");
  });

  test("a batch spanning disjoint scopes produces one new Text Head", () => {
    const blocks = [
      { id: "b1", text: "第一段。" },
      { id: "b2", text: "第二段。" },
      { id: "b3", text: "第三段。" },
    ];
    const proposals = [
      proposal("p1", ["b1"], "第一段。", "改了第一段。"),
      proposal("p3", ["b3"], "第三段。", "改了第三段。"),
    ];

    const result = commitDecisionBatch(head(blocks), proposals, proposals.flatMap(acceptAll));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head.id).not.toBe("h1");
    expect(result.head.blocks.map((b) => b.text)).toEqual([
      "改了第一段。",
      "第二段。",
      "改了第三段。",
    ]);
  });
});
