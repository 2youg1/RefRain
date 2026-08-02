import { describe, expect, test } from "bun:test";

import { PIPE_CLASS, tableLayout, tablePieces } from "../src/table-render.ts";

/**
 * 表格切分。与 Rust 侧 `TableShape::of` 判据一致——两边都要判是因为消费者
 * 不同：Rust 侧决定「这块是什么类型」，这里决定「怎么画」。
 */

const TABLE = "| 概念 | 提出者 | 年份 |\n|---|---|---|\n| 风景的发现 | 柄谷行人 | 1980 |";

describe("表格切分", () => {
  test("认出三列", () => {
    const layout = tableLayout(TABLE);
    expect(layout).not.toBeNull();
    expect((layout as NonNullable<typeof layout>).columnWidths.length).toBe(3);
  });

  test("单元格位置指向原文，不复制内容", () => {
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    const first = layout.cells[0] as NonNullable<(typeof layout.cells)[number]>;
    // 切分只给位置。内容留在块文本里，复制一份就会有第二个权威。
    expect(TABLE.slice(first.start, first.end)).toBe(" 概念 ");
  });

  test("列宽按显示当量算——CJK 占两格", () => {
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    // 「 风景的发现 」= 空格 + 五汉字 + 空格 = 1 + 10 + 1 = 12 当量。
    expect(layout.columnWidths[0]).toBe(12);
    // 「 1980 」= 1 + 4 + 1 = 6，比表头「 年份 」的 1+4+1 = 6 一样宽。
    expect(layout.columnWidths[2]).toBe(6);
  });

  test("列宽量原文不 trim——单元格前后的空格真的占位置", () => {
    // 这条守的是一个实测缺陷：trim 后再算列宽，各行 minWidth 一模一样而屏幕
    // 上的列依然错开（80px vs 96px），因为作者写的 `| 概念 |` 里那两个空格
    // 真的会进 DOM。门禁 verify:table-render 判据 1 抓到的正是它。
    const padded = "|  甲  |\n|---|\n| 乙 |";
    const layout = tableLayout(padded) as NonNullable<ReturnType<typeof tableLayout>>;
    // 「  甲  」= 2 + 2 + 2 = 6。trim 版本会得到 2。
    expect(layout.columnWidths[0]).toBe(6);
  });

  test("分隔行不参与列宽，但必须接受列宽", () => {
    // 两件事容易被当成一件：「不参与计算」推不出「不需要宽度」。只给非分隔行
    // 设 minWidth 时，分隔行四段各 24px 挤在左侧，表格看起来断成两截（实测）。
    // 这里断的是切分侧的契约——分隔行的单元格必须带着正确的 column 出来，
    // 渲染侧才有据可依。
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    const delimiterCells = layout.cells.filter((cell) => cell.row === layout.delimiterRow);
    expect(delimiterCells.length).toBe(layout.columnWidths.length);
    expect(delimiterCells.map((cell) => cell.column)).toEqual([0, 1, 2]);
  });

  test("分隔行不参与列宽", () => {
    // `|---|` 里的横线若算进列宽，窄内容的列会被撑成三格宽。
    const narrow = "| a |\n|--------------------|\n| b |";
    const layout = tableLayout(narrow) as NonNullable<ReturnType<typeof tableLayout>>;
    // 「 a 」= 3 当量。若分隔行参与计算，这一列会被那 20 根横线撑成 20。
    expect(layout.columnWidths[0]).toBe(3);
  });

  test("首尾竖线可省，两种写法列数相同", () => {
    const withEdges = tableLayout("| 甲 | 乙 |\n|---|---|\n| 1 | 2 |");
    const without = tableLayout("甲 | 乙\n---|---\n1 | 2");
    expect(withEdges).not.toBeNull();
    expect(without).not.toBeNull();
    expect((withEdges as NonNullable<typeof withEdges>).columnWidths.length).toBe(
      (without as NonNullable<typeof without>).columnWidths.length,
    );
  });

  test("中间的空单元格保留，不塌掉一列", () => {
    // `| a |  | c |` 中间那格是作者留白，丢掉会让这一行少一列，
    // 后面的列全部左移一位。
    const layout = tableLayout("| a |  | c |\n|---|---|---|\n| 1 | 2 | 3 |");
    expect(layout).not.toBeNull();
    expect((layout as NonNullable<typeof layout>).columnWidths.length).toBe(3);
  });

  test("不是表格的返回 null", () => {
    expect(tableLayout("| 只有表头 |")).toBeNull();
    expect(tableLayout("他说|我说|大家说\n----")).toBeNull();
    expect(tableLayout("普通段落没有竖线")).toBeNull();
    // 第二行不是分隔行。
    expect(tableLayout("甲 | 乙\n丙 | 丁")).toBeNull();
  });

  test("单元格覆盖原文且互不重叠——一个字节都没加", () => {
    // 这条是整个模块的不变量：切分是定位，不是改写。补空格对齐会让
    // textContent 与源码错开，光标随之失准。
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    let sampled = 0;
    for (const cell of layout.cells) {
      expect(cell.start).toBeGreaterThanOrEqual(0);
      expect(cell.end).toBeLessThanOrEqual(TABLE.length);
      expect(cell.start).toBeLessThanOrEqual(cell.end);
      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(6);
    // 按行分组后，同一行的单元格必须依次推进，不能交叉。
    for (let row = 0; row <= 2; row += 1) {
      const inRow = layout.cells.filter((cell) => cell.row === row);
      for (let index = 0; index < inRow.length - 1; index += 1) {
        const current = inRow[index] as NonNullable<(typeof inRow)[number]>;
        const next = inRow[index + 1] as NonNullable<(typeof inRow)[number]>;
        expect(current.end).toBeLessThanOrEqual(next.start);
      }
    }
  });
});

describe("竖线成段", () => {
  /** 把切出的段按原文下标拼回来——画进 DOM 的每一段都必须出自原文。 */
  const reassemble = (text: string): string => {
    const layout = tableLayout(text) as NonNullable<ReturnType<typeof tableLayout>>;
    return tablePieces(text, layout)
      .map((piece) =>
        piece.kind === "cell"
          ? text.slice(piece.cell.start, piece.cell.end)
          : text.slice(piece.start, piece.end),
      )
      .join("");
  };

  test("所有段拼回来逐字节等于原文——包 span 不加一个字节", () => {
    // 这条钉的是 textContent 不变量：DOM 侧的门禁是 verify:table-render 判据 2，
    // 这里测的是它的纯函数一半——段拼得回去，画出来才逐字节相同。
    // 验红：让 pushGap 丢掉竖线，拼接当场短一截。
    expect(reassemble(TABLE)).toBe(TABLE);
    // 首尾竖线可省的写法同样逐字节还原。
    const bare = "甲 | 乙\n---|---\n1 | 2";
    expect(reassemble(bare)).toBe(bare);
  });

  test("每一根竖线都是自己的段，且带着它在原文里的位置", () => {
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    const pieces = tablePieces(TABLE, layout);
    const pipes = pieces.filter((piece) => piece.kind === "pipe");
    const expected = [...TABLE.matchAll(/\|/g)].map((match) => match.index);
    // 一根不多一根不少，位置逐一对应——包括分隔行里那几根。
    expect(pipes.map((piece) => (piece.kind === "pipe" ? piece.start : -1))).toEqual(expected);
    expect(pipes.length).toBeGreaterThan(6);
  });

  test("行尾竖线的段连同换行符——换行符不做孤立文本节点", () => {
    // 换行符若独占一个文本节点，它前面是元素边界，浏览器在那个位置量不出
    // 光标矩形（实测五结构探针）。所以行尾那根竖线的段是 `"|\n"` 两个字符。
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    const pipes = tablePieces(TABLE, layout).filter((piece) => piece.kind === "pipe");
    const rowEnds = pipes.filter(
      (piece) => piece.kind === "pipe" && TABLE[piece.start + 1] === "\n",
    );
    // 三行就是三个行尾（末行行尾的竖线后没有换行）。
    expect(rowEnds.length).toBe(2);
    for (const piece of rowEnds) {
      expect(piece.kind === "pipe" ? piece.end - piece.start : 0).toBe(2);
    }
    // 其他任何段都不以换行符开头。
    for (const piece of tablePieces(TABLE, layout)) {
      const start = piece.kind === "cell" ? piece.cell.start : piece.start;
      expect(TABLE[start]).not.toBe("\n");
    }
  });

  test("段首尾相接、按位置升序——没有空洞也没有重叠", () => {
    const layout = tableLayout(TABLE) as NonNullable<ReturnType<typeof tableLayout>>;
    let cursor = 0;
    for (const piece of tablePieces(TABLE, layout)) {
      const start = piece.kind === "cell" ? piece.cell.start : piece.start;
      const end = piece.kind === "cell" ? piece.cell.end : piece.end;
      expect(start).toBe(cursor);
      cursor = end;
    }
    expect(cursor).toBe(TABLE.length);
  });

  test("竖线段的类名是 CSS 的唯一钩子", () => {
    // 改类名必须同时改 surfaces.css——这里钉住的是交接面。
    expect(PIPE_CLASS).toBe("md-table-pipe");
  });
});
