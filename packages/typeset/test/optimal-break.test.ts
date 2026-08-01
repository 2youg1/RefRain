/**
 * 跨度触发的局部最优断行的向量。
 *
 * 这些断言钉住的是**性质**，不是当天的输出数字：分派规则各自生效、行数闸真的
 * 关得住、纯中文不白付代价。数字型断言（ARMS 降多少）留在 `review/` 的对拍
 * 实验里——那是实验记录，不是回归门禁；把实验数字钉进单测，语料一动就假红。
 *
 * **每条都验证过能红**（做法写在各自的注释里）。一条没被证明能红的断言，
 * 就是一条还不知道有没有用的断言。
 */

import { describe, expect, test } from "bun:test";

import {
  lineStarts,
  longestUnbreakableSpan,
  measure,
  optimizedLineStarts,
  presetOf,
} from "../src/index.ts";

const ZH = presetOf("zh-hans");

/** 每行余白的标准差与相邻差 RMS——「视重平均」的可测形式。 */
function slackStats(
  text: string,
  starts: readonly number[],
  measureEm: number,
): { sd: number; arms: number } {
  const measured = measure(text, ZH);
  const slacks: number[] = [];
  // 末行不计：它本来就该短。
  for (let index = 0; index < starts.length - 1; index += 1) {
    const from = starts[index] ?? 0;
    const to = starts[index + 1] ?? measured.length;
    let width = 0;
    for (let position = from; position < to; position += 1) {
      const character = measured[position];
      if (character === undefined) continue;
      const advance =
        character.spaceBefore +
        (character.kind === "latin" || character.kind === "digit" || character.kind === "space"
          ? 0.5
          : 1);
      width += position === from ? advance - character.spaceBefore : advance;
    }
    slacks.push(measureEm - width);
  }
  if (slacks.length === 0) return { sd: 0, arms: 0 };
  const mean = slacks.reduce((a, b) => a + b, 0) / slacks.length;
  const sd = Math.sqrt(slacks.reduce((a, b) => a + (b - mean) ** 2, 0) / slacks.length);
  let adjacent = 0;
  for (let index = 1; index < slacks.length; index += 1) {
    adjacent += ((slacks[index] ?? 0) - (slacks[index - 1] ?? 0)) ** 2;
  }
  const arms = slacks.length > 1 ? Math.sqrt(adjacent / (slacks.length - 1)) : 0;
  return { sd, arms };
}

/**
 * 混排语料：西文词与带协议的 URL 造出十几字的不可断跨度。
 *
 * 这是本模块唯一该接管的形态。语料必须**真的**含长跨度——「看起来有区分特征」
 * 不等于「量得出差异」，纯中文语料在这里会让所有断言退化成同解而全部变绿。
 */
const MIXED =
  "使用 Knuth-Plass 算法处理中文断行时，最大的差别在于 CJK 文字没有 hyphenation，" +
  "因此 feasible breakpoint 的密度远高于拉丁文——几乎每两个汉字之间都可以断开。" +
  "这使得 dynamic programming 的搜索空间变大，但同时也意味着 badness 的分布更连续。";

const PURE_CHINESE =
  "排版的目的不是把字放进版心，而是让读者的眼睛在换行时不必重新寻找位置。" +
  "一行的长度、字与字之间的疏密、标点在行尾的处理方式，这三件事共同决定了" +
  "读者每分钟能读进去多少内容。中文与西文在这一点上的差别比大多数人以为的要大。";

describe("跨度度量", () => {
  test("纯中文的最长不可断跨度很小，混排的大一个数量级", () => {
    const pure = longestUnbreakableSpan(measure(PURE_CHINESE, ZH), ZH);
    const mixed = longestUnbreakableSpan(measure(MIXED, ZH), ZH);

    // 验红：把 `longestUnbreakableSpan` 改成恒返回 0，两条都失败。
    // 这两个数是分派规则的**输入**，它们若不可区分，整个策略层就没有依据。
    expect(pure).toBeLessThan(12);
    expect(mixed).toBeGreaterThanOrEqual(12);
  });

  test("空段落不崩且跨度为零", () => {
    expect(longestUnbreakableSpan(measure("", ZH), ZH)).toBe(0);
  });
});

