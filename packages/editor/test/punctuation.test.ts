import { describe, expect, test } from "bun:test";
import { applyPunctuationFinding, findPunctuation } from "../src/punctuation";

describe("punctuation suggestions", () => {
  test("suggests one Chinese punctuation replacement without changing the source", () => {
    const source = "你好,世界. 下一句?";
    const findings = findPunctuation("b1", source);
    expect(findings.map(({ original, suggested }) => [original, suggested])).toEqual([
      [",", "，"],
      [".", "。"],
      ["?", "？"],
    ]);
    expect(source).toBe("你好,世界. 下一句?");
    const first = findings[0];
    if (first === undefined) throw new Error("expected one finding");
    expect(applyPunctuationFinding(source, first)).toBe("你好，世界. 下一句?");
  });

  test("suggests full-width punctuation in English prose", () => {
    const findings = findPunctuation("b2", "Hello，world！");
    expect(findings.map(({ original, suggested }) => [original, suggested])).toEqual([
      ["，", ","],
      ["！", "!"],
    ]);
  });

  test("does not touch URLs, decimals, abbreviations, inline code, or fenced code", () => {
    expect(findPunctuation("url", "见 https://example.com/a,b?x=1.2")).toEqual([]);
    expect(findPunctuation("decimal", "版本 v1.2.3 与 3.14 不变")).toEqual([]);
    expect(findPunctuation("abbr", "Use e.g. this form, not i.e. that one.")).toEqual([]);
    expect(findPunctuation("inline", "运行 `foo(a,b);` 即可")).toEqual([]);
    expect(findPunctuation("fence", "```ts\nfoo(a,b);\n```")).toEqual([]);
  });

  test("refuses a stale finding instead of replacing another occurrence", () => {
    const [finding] = findPunctuation("b3", "甲,乙");
    if (finding === undefined) throw new Error("expected one finding");
    expect(() => applyPunctuationFinding("甲；乙", finding)).toThrow("source changed");
  });
});
