/**
 * 就地 diff 的向量。
 *
 * 钉住的是三件事：区间落在改动本身而不是整段、两种呈现模式**产生可见不同**、
 * 以及着色会消退。第二条最重要——两种模式若渲染相同，那个区分就是装饰。
 */

import { describe, expect, test } from "bun:test";

import { diffAge, diffSpans, forPresentation } from "../src/index.ts";

describe("差异区间", () => {
  test("只标改动本身，不标整段", () => {
    const before = "这一段里只有中间几个字被改掉了，其余照旧。";
    const after = "这一段里只有中间几个词被改掉了，其余照旧。";
    const spans = diffSpans(before, after);

    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (span === undefined) throw new Error("expected one span");
    expect(span.kind).toBe("added");
    expect(after.slice(span.start, span.end)).toBe("词");
    // 区间必须远小于整段，否则「就地标出改动」退化成「整段变色」。
    expect(span.end - span.start).toBeLessThan(after.length / 4);
  });

  test("相同文本没有区间", () => {
    expect(diffSpans("一模一样", "一模一样")).toEqual([]);
  });

  test("纯插入落在插入处", () => {
    const spans = diffSpans("他说完就走了。", "他说完这句话就走了。");
    const span = spans[0];
    if (span === undefined) throw new Error("expected one span");
    expect("他说完这句话就走了。".slice(span.start, span.end)).toBe("这句话");
  });

  test("纯删除标一个零宽记号——不标的话版面上完全看不见", () => {
    const spans = diffSpans("他说完这句话就走了。", "他说完就走了。");
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (span === undefined) throw new Error("expected one span");
    expect(span.kind).toBe("removed");
    expect(span.end).toBe(span.start);
  });

  test("代理对不被从中间切开", () => {
    // emoji 与增补平面汉字在 UTF-16 里占两格。按格比前后缀会切进代理对中间，
    // 产出两个坏字符的区间——而那个区间套进 Range 会抛错或画错位置。
    const before = "他说🙂然后走了";
    const after = "他说🙃然后走了";
    const spans = diffSpans(before, after);
    const span = spans[0];
    if (span === undefined) throw new Error("expected one span");
    const sliced = after.slice(span.start, span.end);
    expect(sliced).toBe("🙃");
    // 切出来的必须是完整码位：长度 2（一个代理对）而不是 1（半个）。
    expect([...sliced]).toHaveLength(1);
  });

  test("重复字符不把前后缀数重", () => {
    // `aa` → `aaa` 时公共前缀与公共后缀会争夺同一个字符。数重的话区间为空，
    // 而那与「没有改动」输出相同。
    const spans = diffSpans("aa", "aaa");
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (span === undefined) throw new Error("expected one span");
    expect(span.end - span.start).toBe(1);
  });
});

describe("两种呈现模式", () => {
  test("普通模式保留删除标记，Kara 不保留——两者必须可见不同", () => {
    // 这条是整个区分的存在理由。两种模式渲染相同的话，Kara 就只是普通模式
    // 换了个名字，而「减少视觉扰动」这个目的一点也没达成。
    //
    // 验红：把 forPresentation 改成直接 `return spans`，此断言失败。
    const spans = diffSpans("他说完这句话就走了。", "他说完就走了。");
    const marks = forPresentation(spans, "marks");
    const result = forPresentation(spans, "result");

    expect(marks).not.toEqual(result);
    expect(marks.some((span) => span.kind === "removed")).toBe(true);
    expect(result.some((span) => span.kind === "removed")).toBe(false);
  });

  test("新增的改动两种模式都显示——Kara 不是「不显示改动」", () => {
    // Kara 照常接受智能体的改动，只是不堆叠增删标记。把它做成「什么都不显示」
    // 是另一个错误，这条断言挡住它。
    const spans = diffSpans("他说完就走了。", "他说完这句话就走了。");
    expect(forPresentation(spans, "result")).toHaveLength(1);
    expect(forPresentation(spans, "marks")).toEqual(forPresentation(spans, "result"));
  });

  test("两种模式读同一份判定，不各算各的", () => {
    // 若两边各算一次 diff，同一处改动可能标出不同范围，而那种不一致没有任何
    // 东西会报错。这条把「同一份输入」钉住。
    const spans = diffSpans("原来的文字在这里", "现在的文字在这里");
    for (const span of forPresentation(spans, "result")) {
      expect(spans).toContainEqual(span);
    }
  });
});

describe("着色消退", () => {
  test("三档随时间推进，最后归零", () => {
    const changedAt = 1_000_000;
    expect(diffAge(changedAt, changedAt)).toBe("fresh");
    expect(diffAge(changedAt, changedAt + 5_000)).toBe("fresh");
    expect(diffAge(changedAt, changedAt + 10_000)).toBe("settling");
    // 必须消退：改过二十次的稿子若每处都永久着色，颜色标出的是「这份稿子
    // 被改过」——一句作者早就知道的话。
    expect(diffAge(changedAt, changedAt + 60_000)).toBeNull();
  });

  test("时钟倒退不崩，按最新处理", () => {
    expect(diffAge(1_000_000, 999_000)).toBe("fresh");
  });
});
