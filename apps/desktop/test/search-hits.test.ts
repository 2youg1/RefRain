import { describe, expect, test } from "bun:test";

import { excerptAround, splitOnQuery } from "../src/ui/search-excerpt";

describe("搜索命中的片段", () => {
  test("查询词被切出来，两侧的话原样留着", () => {
    const pieces = splitOnQuery("第二段里有风景的发现这个说法", "风景的发现");
    expect(pieces).toEqual([
      { text: "第二段里有", matched: false },
      { text: "风景的发现", matched: true },
      { text: "这个说法", matched: false },
    ]);
  });

  test("同一段里出现两次就标两次", () => {
    const pieces = splitOnQuery("甲说风景，乙也说风景。", "风景");
    expect(pieces.filter((piece) => piece.matched).length).toBe(2);
    // 拼回去必须逐字等于原文——切分不能吞字也不能加字。
    expect(pieces.map((piece) => piece.text).join("")).toBe("甲说风景，乙也说风景。");
  });

  test("空查询不把整段染成命中", () => {
    // 作者清空搜索框的那一刻，`indexOf("")` 在每个位置都命中。
    // 不挡住这一条，整篇文章会瞬间全部标黄。
    const pieces = splitOnQuery("一段普通的话", "   ");
    expect(pieces).toEqual([{ text: "一段普通的话", matched: false }]);
  });

  test("查询词不在文本里时原样返回", () => {
    expect(splitOnQuery("一段普通的话", "不存在")).toEqual([
      { text: "一段普通的话", matched: false },
    ]);
  });

  test("命中在末尾也不会被截断掉", () => {
    // 从头截断是最容易写出的实现，而它恰好切掉作者要找的那个词——
    // 那是他点开这一条的唯一理由。
    const long = `${"铺垫".repeat(40)}风景的发现`;
    const excerpt = excerptAround(long, "风景的发现", 20);
    expect(excerpt).toContain("风景的发现");
    expect(excerpt.length).toBeLessThan(long.length);
  });

  test("短文本不加省略号", () => {
    expect(excerptAround("很短的一段", "短", 60)).toBe("很短的一段");
  });

  test("裁过的片段仍然能被正确切分", () => {
    const long = `${"铺垫".repeat(40)}风景的发现${"收尾".repeat(40)}`;
    const pieces = splitOnQuery(excerptAround(long, "风景的发现", 24), "风景的发现");
    expect(pieces.some((piece) => piece.matched && piece.text === "风景的发现")).toBe(true);
  });
});