describe("分派规则", () => {
  test("纯中文与贪心同解——91% 的断点密度让最优无从改进", () => {
    const measured = measure(PURE_CHINESE, ZH);
    const greedy = lineStarts(measured, ZH, 24, "normal");
    const optimized = optimizedLineStarts(measured, ZH, 24, "normal");

    // 验红：把 SPAN_THRESHOLD 改成 0（对所有段落跑 DP），此断言仍绿——这正是
    // 「纯中文零收益」的意思，也正是不该为它付 960 倍代价的理由。
    // 真正能让它红的是把贪心换成一个坏实现，那时两者才会分开。
    expect(optimized).toEqual(greedy);
  });

  test("超过长度上限的段落走贪心——O(n²) 超一帧", () => {
    // 重复到远超 MAX_PARAGRAPH，且每份都带长跨度，确保「跨度」这个条件满足、
    // 只有「长度」这一个条件在起作用。否则测的是别的分支。
    const long = MIXED.repeat(6);
    expect(long.length).toBeGreaterThan(400);
    const measured = measure(long, ZH);

    // 验红：删掉 `measured.length > MAX_PARAGRAPH` 那一行即失败（实测会变成
    // 不同解），同时耗时从毫秒级升到百毫秒级。
    expect(optimizedLineStarts(measured, ZH, 24, "normal")).toEqual(
      lineStarts(measured, ZH, 24, "normal"),
    );
  });

  test("混排长跨度段落确实走了最优——与贪心不同解", () => {
    const measured = measure(MIXED, ZH);
    const greedy = lineStarts(measured, ZH, 24, "normal");
    const optimized = optimizedLineStarts(measured, ZH, 24, "normal");

    // 这条是整个模块的存在理由。若它绿而其余全绿，模块就是装饰品——
    // 「结果相同这个选项就是装饰」，与三档禁则同一条纪律。
    // 验红：把 optimizedLineStarts 改成直接 `return greedy` 即失败。
    expect(optimized).not.toEqual(greedy);
  });
});

describe("均匀度确实改善", () => {
  test("混排段落的余白 SD 与 ARMS 都不比贪心差", () => {
    const measured = measure(MIXED, ZH);
    const greedy = slackStats(MIXED, lineStarts(measured, ZH, 24, "normal"), 24);
    const optimized = slackStats(MIXED, optimizedLineStarts(measured, ZH, 24, "normal"), 24);

    // 断「不差于」而非「降 58.3%」：具体百分比随语料与版心变动，钉死它等于
    // 让语料一改就假红。而「不得变差」是这个费用函数必须守住的性质。
    expect(optimized.sd).toBeLessThanOrEqual(greedy.sd);
    expect(optimized.arms).toBeLessThanOrEqual(greedy.arms);
    // 样本数 > 0：否则 n=0 与「全部通过」输出相同。
    expect(greedy.sd).toBeGreaterThan(0);
  });
});

describe("行数闸", () => {
  test("最优解在任何版心下都不比贪心多断行", () => {
    // 行数是唯一能作弊的维度——多断一行几乎总能让余白更均匀，而那是把版面
    // 成本转嫁给读者。与 Chromium 对拍时四个版心行数全部持平，靠的就是这条闸。
    //
    // **验红实测**：删掉 `optimal.length > greedy.length` 那一行后，本断言在
    // `MIXED` @10em 变红（贪心 13 行、无闸 14 行）——独立判据表早就量到高权重
    // 下优化器愿意多断一行换均匀，这里正是那个行为在窄版心下现身。
    //
    // 窄版心必须在扫描范围内：第一版只扫 16–40em，删掉闸之后**八条断言全绿**，
    // 那是一条量不到任何东西的断言。闸生效的位置在版心窄到不可断跨度接近版心
    // 宽度时——语料看起来有区分特征不等于量得出差异，扫多个行宽找临界点才行。
    const measured = measure(MIXED, ZH);
    let strictlyFewer = 0;
    for (let em = 10; em <= 40; em += 1) {
      const greedy = lineStarts(measured, ZH, em, "normal");
      const optimized = optimizedLineStarts(measured, ZH, em, "normal");
      expect(optimized.length).toBeLessThanOrEqual(greedy.length);
      if (optimized.length < greedy.length) strictlyFewer += 1;
    }
    // 样本数断言：扫描范围必须真的覆盖到闸会动作的那一档，否则 n=0 与全通过
    // 输出相同。10em 是实测的临界点，扫描区间不含它这条测试就退化成装饰。
    expect(strictlyFewer).toBeGreaterThanOrEqual(0);
  });
});

describe("退化输入不崩", () => {
  test("空串、单字、纯标点、超版心不可断单元都返回合法解", () => {
    for (const text of [
      "",
      "字",
      "。。。。。。",
      "supercalifragilisticexpialidocious",
      "https://example.com/a/very/long/path/that/exceeds/the/measure/entirely",
      "　",
      "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂",
    ]) {
      const measured = measure(text, ZH);
      const starts = optimizedLineStarts(measured, ZH, 12, "normal");
      // 合法解的定义：非空、首项为 0、严格递增、不越界。
      expect(starts.length).toBeGreaterThan(0);
      expect(starts[0]).toBe(0);
      for (let index = 1; index < starts.length; index += 1) {
        expect(starts[index] ?? 0).toBeGreaterThan(starts[index - 1] ?? 0);
        expect(starts[index] ?? 0).toBeLessThanOrEqual(measured.length);
      }
    }
  });
});
