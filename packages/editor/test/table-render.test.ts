import { describe, expect, test } from "bun:test";

import { tableLayout } from "../src/table-render.ts";

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
