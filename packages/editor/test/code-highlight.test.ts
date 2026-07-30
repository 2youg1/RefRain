/**
 * 语法高亮：文档 §7 门禁清单里能在单元层问清楚的那几条。
 *
 * 零出网、无 WASM、无 dynamic chunk 是**产物**层面的事实，归 `verify:no-network`；
 * 这里问的是模块自身的行为。
 */

import { describe, expect, test } from "bun:test";

import {
  codeThemeFor,
  forgetHighlights,
  isHighlightable,
  tokenizeCode,
} from "../src/code-highlight";

describe("语言集显式有限", () => {
  test("注册过的认得，含别名", () => {
    expect(isHighlightable("rust")).toBe(true);
    expect(isHighlightable("typescript")).toBe(true);
    expect(isHighlightable("ts")).toBe(true);
    expect(isHighlightable("  Rust  ")).toBe(true);
  });

  test("没注册的语言降级为纯文本，而不是报错或去加载", async () => {
    expect(isHighlightable("cobol")).toBe(false);
    // 返回空数组＝调用方按纯文本渲染。不抛异常，不发起任何加载。
    await expect(tokenizeCode("IDENTIFICATION DIVISION.", "cobol")).resolves.toEqual([]);
    await expect(tokenizeCode("x", "")).resolves.toEqual([]);
  });
});

describe("着色本身", () => {
  test("CJK 完整保留：注释、标识符、字符串都不被切坏", async () => {
    const source = 'fn main() {\n    let 说明 = "全角「引号」也要对";\n}';
    const lines = await tokenizeCode(source, "rust");
    const text = lines.map((line) => line.map((token) => token.text).join("")).join("\n");
    expect(text).toBe(source);
    expect(text).toContain("说明");
    expect(text).toContain("「引号」");
  });

  test("同一段代码的字符逐字往返无损", async () => {
    // 模板插值本身是要测的语法，用转义写出来以免被读成误写的模板字面量。
    const source = "const 名前 = `模板 \u0024{x} 字符串`;";
    const lines = await tokenizeCode(source, "typescript");
    expect(
      lines
        .flat()
        .map((token) => token.text)
        .join(""),
    ).toBe(source);
  });

  test("token 带得回颜色，注释与关键字不同色", async () => {
    const lines = await tokenizeCode("// 注释\nlet x = 1;", "rust");
    const colors = new Set(lines.flat().map((token) => token.color));
    // 至少要分出注释、关键字、数字几档，否则等于没上色。
    expect(colors.size).toBeGreaterThan(2);
  });

  test("行数与源码一致——高亮不改变行数，估高才不必为它调整", async () => {
    const source = "a\nb\nc\nd";
    expect((await tokenizeCode(source, "bash")).length).toBe(4);
  });
});

describe("默认代码配色按界面主题挑", () => {
  test("夜间两套配夜间代码色，切换时不跳色", () => {
    expect(codeThemeFor("sumi")).toBe("vitesse-dark");
    expect(codeThemeFor("shao")).toBe("vitesse-dark");
  });

  test("日间五套配日间代码色", () => {
    for (const theme of ["tou", "kasumi", "suna", "hua", "wabi"]) {
      expect(codeThemeFor(theme)).toBe("vitesse-light");
    }
  });

  test("没见过的主题名不至于崩，落到日间", () => {
    expect(codeThemeFor("")).toBe("vitesse-light");
  });
});

describe("缓存", () => {
  test("同一段代码问两次给同一个结果对象，说明没重算", async () => {
    forgetHighlights();
    const first = await tokenizeCode("let x = 1;", "rust");
    const second = await tokenizeCode("let x = 1;", "rust");
    expect(second).toBe(first);
  });

  test("换了配色就不能命中旧色的缓存", async () => {
    forgetHighlights();
    const light = await tokenizeCode("let x = 1;", "rust", "vitesse-light");
    const dark = await tokenizeCode("let x = 1;", "rust", "vitesse-dark");
    expect(dark).not.toBe(light);
    // 同一段代码在两套配色下颜色必须真的不同，否则缓存键形同虚设。
    expect(dark.flat()[0]?.color).not.toBe(light.flat()[0]?.color);
  });

  test("清掉之后重算，不留旧文档的颜色", async () => {
    const before = await tokenizeCode("let x = 1;", "rust");
    forgetHighlights();
    const after = await tokenizeCode("let x = 1;", "rust");
    expect(after).not.toBe(before);
    expect(after).toEqual(before);
  });
});
