/**
 * 饭盒的锚点：提案 → 段落右缘的印点。
 *
 * 提案自己不带块 id（scope 只活在冻结请求里），它带的是 slice 的原文——
 * 锚定就是「这段原文此刻住在哪个块里」。按文本找，不按 id 猜：作者可能
 * 已经改过那段，找不到就坦白没有锚点，而不是钉到错的段落上。
 */

import type { ProposalMark } from "@refrain/editor";
import type { ProposalDto } from "../generated/bindings.gen";

export type VerdictAnchor = ProposalMark & {
  /** slice 原文在块内的起止——饭盒里的「原文（划线）」划的就是这一段。 */
  readonly start: number;
  readonly end: number;
};

/** 每条提案取它第一个能锚住的 slice；锚不住的提案不进视图。 */
export function anchorProposals(
  proposals: readonly ProposalDto[],
  blocks: readonly { id: string; text: string }[],
): VerdictAnchor[] {
  const anchors: VerdictAnchor[] = [];
  for (const proposal of proposals) {
    for (const slice of proposal.slices) {
      let found: VerdictAnchor | null = null;
      for (const block of blocks) {
        const start = block.text.indexOf(slice.text);
        if (slice.text === "" || start < 0) continue;
        found = { id: proposal.id, blockId: block.id, start, end: start + slice.text.length };
        break;
      }
      if (found !== null) {
        anchors.push(found);
        break;
      }
    }
  }
  return anchors;
}

/** 版心右缘占屏宽的比例上限（66%）：超过它，右侧就容不下一只饭盒。 */
const SIDE_LIMIT = 0.66;

/**
 * 饭盒在哪开：版心右侧放得下就侧挂（不撑开正文）；版心宽过屏宽三分之二，
 * 右侧放不下，改在上下文中展开。
 */
export function bentoLayout(measureRightPx: number, viewportWidthPx: number): "side" | "inline" {
  if (viewportWidthPx <= 0) return "inline";
  return measureRightPx / viewportWidthPx <= SIDE_LIMIT ? "side" : "inline";
}
