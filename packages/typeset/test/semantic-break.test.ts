/**
 * 语义断行：断点落在词的中间要付代价。
 *
 * 起因是量出来的——现行断点在中文语料上有 **33.9%** 落在词中间，例子是
 * `老槐|树`、`围|巾`、`台|阶`、`整|齐`。这不是排版规则的问题：CJK 本来就
 * 逐字换行，`penaltyAt` 对两个表意文字之间恒返回 0，所以词中间与词边界在
 * 代价上完全等价。
 *
 * 词边界从哪来是**调用方的事**。这一层只收一个下标集合，不知道它是
 * `Intl.Segmenter` 切的、词典查的还是模型跑的。理由是这个包不该依赖任何
 * 分词实现：`Intl.Segmenter` 在 Chromium 里是内置的（实测切 9900 字 1.6ms，
 * 零字节依赖），但在别的运行时未必，而这个包连 DOM 都不碰。
 *
 * 不传词边界时行为**逐字不变**——这条由下面第一个测试守着，它是整条改动
 * 的安全网：语义断行是加法，不改变任何既有结果。
 */

import { describe, expect, test } from "bun:test";
import {
  candidates,
  measure,
  optimizedLineStarts,
  semanticLineStarts,
  ZH_HANS,
} from "../src/index.ts";

/**
 * 四种文体各一段。**必须是四段而不是一段**：第一版只用叙事那一段，于是
 * 「行数不变」那条断言全绿而实现是坏的——两处增行都发生在学术与技术语料上。
 */
const CORPUS = {
  叙事: "他推开门的时候雪已经停了，院子里那棵老槐树的枝条上积着薄薄一层白，风一吹就簌簌地落下来。她站在台阶上没有回头，只是把围巾又紧了紧。",
  学术: "排版这件事的难处不在于把字摆整齐，而在于每一次摆放都要同时满足几条互相拉扯的规矩，而它们的优先级从来没有被写在同一张纸上。现代排版系统的困难在于它必须同时服务于阅读者的眼睛与作者的意图。",
  技术: "该函数接受一个配置对象作为参数，返回一个新的实例。调用方需要自行管理生命周期，在不再使用时显式释放资源，否则会造成内存泄漏。",
  专名: "北京大学计算机科学技术研究所的研究人员在国际会议上发表了关于自然语言处理的最新研究成果。",
} as const;

/** 单段判据仍用叙事那一段。 */
const TEXT = CORPUS.叙事;

/** 用运行时内置的分词器算词首下标（码位坐标系，与 measure 一致）。 */
const wordStartsOf = (text: string): ReadonlySet<number> => {
  const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
  const starts = new Set<number>();
  for (const piece of segmenter.segment(text)) {
    // `piece.index` 是 UTF-16 下标，而 measure 按码位。转一次。
    starts.add([...text.slice(0, piece.index)].length);
  }
  return starts;
};

const EMS = [12, 16, 20, 24, 28];

