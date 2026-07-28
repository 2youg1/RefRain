import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proposal, Verdict } from "../src/index.ts";
import { commitDecisionBatch, currentText, loadProject, sliceProposal } from "../src/index.ts";

/**
 * The loop the whole application exists to close: a selection becomes an Edit
 * Scope, a run produces a Proposal, a human judges its slices, and a Decision
 * Batch writes a new Text Head.
 *
 * It was broken end to end and no test noticed, because every test built its
 * own Proposal with a correct block id while the interface built one with a
 * fabricated id. These tests start from a chapter on disk, the way the
 * application does, so a scope that the interface could not actually produce
 * cannot pass them.
 */

const chapterFile = (body: string): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "refrain-loop-"));
  writeFileSync(join(root, "第一章.md"), body, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const BODY = "黑暗中有人问。\n\n声音很熟。她想起十年前那个雨夜。\n\n剑尖垂下去。\n";

const acceptEvery = (proposal: Proposal): Verdict[] =>
  sliceProposal(proposal)
    .filter((slice) => slice.kind !== "same")
    .map((slice, index) => ({
      id: `v${index}`,
      proposalId: proposal.id,
      sliceId: slice.id,
      kind: "accept" as const,
      baseline: "rev0",
      decidedAt: "2026-07-26T00:00:00Z",
    }));

describe("the review loop, from a chapter on disk", () => {
  test("a scope built from a real block id merges", () => {
    const { root, cleanup } = chapterFile(BODY);
    try {
      const head = loadProject(root).chapters[0]?.head;
      expect(head).toBeDefined();
      if (!head) return;

      const block = head.blocks[1];
      expect(block).toBeDefined();
      if (!block) return;

      const proposal: Proposal = {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s1", blockIds: [block.id] },
        before: block.text,
        after: "剑没有松。她想起十年前那个雨夜。",
      };

      const result = commitDecisionBatch(head, [proposal], acceptEvery(proposal));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(currentText(result.head)).toBe(
        "黑暗中有人问。\n\n剑没有松。她想起十年前那个雨夜。\n\n剑尖垂下去。",
      );
    } finally {
      cleanup();
    }
  });

  /**
   * The interface used to send `${chapter}:sel`, which core never mints. The
   * batch looked the scope up, found nothing, and refused — so every merge
   * started from the Dispatch panel failed, on every manuscript.
   */
  test("a block id the project never minted is refused, not guessed at", () => {
    const { root, cleanup } = chapterFile(BODY);
    try {
      const head = loadProject(root).chapters[0]?.head;
      if (!head) return;

      const proposal: Proposal = {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s1", blockIds: ["第一章:sel"] },
        before: head.blocks[1]?.text ?? "",
        after: "剑没有松。她想起十年前那个雨夜。",
      };

      const result = commitDecisionBatch(head, [proposal], acceptEvery(proposal));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("stale-baseline");
    } finally {
      cleanup();
    }
  });

  /**
   * A Proposal's `before` is compared against the whole block. Half a sentence
   * can never match, which is why the selection has to snap outward to the
   * paragraphs it touches before a scope is built from it.
   */
  test("half a block as the baseline cannot match, so scopes must be whole blocks", () => {
    const { root, cleanup } = chapterFile(BODY);
    try {
      const head = loadProject(root).chapters[0]?.head;
      if (!head) return;
      const block = head.blocks[1];
      if (!block) return;

      const partial: Proposal = {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s1", blockIds: [block.id] },
        before: "声音很熟。",
        after: "剑没有松。",
      };

      const result = commitDecisionBatch(head, [partial], acceptEvery(partial));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("stale-baseline");
    } finally {
      cleanup();
    }
  });

  test("a scope spanning two blocks merges both", () => {
    const { root, cleanup } = chapterFile(BODY);
    try {
      const head = loadProject(root).chapters[0]?.head;
      if (!head) return;
      const [first, second] = head.blocks;
      if (!first || !second) return;

      const proposal: Proposal = {
        id: "p1",
        runId: "r1",
        baseline: "rev0",
        scope: { id: "s1", blockIds: [first.id, second.id] },
        before: `${first.text}\n\n${second.text}`,
        after: "黑暗中有人问。\n\n剑没有松。",
      };

      const result = commitDecisionBatch(head, [proposal], acceptEvery(proposal));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(currentText(result.head)).toContain("剑没有松。");
    } finally {
      cleanup();
    }
  });
});
