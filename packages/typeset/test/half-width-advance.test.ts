import { describe, expect, test } from "bun:test";

import { advanceOf, measure, optimizedLineStarts, presetOf } from "../src/index.ts";

/**
 * 字符宽度必须与它画出来的一样宽。
 *
 * 这组测试守的是一个曾经真实存在的偏差：宽度判定借用了**间距**的分类
 * （`kind === "latin" || "digit" || "space"`），而 ASCII 标点在 `classOf` 里
 * 落到 `other` 兜底，于是每一个 `*`、`` ` ``、`#` 都按全角 1em 计算。
 *
 * 平时看不出来，因为正文很少连着写 ASCII 标点。Markdown 标记符进入正文渲染
 * 之后它每段都会出现：`**加粗**` 的四个星号被算成 4em 而实际约 2em，那一行
 * 因此少放两个字。
 */

const preset = presetOf("zh-Hans");

function advanceFor(character: string): number {
  const measured = measure(character, preset);
  const first = measured[0];
  expect(first).toBeDefined();
  return advanceOf(first as NonNullable<typeof first>);
}

describe("半角宽度", () => {
  test("Markdown 标记符占半个字身，不是一个", () => {
    // 这四个是 Markdown 正文渲染真正会遇到的。它们的 `kind` 都是 `other`
    // ——测试断的是宽度，不是分类，正因为两者曾被绑在一起。
    for (const marker of ["*", "`", "#", ">"]) {
      expect(advanceFor(marker)).toBe(0.5);
    }
  });

  test("表意文字与全角标点仍占一个字身", () => {
    // 反向断言。只断半角会放过「把所有字符都改成 0.5」这种修法。
    for (const wide of ["中", "あ", "，", "。", "「"]) {
      expect(advanceFor(wide)).toBe(1);
    }
  });

  test("西文字母与数字不受影响——它们本来就是半角", () => {
    for (const narrow of ["A", "z", "7"]) {
      expect(advanceFor(narrow)).toBe(0.5);
    }
  });

  test("标记符的宽度真的进了断行：一行装得下多出来的那两个字", () => {
    // 这条是整组测试的目的。前面三条只证明谓词算得对，这条证明断行器**用了**
    // 它——把 `advanceOf` 换回旧算式时，这里的第一行会少两个字。
    const text = "这是**加粗的文字**然后继续写下去还要更长一些才会换行呢";
    const measured = measure(text, preset);
    const starts = [...optimizedLineStarts(measured, preset, 12)];

    const second = starts[1];
    expect(second).toBeDefined();

    let width = 0;
    for (let index = 0; index < (second as number); index += 1) {
      width += advanceOf(measured[index] as NonNullable<(typeof measured)[number]>);
    }
    // 四个星号按半角计，第一行正好填满版心。按全角计只能到 10em。
    expect(width).toBe(12);
    expect(second).toBe(14);
  });

  test("行宽从不超出版心", () => {
    // 宽度改小之后最需要担心的是反向错误：算得比实际窄，行就会溢出。
    const text = "混排 English **bold** 与 `code` 交替出现的一段文字用来检查版心";
    const measured = measure(text, preset);
    for (const em of [8, 12, 16, 20]) {
      const starts = [...optimizedLineStarts(measured, preset, em)];
      let sampled = 0;
      for (let line = 0; line < starts.length; line += 1) {
        const from = starts[line] as number;
        const to = starts[line + 1] ?? measured.length;
        let width = 0;
        for (let index = from; index < to; index += 1) {
          width += advanceOf(measured[index] as NonNullable<(typeof measured)[number]>);
        }
        // 行首不计前导空白，与断行器同规则。
        expect(width).toBeLessThanOrEqual(em + 0.001);
        sampled += 1;
      }
      // 分档断言先断样本数：版心 8em 时若一行都没断出来，上面的循环什么也没测。
      expect(sampled).toBeGreaterThan(1);
    }
  });
});