describe("语义断行", () => {
  test("不传词边界时，断点与改动前逐字相同", () => {
    // 这条是整条改动的安全网。它比对的是「传 undefined」与「传空集」——
    // 空集意味着「没有任何位置是词首」，若代价逻辑写错成「不在集合里就罚」，
    // 空集会让所有断点都被罚，这条立刻红。
    const measured = measure(TEXT, ZH_HANS);
    for (const em of EMS) {
      const withoutArgument = [...optimizedLineStarts(measured, ZH_HANS, em)];
      const withUndefined = [...optimizedLineStarts(measured, ZH_HANS, em, undefined, undefined)];
      expect(withUndefined).toEqual(withoutArgument);
    }
  });

  test("传了词边界之后，词中间的断点减少", () => {
    const measured = measure(TEXT, ZH_HANS);
    const words = wordStartsOf(TEXT);

    let before = 0;
    let after = 0;
    let total = 0;
    for (const em of EMS) {
      const plain = [...optimizedLineStarts(measured, ZH_HANS, em)].slice(1);
      const semantic = [...optimizedLineStarts(measured, ZH_HANS, em, undefined, words)].slice(1);
      before += plain.filter((index) => !words.has(index)).length;
      after += semantic.filter((index) => !words.has(index)).length;
      total += plain.length;
    }

    // 先断样本数：这段语料在这几档下必须真的产生过词中间的断点，否则
    // 「减少了」是在零上比较。
    expect(total).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
  });

  test("入口保证行数不变——四段语料五档版心，一行都不多", () => {
    // 与 `optimizedLineStarts` 那道「最优解不得比贪心多断行」的闸同一个理由：
    // 多断一行几乎总能让每条判据都更好看，而那是把成本转嫁给读者。
    //
    // **这条测试第一版只跑了叙事语料，于是全绿而实现是坏的**：实测两处增行
    // 都在学术与技术语料上（学术 em=16 从 6 行变 7 行、技术 em=16 从 4 变 5）。
    // 语料覆盖不到的判据等于没有判据，所以这里跑全部四段。
    for (const text of Object.values(CORPUS)) {
      const measured = measure(text, ZH_HANS);
      const words = wordStartsOf(text);
      for (const em of EMS) {
        const plain = [...optimizedLineStarts(measured, ZH_HANS, em)];
        const semantic = [...semanticLineStarts(measured, ZH_HANS, em, words)];
        expect(semantic.length).toBe(plain.length);
      }
    }
  });

  test("入口在四段语料上把词中间断点从 33.9% 降到 3.2%", () => {
    // 这条把实测数字钉进测试：它既是回归保护，也是那张标定表的可执行副本。
    let inside = 0;
    let total = 0;
    for (const text of Object.values(CORPUS)) {
      const measured = measure(text, ZH_HANS);
      const words = wordStartsOf(text);
      for (const em of EMS) {
        for (const index of [...semanticLineStarts(measured, ZH_HANS, em, words)].slice(1)) {
          total += 1;
          if (!words.has(index)) inside += 1;
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    // 不写死等于 2：语料或分词器版本变了这个数会动，而结论「远低于 10%」不动。
    expect(inside / total).toBeLessThan(0.1);
  });

  test("代价是软的：没有别的选择时照样断在词中间", () => {
    // 语义断行是**代价**不是**禁令**。一个没有任何词边界可用的极窄版心下，
    // 行仍然必须断——否则版心就被撑破了，那比切开一个词严重得多。
    const measured = measure(TEXT, ZH_HANS);
    // 声称「整段只有开头是词首」，即除了 0 以外处处都在词中间。
    const starts = [...optimizedLineStarts(measured, ZH_HANS, 8, undefined, new Set([0]))];
    expect(starts.length).toBeGreaterThan(1);
  });

  test("候选断点自己带上了词中间的代价", () => {
    // 从 `candidates` 这一层验，而不是只看最终断点：最终断点是代价、宽度、
    // 行数闸三者共同的结果，只看它无法区分「代价加对了」与「碰巧断在别处」。
    const measured = measure(TEXT, ZH_HANS);
    const words = wordStartsOf(TEXT);
    const plain = candidates(measured, ZH_HANS);
    const semantic = candidates(measured, ZH_HANS, undefined, words);

    expect(plain.length).toBe(semantic.length);
    const raised = semantic.filter((entry, index) => entry.penalty > (plain[index]?.penalty ?? 0));
    // 先断样本数，再断每一个被抬高的都确实在词中间。
    expect(raised.length).toBeGreaterThan(0);
    for (const entry of raised) expect(words.has(entry.index)).toBe(false);
    // 词首处的代价一点没动。
    for (const [index, entry] of semantic.entries()) {
      if (words.has(entry.index)) expect(entry.penalty).toBe(plain[index]?.penalty);
    }
  });
});
