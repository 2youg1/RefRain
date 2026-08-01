/**
 * 改动着色的账本：外部改动进账、作者自己的编辑不进账、两种呈现读同一份判定。
 *
 * 这里测的是**接线**，不是 diff 算法——算法的判定在
 * `packages/typeset/test/diff.test.ts`。两处不该重复：判定测「区间算得对不
 * 对」，这里测「算出来的区间有没有被画出来、该不该画」。上一轮的教训正是
 * 引擎全绿而没有任何测试问过那些数字有没有到达渲染层。
 */

import { describe, expect, test } from "bun:test";
import { ChangeHighlights } from "../src/change-highlights";
import type { Block } from "../src/model";

const block = (id: string, text: string): Block => ({ id, text });
const NOW = 1_000_000;

describe("改动进账", () => {
  test("外部改动着色", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "原文")], [block("b1", "改后的文")], NOW);
    expect(account.isEmpty()).toBe(false);
    expect(account.current(NOW).has("b1")).toBe(true);
  });

  /**
   * 这是整条接线的判据：作者自己敲的字不该着色。
   *
   * 视图 `#submit` 里 `applyLocally` 已把作者的编辑落进投影，所以 `replace`
   * 到达时新旧文本相同。这里直接模拟那个状态——**同一份文本两次**。
   * 若哪天有人在 `#submit` 之外另开一条不过 applyLocally 的路，
   * 这条断言不会红（它测的是账本，不是视图），红的会是下面那条 e2e 形状的
   * 「文本相同则零区间」。两条都留着。
   */
  test("文本没变的块不进账——作者自己的编辑按构造为零区间", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "一样的文本")], [block("b1", "一样的文本")], NOW);
    expect(account.isEmpty()).toBe(true);
  });

  test("新出现的块不着色——整段新增通篇泛色会淹没真正的改动", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "旧")], [block("b1", "旧"), block("b2", "新来的一段")], NOW);
    expect(account.isEmpty()).toBe(true);
  });

  test("只有被改的那个块进账，同批其余块不进", () => {
    const account = new ChangeHighlights();
    account.observe(
      [block("b1", "甲"), block("b2", "乙")],
      [block("b1", "甲"), block("b2", "乙改了")],
      NOW,
    );
    const live = account.current(NOW);
    expect([...live.keys()]).toEqual(["b2"]);
  });
});

describe("两种呈现", () => {
  /** 纯删除：普通模式要标出来，Kara 不标——两者必须可见不同。 */
  test("普通模式标删除，Kara 不标", () => {
    const marks = new ChangeHighlights();
    const result = new ChangeHighlights();
    result.setPresentation("result");
    for (const account of [marks, result]) {
      account.observe([block("b1", "要删掉这句话的一半")], [block("b1", "要删掉这句话")], NOW);
    }
    expect(marks.current(NOW).get("b1")?.length).toBe(1);
    expect(result.current(NOW).has("b1")).toBe(false);
  });

  /** 反向：Kara 不是「不显示改动」。新增在两个模式下都要显示。 */
  test("新增两种模式都显示", () => {
    const marks = new ChangeHighlights();
    const result = new ChangeHighlights();
    result.setPresentation("result");
    for (const account of [marks, result]) {
      account.observe([block("b1", "原文")], [block("b1", "原文加了一段")], NOW);
    }
    expect(marks.current(NOW).get("b1")?.[0]?.kind).toBe("added");
    expect(result.current(NOW).get("b1")?.[0]?.kind).toBe("added");
  });

  /**
   * 换模式不重算判定。
   *
   * 断言的是**区间下标逐个相同**，不是「两边都非空」：后者在「各算各的」
   * 实现下照样通过，而那正是要防的东西。
   */
  test("换模式读同一份判定，不各算各的", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "甲乙丙")], [block("b1", "甲改丙")], NOW);
    const before = account.current(NOW).get("b1");
    account.setPresentation("result");
    const after = account.current(NOW).get("b1");
    expect(after).toEqual(before);
  });
});

describe("消退", () => {
  test("到期后不再着色，且账本自己清干净", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "原文")], [block("b1", "改后")], NOW);
    expect(account.current(NOW + 1_000).size).toBe(1);
    expect(account.current(NOW + 60_000).size).toBe(0);
    // 清账：不清的话长时间编辑会累积出成千上万条早已不着色的记录。
    expect(account.isEmpty()).toBe(true);
  });

  test("换稿子清空——旧稿的改动记录对新稿没有意义", () => {
    const account = new ChangeHighlights();
    account.observe([block("b1", "原文")], [block("b1", "改后")], NOW);
    account.clear();
    expect(account.isEmpty()).toBe(true);
  });
});
