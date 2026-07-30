/**
 * 提案过期的呈现。
 *
 * 断言的重点不是文案好不好听，是**信息有没有到作者手里**：冻结原文必须
 * 交出来（否则他无从对照），恢复步骤必须两条都在（否则等于替他做了选择）。
 */

import { describe, expect, test } from "bun:test";

import type { RefrainError } from "../src/generated/bindings.gen";
import { staleProposalNotice } from "../src/ui/stale-proposal";

const stale = (overrides: Partial<RefrainError> = {}): RefrainError => ({
  code: "stale-proposal",
  action: "commit a decision batch",
  subject: "第三章.md",
  detail: "原来的第二句话。",
  recovery: ["compare-with-frozen-text", "send-again"],
  ...overrides,
});

describe("认出过期失败", () => {
  test("认得出提案过期", () => {
    expect(staleProposalNotice(stale())?.kind).toBe("stale");
  });

  test("别的错误交给通用路径，不硬认", () => {
    // 这一层只懂一件事。造一个「未知的过期通知」会让别的失败说错话。
    expect(staleProposalNotice({ ...stale(), code: "io" })).toBeNull();
    expect(staleProposalNotice(new Error("boom"))).toBeNull();
    expect(staleProposalNotice(null)).toBeNull();
    expect(staleProposalNotice("stale-proposal")).toBeNull();
  });
});

describe("作者拿到了什么", () => {
  test("Agent 当时读到的原文必须交出来", () => {
    // 这是整件事的核心：没有原文，作者无从判断那条建议对现在的文字
    // 还成不成立，「过期了」就只是一句无从行动的通知。
    expect(staleProposalNotice(stale())?.frozenText).toBe("原来的第二句话。");
  });

  test("两条路都摆出来，不替他选", () => {
    expect(staleProposalNotice(stale())?.steps).toEqual([
      "看看 Agent 当时读到的是什么",
      "按现在的文字重新发一次",
    ]);
  });

  test("说的是发生了什么，不是实现细节", () => {
    const headline = staleProposalNotice(stale())?.headline ?? "";
    expect(headline).toContain("改过");
    // 「baseline」「hash」「proposal id」这类词只有实现者懂。
    expect(headline).not.toMatch(/baseline|hash|id|proposal/i);
  });

  test("取不到原文时给空串，界面据此不显示对照块", () => {
    // 空串而不是「无」这类占位文字：一块写着「无」的对照区，
    // 比没有对照区更让人困惑。
    expect(staleProposalNotice(stale({ detail: null }))?.frozenText).toBe("");
  });

  test("恢复步骤按领域给的次序，不重排", () => {
    const reversed = stale({ recovery: ["send-again", "compare-with-frozen-text"] });
    expect(staleProposalNotice(reversed)?.steps).toEqual([
      "按现在的文字重新发一次",
      "看看 Agent 当时读到的是什么",
    ]);
  });
});
