/**
 * 饭盒的锚点：提案 → 段落右缘的印点。
 *
 * 提案自己不带块 id（scope 只活在冻结请求里），它带的是 slice 的原文——
 * 锚定就是「这段原文此刻住在哪个块里」。按文本找，不按 id 猜：作者可能
 * 已经改过那段，找不到就坦白没有锚点，饭盒不出现，而不是钉到错的段落上。
 */

import { describe, expect, test } from "bun:test";

import type { ProposalDto } from "../src/generated/bindings.gen";
import { anchorProposals, bentoLayout } from "../src/shell/verdict-anchors";

const proposal = (id: string, texts: readonly string[]): ProposalDto => ({
  id,
  run: "r1",
  baseline: "b",
  before: texts.join("\n"),
  after: null,
  changeClass: "edit",
  slices: texts.map((text, index) => ({
    id: `${id}:s${index}`,
    kind: "replace",
    text,
    lead: "",
    trail: "",
  })),
});

const blocks = [
  { id: "ch01:b1", text: "剑一直握在他手里。" },
  { id: "ch01:b2", text: "他没有说话，走廊很长。" },
];

describe("提案锚点", () => {
  test("slice 原文落在哪个块，印点就钉在哪一段", () => {
    const marks = anchorProposals([proposal("p1", ["剑一直握在他手里。"])], blocks);
    expect(marks).toEqual([{ id: "p1", blockId: "ch01:b1", start: 0, end: 9 }]);
  });

  test("原文是块的一段时，划线范围是它的起止", () => {
    const marks = anchorProposals([proposal("p1", ["没有说话"])], blocks);
    expect(marks).toEqual([{ id: "p1", blockId: "ch01:b2", start: 1, end: 5 }]);
  });

  test("作者改过那段之后没有锚点——不钉到错的段落上", () => {
    const marks = anchorProposals([proposal("p1", ["已经不存在的一句。"])], blocks);
    expect(marks).toEqual([]);
  });

  test("一条提案取它第一个能锚住的 slice", () => {
    const marks = anchorProposals(
      [proposal("p1", ["不存在。", "走廊很长。", "也不存在。"])],
      blocks,
    );
    expect(marks).toEqual([{ id: "p1", blockId: "ch01:b2", start: 6, end: 11 }]);
  });
});

describe("饭盒在哪开", () => {
  test("版心右侧放得下就侧挂", () => {
    // 版心右缘在屏宽 2/3 以内：右缘之外容得下一只饭盒。
    expect(bentoLayout(600, 1200)).toBe("side");
  });

  test("版心超过屏宽 66% 就改在上下文中展开", () => {
    expect(bentoLayout(900, 1200)).toBe("inline");
    expect(bentoLayout(800, 1200)).toBe("inline");
  });
});
