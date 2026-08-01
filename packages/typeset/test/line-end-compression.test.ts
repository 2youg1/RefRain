/**
 * 行尾标点的压缩量必须让**这一行多放得下那个标点**，而不是只在算宽度时打个折。
 *
 * 起因是所有者看渲染时的判词：「只要把那种因为字+逗号连接的分行取消、强行把
 * 逗号压在上一句末尾就完美了」。
 *
 * 实测「技术 em=16」是最干净的例子：
 *
 * ```
 * 现状   该函数接受一个配置对象作为参  ← 14 字，右缘缺 2
 *        数，返回一个新的实例。调用方需要
 * 应当   该函数接受一个配置对象作为参数，  ← 16 字 + 逗号压半格 = 15.5，齐平
 *        返回一个新的实例。调用方需要自行
 * ```
 *
 * 断在逗号之后是合法候选（`candidates` 里有 16），压缩后占 15.5em 也放得下——
 * GB/T 15834 §5.1.10 正是为此存在。缺的是让贪心看见这条路。
 *
 * 这不是「悬挂」。悬挂是把标点挂出版心之外（CLREQ §6.1.3 说中文多数出版物
 * 不用），压缩是让它在版心内只占半个字身，是简中的规范做法，`ZH_HANS` 的
 * `lineEndPunctuation: "compress-half"` 早就这么写了。
 */

import { describe, expect, test } from "bun:test";
import { JA, lineStarts, measure, optimizedLineStarts, ZH_HANS } from "../src/index.ts";

/** 每一行的文本，用于把断点读成人能看的东西。 */
const linesOf = (text: string, starts: readonly number[]): string[] => {
  const characters = [...text];
  return starts.map((start, index) =>
    characters.slice(start, starts[index + 1] ?? characters.length).join(""),
  );
};

/** 一行的裸宽（em），不含行尾压缩。 */
const rawWidth = (measured: ReturnType<typeof measure>, from: number, to: number): number => {
  let width = 0;
  for (let index = from; index < to; index += 1) {
    const character = measured[index];
    if (character === undefined) continue;
    width +=
      character.spaceBefore +
      (character.kind === "latin" || character.kind === "digit" || character.kind === "space"
        ? 0.5
        : 1);
  }
  return width;
};

describe("行尾标点压缩参与断行", () => {
  test("逗号压在上一行末尾，而不是连同前一个字被推到下一行", () => {
    const text = "该函数接受一个配置对象作为参数，返回一个新的实例。";
    const measured = measure(text, ZH_HANS);
    const starts = [...optimizedLineStarts(measured, ZH_HANS, 16)];
    const lines = linesOf(text, starts);

    // 第一行必须以逗号收尾。这是所有者点名的那个形态。
    expect(lines[0]).toBe("该函数接受一个配置对象作为参数，");
    // 裸宽 16 超过版心，靠 GB/T 的半格压缩才放得下——正是这条规则的用途。
    expect(rawWidth(measured, 0, starts[1] ?? 0)).toBe(16);
  });

  test("句号同样压得住", () => {
    const text = "调用方需要自行管理生命周期。在不再使用时显式释放资源。";
    const measured = measure(text, ZH_HANS);
    const lines = linesOf(text, [...optimizedLineStarts(measured, ZH_HANS, 14)]);
    expect(lines[0]).toBe("调用方需要自行管理生命周期。");
  });

  test("压缩只发生在行尾——句中的标点照常占一个字身", () => {
    // 否则整段每个标点都会缩水，读起来像字距忽宽忽窄。
    const text = "他推开门，雪停了，院子里很静。";
    const measured = measure(text, ZH_HANS);
    // 版心足够宽，整段一行：没有任何标点在行尾（除末尾那个句号，末行不压）。
    const starts = [...optimizedLineStarts(measured, ZH_HANS, 40)];
    expect(starts).toEqual([0]);
    expect(rawWidth(measured, 0, measured.length)).toBe(measured.length);
  });

  test("日文预设不压——两地规矩相反，这是两份预设存在的理由", () => {
    // JLREQ §3.1.9 保留行尾那段后置空白；简中 GB/T 15834 §5.1.10 压掉半身。
    // 这条守着「压缩」不被做成一个跨语言的全局开关。
    //
    // 语料是构造出来的，不是随手挑的：版心取 15.5em，让「15 个字 + 读点」
    // 恰好比版心多半格。简中压掉那半格就放得下，日文没有可压的，只能退。
    // 第一版我拿裸宽正好等于版心的语料来测，两种预设给出**同一个**断点
    // （压不压都放得下），那条断言什么也没测到。
    const text = `${"該".repeat(15)}、返回一個新的実例。`;
    const japanese = [...optimizedLineStarts(measure(text, JA), JA, 15.5)];
    const chinese = [...optimizedLineStarts(measure(text, ZH_HANS), ZH_HANS, 15.5)];
    // 简中把读点压进第一行（断在 16 = 读点之后）。
    expect(chinese[1]).toBe(16);
    // 日文退到读点之前，读点起下一行。
    expect(japanese[1]).toBe(14);
  });

  test("贪心与最优在这一点上一致——压缩是断行的前提，不是某条路径的优化", () => {
    const text = "该函数接受一个配置对象作为参数，返回一个新的实例。";
    const measured = measure(text, ZH_HANS);
    const greedy = [...lineStarts(measured, ZH_HANS, 16)];
    const optimal = [...optimizedLineStarts(measured, ZH_HANS, 16)];
    expect(greedy[1]).toBe(16);
    expect(optimal[1]).toBe(16);
  });
});
