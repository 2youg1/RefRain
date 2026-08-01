/**
 * 断行接管：`spacedRuns` 在给了版心宽度时要切出换行，且不得动到任何字符。
 *
 * 这里测的是切分这一层。断点算得对不对是 `packages/typeset` 的事
 * （`optimal-break.test.ts` 已有 30 条）；画出来对不对是
 * `e2e/verify-linebreak-takeover.ts` 的事。三层各测各的一件事。
 */

import { describe, expect, test } from "bun:test";
import { presetOf, ZH_HANS } from "@refrain/typeset";
import { spacedRuns } from "../src/inter-script-spacing";

/** 一段够长的中文，20em 版心下必然要断成几行。 */
const LONG =
  "排版这件事的难处不在于把字摆整齐，而在于每一次摆放都要同时满足几条互相拉扯的规矩，而它们的优先级从来没有被写在同一张纸上。";

describe("断行切分", () => {
  test("给了版心就切出换行", () => {
    const runs = spacedRuns(LONG, ZH_HANS, 20);
    const breaks = runs.filter((run) => run.breakAfter).length;
    // 验红：把 `spacedRuns` 里的 `starts` 恒置 null，这里降到 0。
    expect(breaks).toBeGreaterThan(0);
  });

  test("不给版心就不断行——宽度未知时按 0 断会把每个字断成一行", () => {
    const runs = spacedRuns(LONG, ZH_HANS);
    expect(runs.some((run) => run.breakAfter)).toBe(false);
  });

  test("版心越宽换行越少", () => {
    const narrow = spacedRuns(LONG, ZH_HANS, 15).filter((run) => run.breakAfter).length;
    const wide = spacedRuns(LONG, ZH_HANS, 40).filter((run) => run.breakAfter).length;
    // 验红：让 measureEm 不参与计算，两者相等。
    expect(narrow).toBeGreaterThan(wide);
  });

  test("断行不改变任何字符——拼回来逐字等于原文", () => {
    for (const measureEm of [10, 15, 20, 30, 40]) {
      const joined = spacedRuns(LONG, ZH_HANS, measureEm)
        .map((run) => run.text)
        .join("");
      expect(joined).toBe(LONG);
    }
  });

  /**
   * 段首不换行。
   *
   * 判据不能写成「首个 run 文本非空」：`optimizedLineStarts` 恒把 0 作为第一
   * 个行首，而 index 0 处 `pending` 还是空串，被「pending 非空」那道条件挡下
   * ——注入「段首也换行」之后十一条断言照样全绿，因为真正挡住它的是另一处。
   *
   * 改为断言**换行元素的位置**：任何一个 run 的换行都必须在有文本之后。
   * 一个 `text === "" && breakAfter` 的 run 就是段首那一下多出来的换行。
   */
  test("段首不换行——在第一个字符前插换行会让整段掉一行", () => {
    for (const measureEm of [10, 15, 20, 30]) {
      const runs = spacedRuns(LONG, ZH_HANS, measureEm);
      const empty = runs.filter((run) => run.text === "" && run.breakAfter);
      expect(empty).toEqual([]);
    }
  });

  test("末段不带换行——段落末尾的换行会多出一个空行", () => {
    const runs = spacedRuns(LONG, ZH_HANS, 20);
    expect(runs.at(-1)?.breakAfter).toBe(false);
  });

  /**
   * 换行处不画间距。
   *
   * 混排间距挂在行尾会把行推出版心：那段空白在行的末端，读者看不见它，
   * 但它参与行宽。断在混排边界上时两个调整撞在一处，必须由换行胜出。
   */
  test("换行处不画间距", () => {
    // 语料必须真的在混排边界上断过行，否则循环体一次也不执行而测试照样全绿。
    // 第一版用的中英混排语料，七个版心下的换行点**没有一个**带 spaceBefore
    // （实测全部为空），那条断言从未运行过。这里用密集混排把断点逼到边界上，
    // 并先断样本数 > 0。
    const dense = "中文abc中文def中文ghi中文jkl中文mno中文pqr中文stu中文vwx中文yz中文";
    let breaksAtBoundary = 0;
    for (const measureEm of [6, 8, 10, 12, 15, 18, 20]) {
      const runs = spacedRuns(dense, ZH_HANS, measureEm);
      for (const run of runs) {
        if (!run.breakAfter) continue;
        breaksAtBoundary += 1;
        expect(run.gapAfter).toBe(0);
      }
    }
    expect(breaksAtBoundary).toBeGreaterThan(0);
  });

  test("代理对不被切坏——emoji 与增补平面汉字", () => {
    const text = `${"字".repeat(30)}😀${"字".repeat(30)}𠮷${"字".repeat(30)}`;
    const joined = spacedRuns(text, ZH_HANS, 12)
      .map((run) => run.text)
      .join("");
    expect(joined).toBe(text);
    expect([...joined].length).toBe([...text].length);
  });

  test("日文预设同样断行——不是只对简中生效", () => {
    const japanese = "組版という仕事の難しさは、字をきれいに並べることにあるのではない。".repeat(2);
    const runs = spacedRuns(japanese, presetOf("ja"), 15);
    expect(runs.some((run) => run.breakAfter)).toBe(true);
    expect(runs.map((run) => run.text).join("")).toBe(japanese);
  });

  test("空串不崩，也不产出换行", () => {
    const runs = spacedRuns("", ZH_HANS, 20);
    expect(runs).toEqual([{ text: "", gapAfter: 0, breakAfter: false, hangEm: 0 }]);
  });

  test("短到放得下的一行不换行", () => {
    const runs = spacedRuns("短句。", ZH_HANS, 40);
    expect(runs.some((run) => run.breakAfter)).toBe(false);
  });
});
