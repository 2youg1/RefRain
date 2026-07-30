/**
 * 块级前缀的切换语义。
 *
 * 逐条对应一个作者会撞到的情形，而不是逐条对应一个函数分支：
 * 按两次标题要回到原文、把标题改成引用不能叠成 `> # `、
 * 一段里夹着空行不能得到孤零零的 `- `。
 */
import { describe, expect, test } from "bun:test";
import { applyBlockPrefix, type BlockPrefix, blockPrefixState } from "../src/block-prefix";

// 域从类型取：凭记忆列的表恰好会漏掉忘了的那个。
const EVERY_PREFIX = [
  "heading-1",
  "heading-2",
  "heading-3",
  "quote",
  "bullet-list",
  "ordered-list",
] as const satisfies readonly BlockPrefix[];

describe("block prefixes toggle", () => {
  test.each(EVERY_PREFIX)("%s applied twice returns the original text", (prefix) => {
    const original = "第一行\n第二行";
    const once = applyBlockPrefix(original, prefix);
    expect(once).not.toBeNull();
    expect(once).not.toBe(original);
    expect(blockPrefixState(once as string, prefix)).toBe("on");
    expect(applyBlockPrefix(once as string, prefix)).toBe(original);
  });

  test.each(EVERY_PREFIX)("%s reports off on plain text", (prefix) => {
    expect(blockPrefixState("剑没有松。", prefix)).toBe("off");
  });

  test("a partially marked range reads as mixed and completing it marks every line", () => {
    const text = "# 章一\n正文";
    expect(blockPrefixState(text, "heading-1")).toBe("mixed");
    // mixed 视作「作者想要全部都有」——与行内标记同理。
    expect(applyBlockPrefix(text, "heading-1")).toBe("# 章一\n# 正文");
  });

  test("switching prefixes replaces rather than stacks", () => {
    // 一行不能既是标题又是引用：作者只表达了后一个意图。
    const heading = applyBlockPrefix("章一", "heading-2") as string;
    expect(heading).toBe("## 章一");
    expect(applyBlockPrefix(heading, "quote")).toBe("> 章一");
  });

  test("an ordered list numbers its own lines", () => {
    expect(applyBlockPrefix("甲\n乙\n丙", "ordered-list")).toBe("1. 甲\n2. 乙\n3. 丙");
  });

  test("an existing list style is recognised rather than doubled", () => {
    // 作者手写的 `*` 与 `+` 是同一个前缀的合法形态。
    for (const written of ["* 甲", "+ 甲", "- 甲"]) {
      expect(blockPrefixState(written, "bullet-list")).toBe("on");
      expect(applyBlockPrefix(written, "bullet-list")).toBe("甲");
    }
    for (const written of ["1. 甲", "2) 甲"]) {
      expect(blockPrefixState(written, "ordered-list")).toBe("on");
    }
  });

  test("blank lines neither block the state nor collect a stray prefix", () => {
    const text = "甲\n\n乙";
    expect(blockPrefixState(text, "quote")).toBe("off");
    expect(applyBlockPrefix(text, "quote")).toBe("> 甲\n\n> 乙");
  });

  test("nothing to mark refuses instead of writing an empty prefix", () => {
    // 全空行时返回 null，调用方据此让命令失效，而不是写出一个 "- " 空行。
    expect(applyBlockPrefix("", "bullet-list")).toBeNull();
    expect(applyBlockPrefix("\n  \n", "quote")).toBeNull();
  });

  test("heading levels do not read each other as their own", () => {
    // `## ` 不是 `# `：级别是作者选的，切换二级不该把三级也算进来。
    const two = applyBlockPrefix("章一", "heading-2") as string;
    expect(blockPrefixState(two, "heading-2")).toBe("on");
    expect(blockPrefixState(two, "heading-3")).toBe("off");
  });
});
