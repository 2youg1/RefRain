/**
 * 混排间距的切分规则。
 *
 * 这里问的是纯数据层面的性质：切分不能改字符、间距要落在 script 边界上、
 * 代理对不能被切坏。DOM 那一半（间距元素对光标透明）由渲染门禁量，因为
 * 它只在真 contenteditable 里才有意义。
 */

import { describe, expect, test } from "bun:test";

import { JA, presetOf, ZH_HANS } from "@refrain/typeset";

import { spacedRuns } from "../src/inter-script-spacing";

const joined = (text: string, preset = ZH_HANS): string =>
  spacedRuns(text, preset)
    .map((run) => run.text)
    .join("");

describe("混排切分", () => {
  test("拼回来必须逐字等于原文", () => {
    // 这条是整个方案的地基：磁盘字节不变的前提是渲染层一个字符都没动。
    for (const text of [
      "中文abc混排english测试",
      "纯中文没有任何拉丁字母",
      "all latin no cjk at all",
      "数字 123 与中文 456 相邻",
      "",
      "a",
      "中",
      "「引用」，然后……",
    ]) {
      expect(joined(text), `原文: ${text}`).toBe(text);
    }
  });

  test("间距落在中西边界上，不落在同文种内部", () => {
    const runs = spacedRuns("中文abc混排", ZH_HANS);
    // 三段：中文 | abc | 混排，两处边界各一个间距。
    expect(runs.map((run) => run.text)).toEqual(["中文", "abc", "混排"]);
    expect(runs[0]?.gapAfter).toBeGreaterThan(0);
    expect(runs[1]?.gapAfter).toBeGreaterThan(0);
    expect(runs.at(-1)?.gapAfter).toBe(0);
  });

  test("没有混排就只有一段——纯中文段落走快路径", () => {
    // 多数段落是纯中文或纯西文，不该为它们建一串 DOM 节点。
    expect(spacedRuns("这是一段纯中文的正文。", ZH_HANS)).toHaveLength(1);
    expect(spacedRuns("A plain English paragraph.", ZH_HANS)).toHaveLength(1);
  });

  test("代理对不被切坏——按码位数，不按 UTF-16 下标", () => {
    // 增补平面汉字（𠀀 U+20000）在 UTF-16 里占两格。若用 measure 返回的
    // 数组下标去 slice 原串，就会切进代理对中间得到两个坏字符。
    const text = "𠀀abc𠀁";
    const runs = spacedRuns(text, ZH_HANS);
    expect(runs.map((run) => run.text).join("")).toBe(text);
    for (const run of runs) {
      // 落单的代理码元说明切错了。
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(run.text)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(run.text)).toBe(false);
    }
  });

  test("中日两预设给出不同的间距值", () => {
    // 相同就说明两者共用了同一张表，而那必有一边是错的：CSS Text 4 §8.4.1
    // 规范值是 1/8 ic，日文按 JIS 是 1/4 em。
    const zh = spacedRuns("中文abc", ZH_HANS)[0]?.gapAfter;
    const ja = spacedRuns("日本語abc", JA)[0]?.gapAfter;
    expect(zh).toBeGreaterThan(0);
    expect(ja).toBeGreaterThan(0);
    expect(zh, `简中 ${zh} 与日文 ${ja} 相同，说明共用了一张表`).not.toBe(ja);
  });

  test("未知语言落到简中预设，而不是抛错或不给间距", () => {
    const unknown = spacedRuns("中文abc", presetOf("kl"));
    expect(unknown[0]?.gapAfter).toBe(spacedRuns("中文abc", ZH_HANS)[0]?.gapAfter);
  });
});
