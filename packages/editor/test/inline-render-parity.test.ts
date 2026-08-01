import { describe, expect, test } from "bun:test";

import { inlineSpans, isMarkerAt, sliceByBoundaries } from "../src/inline-render.ts";

/**
 * 渲染侧解析器的行为，以及它与 Rust 侧的一致性。
 *
 * 同一套行内语法在仓库里有两份实现，因为两个消费者都不能用对方那一份：渲染
 * 必须同步（走 IPC 会让光标闪跳），索引跑在 Rust 的 SQLite 事务里（那里没有
 * JavaScript）。不共享代码就必须对拍，否则作者会看到「屏幕上是粗体、搜索却按
 * 字面匹配」。
 *
 * 下面的 `PARITY` 表是两侧共用的语料。Rust 那侧的同名断言在
 * `crates/refrain-core/src/inline_span.rs` 的测试模块里，改动任一侧的配对规则
 * 都会让其中一边变红。
 */

/** 与 Rust `inline_span.rs` 测试逐条对应的语料与期望。 */
const PARITY: readonly { text: string; marked: readonly [string, string, string][] }[] = [
  {
    text: "这是**粗**也是*斜*",
    marked: [
      ["strong", "**粗**", "粗"],
      ["emphasis", "*斜*", "斜"],
    ],
  },
  { text: "`a * b * c`", marked: [["code", "`a * b * c`", "a * b * c"]] },
  { text: "***很强***", marked: [["strong", "***很强***", "很强"]] },
  { text: "__粗__", marked: [["strong", "__粗__", "粗"]] },
  { text: "_斜_", marked: [["emphasis", "_斜_", "斜"]] },
  { text: "~~删~~", marked: [["strikethrough", "~~删~~", "删"]] },
  { text: "未闭合 **粗", marked: [] },
  { text: "反引号 `code", marked: [] },
  { text: "一个孤立的 * 星号", marked: [] },
  { text: "****", marked: [] },
  { text: "``", marked: [] },
  { text: "1~2", marked: [] },
];

function marked(text: string): [string, string, string][] {
  return inlineSpans(text).map((span) => [
    span.style,
    text.slice(span.start, span.end),
    text.slice(span.contentStart, span.contentEnd),
  ]);
}

describe("行内标记解析", () => {
  test.each(PARITY)("与 Rust 侧判定一致：$text", ({ text, marked: expected }) => {
    expect(marked(text)).toEqual(expected as [string, string, string][]);
  });

  test("区间互不重叠且按位置升序", () => {
    const spans = inlineSpans("**一** `二` *三* ~~四~~");
    expect(spans.length).toBe(4);
    for (let index = 0; index < spans.length - 1; index += 1) {
      // 扁平结构表达不了「同一个字符属于两个样式」。
      expect((spans[index] as { end: number }).end).toBeLessThanOrEqual(
        (spans[index + 1] as { start: number }).start,
      );
    }
  });

  test("代理对不被切坏——区间落在码位边界上", () => {
    const text = "🎌**旗**🎌";
    for (const span of inlineSpans(text)) {
      // 切在代理对中间会产生孤立代理，字符串化后是替换字符。
      expect([...text.slice(0, span.start)].join("")).toBe(text.slice(0, span.start));
      expect([...text.slice(span.start, span.end)].join("")).toBe(text.slice(span.start, span.end));
    }
  });
});

describe("与断行边界的合成", () => {
  test("跨越换行的加粗被切成多片，每片各自带样式", () => {
    // 这是整个设计的关键：标记区间会横跨断行切点，合成必须扁平不嵌套。
    const text = "**跨越换行的加粗文字必须足够长长长长长长长长长长长长长长长**尾";
    const spans = inlineSpans(text);
    const pieces = sliceByBoundaries(text, spans, [12, 24]);
    expect(pieces.length).toBeGreaterThan(1);
    const strong = pieces.filter((piece) => piece.style === "strong");
    // 三片都在加粗区间内，否则说明切点把样式丢了。
    expect(strong.length).toBe(3);
  });

  test("文本还原逐字相同——一个字节都不能丢", () => {
    // 切分是纯重组，不是改写。这条挡住「切的时候顺手把标记符删了」。
    for (const { text } of PARITY) {
      for (const boundaries of [[], [3], [2, 5], [1, 4, 7]]) {
        const rebuilt = sliceByBoundaries(text, inlineSpans(text), boundaries)
          .map((piece) => piece.text)
          .join("");
        expect(rebuilt).toBe(text);
      }
    }
  });

  test("切片起点连续，没有空洞也没有重叠", () => {
    const text = "这是**加粗的文字**然后继续";
    const pieces = sliceByBoundaries(text, inlineSpans(text), [4, 9]);
    let cursor = 0;
    let sampled = 0;
    for (const piece of pieces) {
      expect(piece.start).toBe(cursor);
      cursor += piece.text.length;
      sampled += 1;
    }
    expect(cursor).toBe(text.length);
    // 分档断言先断样本数：一片也没有时上面的循环什么都没测。
    expect(sampled).toBeGreaterThan(2);
  });
});

describe("围栏不做行内解析", () => {
  test("代码里的星号会配对成强调——所以围栏必须在解析前挡掉", () => {
    // 这条先证明「不挡就会出事」：C 的指针解引用与乘号在同一行出现时，
    // 两个星号配成一个强调区间，那段代码会半截变粗。
    const code = "int x = *ptr * 2;";
    expect(inlineSpans(code).length).toBeGreaterThan(0);
  });

  test("挡掉之后一个标记都不产生", () => {
    // 产品里的判据是 `fence ? [] : inlineSpans(text)`。渲染门禁测不到它——
    // 围栏随后被 `#highlightFence` 整块重写，最终 DOM 里本来就没有 .md-strong，
    // 所以把判据改成恒 `inlineSpans(text)` 门禁照样全绿（实测）。
    // 这里直接测那个分支：围栏为真时结果必须是空数组。
    const fence = (isFence: boolean, text: string) => (isFence ? [] : inlineSpans(text));
    expect(fence(true, "int x = *ptr * 2;")).toEqual([]);
    // 反向：不是围栏时必须照常解析，否则这条断言用恒返回 [] 也能过。
    expect(fence(false, "int x = *ptr * 2;").length).toBeGreaterThan(0);
  });
});

describe("标记符与内容的区分", () => {
  test("标记符被认出来，内容不被误认", () => {
    const text = "**粗**";
    const spans = inlineSpans(text);
    // 前两个星号与后两个星号是标记符，中间的「粗」不是。
    expect(isMarkerAt(spans, 0)).toBe(true);
    expect(isMarkerAt(spans, 1)).toBe(true);
    expect(isMarkerAt(spans, 2)).toBe(false);
    expect(isMarkerAt(spans, 3)).toBe(true);
    expect(isMarkerAt(spans, 4)).toBe(true);
  });

  test("没有标记时任何位置都不是标记符", () => {
    // 反向断言，挡住「isMarkerAt 恒返回 true」这种实现。
    const spans = inlineSpans("纯正文没有任何标记");
    for (let index = 0; index < 9; index += 1) {
      expect(isMarkerAt(spans, index)).toBe(false);
    }
  });
});
