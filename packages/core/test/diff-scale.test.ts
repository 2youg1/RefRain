import { describe, expect, test } from "bun:test";
import type { Proposal } from "../src/index.ts";
import { sliceProposal } from "../src/index.ts";

/**
 * The diff has to survive the manuscript sizes SPEC §10 names, and the old one
 * did not: a single LCS table over n sentences is (n+1)² × 4 bytes, so 10⁵
 * blocks asked for 37 GB — past the 2 GB ceiling on one Int32Array, meaning
 * the allocation throws rather than merely being slow. At 10⁴ it already cost
 * 836 ms and a 381 MB table.
 *
 * These are budgets, not benchmarks. They are set several times looser than
 * the measured figures so an ordinary slow machine does not fail the build,
 * while a return to quadratic behaviour fails it immediately — that regression
 * is three orders of magnitude, not a few percent.
 */

const sentence = (i: number): string => `第${i}句話在這裏，長度大致相當於一句普通的中文。`;

const proposalOver = (
  count: number,
  mutate: (after: string[]) => void,
): { proposal: Proposal; changed: number } => {
  const before = Array.from({ length: count }, (_, i) => sentence(i));
  const after = [...before];
  mutate(after);
  const changed = after.filter((text, i) => text !== before[i]).length;
  return {
    proposal: {
      id: "p1",
      runId: "r1",
      baseline: "rev0",
      scope: { id: "s1", blockIds: ["b0"] },
      before: before.join(""),
      after: after.join(""),
    },
    changed,
  };
};

describe("the diff scales to a whole manuscript", () => {
  test("ten thousand sentences with scattered edits finishes promptly", () => {
    const { proposal, changed } = proposalOver(10_000, (after) => {
      for (let k = 0; k < 10; k++) after[k * 997] = `第${k}處改動。`;
    });

    const started = performance.now();
    const slices = sliceProposal(proposal);
    const elapsed = performance.now() - started;

    // Measured at 4 ms. The budget is 400 ms: the old implementation took
    // 836 ms here, so anything quadratic still fails.
    expect(elapsed).toBeLessThan(400);
    expect(slices.filter((slice) => slice.kind !== "same")).toHaveLength(changed * 2);
  });

  /**
   * The case that used to be impossible rather than slow. A single table for
   * 10⁵ sentences cannot be allocated at all, so this test asserts that the
   * call returns — the timing is almost beside the point.
   */
  test("a hundred thousand sentences with one edit is a small problem", () => {
    const { proposal } = proposalOver(100_000, (after) => {
      after[50_000] = "只有這一句被改了。";
    });

    const started = performance.now();
    const slices = sliceProposal(proposal);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(3_000); // measured at 44 ms
    expect(slices.filter((slice) => slice.kind !== "same")).toHaveLength(2);
  });

  test("a hundred thousand sentences with a thousand edits stays affordable", () => {
    const { proposal, changed } = proposalOver(100_000, (after) => {
      for (let k = 0; k < 1_000; k++) after[k * 97] = `第${k}處改動。`;
    });

    const started = performance.now();
    const slices = sliceProposal(proposal);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(3_000); // measured at 36 ms
    expect(slices.filter((slice) => slice.kind !== "same")).toHaveLength(changed * 2);
  });

  /**
   * Segmentation must not change what the diff says, only what it costs. An
   * edit that spans an anchor-length run of unchanged text is the case where a
   * naive split would report the wrong thing.
   */
  test("splitting on unchanged runs does not change the result", () => {
    const before = [
      "第一句。",
      "第二句。",
      "共同的一句。",
      "共同的二句。",
      "共同的三句。",
      "共同的四句。",
      "共同的五句。",
      "共同的六句。",
      "共同的七句。",
      "共同的八句。",
      "共同的九句。",
      "最後一句。",
    ].join("");

    const after = before
      .replace("第二句。", "改寫的第二句。")
      .replace("最後一句。", "改寫的末句。");

    const slices = sliceProposal({
      id: "p1",
      runId: "r1",
      baseline: "rev0",
      scope: { id: "s1", blockIds: ["b0"] },
      before,
      after,
    });

    // Two edits, each a delete plus an insert; the nine shared sentences and
    // the untouched first one survive as context.
    expect(slices.filter((slice) => slice.kind === "del").map((slice) => slice.text)).toEqual([
      "第二句。",
      "最後一句。",
    ]);
    expect(slices.filter((slice) => slice.kind === "ins").map((slice) => slice.text)).toEqual([
      "改寫的第二句。",
      "改寫的末句。",
    ]);
    expect(slices.filter((slice) => slice.kind === "same")).toHaveLength(10);
  });

  /**
   * Every earlier test edits in place, which leaves each later sentence at the
   * position it already had. One inserted sentence shifts all of them by one,
   * and that is the case the review engine's own segmentation could not handle:
   * without probing for the shift, nothing matches again after the insertion,
   * no anchor is ever found, and the whole scope becomes one region — the
   * quadratic table this file exists to prevent. Measured before the fix: 2.6 s
   * at 20,000 sentences, growing fourfold per doubling.
   */
  test("one sentence inserted at the head does not defeat segmentation", () => {
    const before = Array.from({ length: 20_000 }, (_, i) => sentence(i)).join("");

    const started = performance.now();
    const slices = sliceProposal({
      id: "p1",
      runId: "r1",
      baseline: "rev0",
      scope: { id: "s1", blockIds: ["b0"] },
      before,
      after: `插入的第一句。${before}`,
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(400);
    expect(slices.filter((slice) => slice.kind === "ins").map((slice) => slice.text)).toEqual([
      "插入的第一句。",
    ]);
    expect(slices.filter((slice) => slice.kind === "del")).toHaveLength(0);
  });

  /**
   * A region past the table budget must be reported, not allocated. The review
   * engine had no budget check at all, so two fully divergent texts asked for
   * (n+1)(m+1) cells however large the manuscript was — the exact allocation
   * the alignment module was written to refuse.
   */
  test("two fully divergent texts are reported rather than tabled", () => {
    const before = Array.from({ length: 5_000 }, (_, i) => `甲${i}這句完全不同。`).join("");
    const after = Array.from({ length: 5_000 }, (_, i) => `乙${i}那句毫不相干。`).join("");

    const slices = sliceProposal({
      id: "p1",
      runId: "r1",
      baseline: "rev0",
      scope: { id: "s1", blockIds: ["b0"] },
      before,
      after,
    });

    expect(slices.filter((slice) => slice.kind === "del")).toHaveLength(5_000);
    expect(slices.filter((slice) => slice.kind === "ins")).toHaveLength(5_000);
    expect(slices.filter((slice) => slice.kind === "same")).toHaveLength(0);
  });
});
