/**
 * 标点悬挂接线：`hangingAt` 的判定要出现在渲染层，且**只在日文预设**出现。
 *
 * 这个文件盯的是「引擎有、接线无」的第三次——`measure` 的挤压量漏过一次，
 * `optimizedLineStarts` 的断点漏过一次，`hangingAt` 是第三个写完之后在产品里
 * 零调用的出口（调用者此前只有 `packages/typeset/test` 与
 * `scripts/verify-preset-divergence.ts`）。
 *
 * 语料是实测选出来的，不是随手写的。`em=16` 时这段日文切成 6 行，其中 **2 行**
 * 的行尾是句读点（其余四档各只有 1 行）。分档断言先断样本数大于 0 的理由就在
 * 这里：若语料一行都挂不了，下面每一条断言都会在「没有可挂的行」上空转而
 * 全绿。
 */

import { describe, expect, test } from "bun:test";
import { JA, ZH_HANS, ZH_HANT } from "@refrain/typeset";
import { spacedRuns } from "../src/inter-script-spacing.ts";

/** 夏目漱石《吾輩は猫である》开篇。选它是因为句读点分布密，各档都能切出可挂行。 */
const JA_TEXT =
  "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。";

/** 同样密度的中文语料。中文横排默认不悬挂（CLREQ §6.1.3），用来验「不该挂的不挂」。 */
const ZH_TEXT =
  "我是一只猫。还没有名字。完全不知道生在何处。只记得在一个昏暗潮湿的地方喵喵地哭着。我在那里第一次见到了人这种东西。";

/** 实测过的版心：这一档日文有两行可挂，区分力最好。 */
const MEASURE_EM = 16;

const hangs = (runs: readonly { readonly hangEm: number }[]) =>
  runs.filter((run) => run.hangEm !== 0);

describe("标点悬挂接线", () => {
  test("日文预设：行尾是句读点的行挂出 0.5em", () => {
    const runs = spacedRuns(JA_TEXT, JA, MEASURE_EM);
    const hung = hangs(runs);

    // 先断样本数。没有这一条，下面的 every 在空数组上恒真。
    expect(hung.length).toBeGreaterThan(0);
    for (const run of hung) {
      expect(run.hangEm).toBe(0.5);
      // 挂出去的必须是这一段的最后一个字符，而它必须是句读点。
      expect(["。", "、"]).toContain([...run.text].at(-1));
    }
  });

  test("中文横排：一行都不挂", () => {
    for (const preset of [ZH_HANS, ZH_HANT]) {
      const runs = spacedRuns(ZH_TEXT, preset, MEASURE_EM);
      // 先确认这段中文确实被切成了多行，否则「不挂」是因为没有行可挂。
      expect(runs.filter((run) => run.breakAfter).length).toBeGreaterThan(0);
      expect(hangs(runs)).toEqual([]);
    }
  });

  test("同一段文本在日文与中文预设下悬挂结果不同", () => {
    // 这一条是上面两条的合取，但它测的是**区分**本身：如果哪天悬挂被做成
    // 一个跨语言的全局开关，上面两条会各自变红，而这一条说清楚了为什么。
    const ja = hangs(spacedRuns(JA_TEXT, JA, MEASURE_EM));
    const zh = hangs(spacedRuns(JA_TEXT, ZH_HANS, MEASURE_EM));
    expect(ja.length).toBeGreaterThan(0);
    expect(zh.length).toBe(0);
  });

  test("段中间的句读点不挂，只有行尾才挂", () => {
    // 悬挂的对象是**行**的最后一个字符。段中间的句读点后面还跟着同一行的
    // 内容，挂出去会把后半行的字压上来。
    //
    // 这条语料是穷举出来的，不是随手写的。第一版我以为「句读点 + 拉丁文」
    // 会切出这种段，实测**不会**——引擎认为句读点自带的后置空白已经够了,
    // 不再加混排间距。于是那条守卫在最初的语料上一次都没执行，注入「段中间
    // 也挂」时测试全绿。
    //
    // 穷举句读点之后的各类字符后找到：`。「`、`。《`、`。。` 这类**句读点接
    // 开括号或另一个标点**会产生 −0.5em 的挤压切点（CLREQ §6.3.2 的连续标点
    // 压缩），切点正落在句读点之后。这是真实的日文写法。
    const text =
      "吾輩は猫である。「名前はまだ無い」と彼は言った。『どこで生れたか』、とんと見当がつかぬ。";
    const runs = spacedRuns(text, JA, MEASURE_EM);

    const midStops = runs.filter(
      (run, index) =>
        index !== runs.length - 1 &&
        !run.breakAfter &&
        ["。", "、"].includes([...run.text].at(-1) ?? ""),
    );
    // 先断样本数：没有这一条，下面的 every 在空数组上恒真——那正是第一版的
    // 状态。
    expect(midStops.length).toBeGreaterThan(0);
    for (const run of midStops) expect(run.hangEm).toBe(0);
  });

  test("不给版心宽度时只有段末那一个行尾", () => {
    // 悬挂是「排版第 8 步，断点稳定之后」。没有版心宽度就不断行，全段是一行,
    // 于是只剩段末那一个行尾——它仍然是行尾。
    //
    // 这条最初写作「没有行尾可挂」，实现落地后它红了。**红的是测试不是实现**：
    // 一个不折行的段落仍然有最后一行，段末的句读点仍然挂在版心边上。按原样
    // 改实现（不给版心就一律不挂）会让段末标点在窄版心下挂、在宽版心下不挂,
    // 而两种情况下它都是同一行的同一个位置。
    const runs = spacedRuns(JA_TEXT, JA, 0);
    expect(runs.filter((run) => run.breakAfter).length).toBe(0);
    expect(hangs(runs).length).toBe(1);
    expect(hangs(runs)[0]).toBe(runs.at(-1));
  });

  test("悬挂不改变任何字符", () => {
    // 与间距、断行同一条铁律：拼回去必须逐字等于原文。
    for (const [text, preset] of [
      [JA_TEXT, JA],
      [ZH_TEXT, ZH_HANS],
    ] as const) {
      const runs = spacedRuns(text, preset, MEASURE_EM);
      expect(runs.map((run) => run.text).join("")).toBe(text);
    }
  });

  test("最后一行的行尾也参与悬挂判定", () => {
    // 段末那个字符不在任何「下一行行首减一」里——它是段落的最后一个下标。
    // 第一版漏掉它时这段日文仍有别的可挂行，测试照样全绿，所以单点一条。
    const runs = spacedRuns(JA_TEXT, JA, MEASURE_EM);
    const last = runs.at(-1);
    expect(last).toBeDefined();
    expect([...(last?.text ?? "")].at(-1)).toBe("。");
    expect(last?.hangEm).toBe(0.5);
  });
});
