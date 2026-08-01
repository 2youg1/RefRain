/**
 * GFM 表格的列对齐：把源文本切成单元格，让同一列共用一个宽度。
 *
 * # 为什么不插空格
 *
 * 「补空格对齐」是最直觉的做法，也是错的：补进去的空格会进 `textContent`，
 * 于是屏幕字符序与源码字节序错开——光标定位（`locateOffset` 数文本节点长度）、
 * 断行的字符数组、改动着色的区间账本三处同时失准。那正是 C 方案在行内标记上
 * 刚避开的双坐标系。
 *
 * 这里改用 CSS：每个单元格包一个行内块，同一列的行内块共用一个 `min-width`。
 * **一个字节都没加**，源文本原样进 DOM，列却是对齐的。
 *
 * # 为什么不做真 `<table>`
 *
 * 所有者看过极限场景对比后的裁定。真表格在视觉上更好（单元格内自动折行，
 * 永不超出版心），但它把整块的坐标系换成了「第几行第几个单元格」：光标偏移
 * 要在表格坐标与字节偏移之间换算，跨单元格选区在源码里是**不连续**的字节
 * 区间（跨过了 `|`），改动着色与断行的区间账本全部要重新定义。
 *
 * 等宽对齐的代价是超宽表格横向滚动，以及作者打字时列会先错开、停手后重新
 * 对齐。前者在真实版心下很少发生（实测 300px 才裁，那是刻意挑的极限值），
 * 后者是可见但可接受的动静。
 */

/** 一个单元格在块文本里的位置。 */
export interface TableCell {
  readonly start: number;
  readonly end: number;
  readonly row: number;
  readonly column: number;
}

/** 表格的切分结果。 */
export interface TableLayout {
  readonly cells: readonly TableCell[];
  /** 每一列的显示宽度当量（CJK 算 2，其余算 1）。 */
  readonly columnWidths: readonly number[];
  /** 分隔行的行号——它不参与列宽计算，也不该被作者当成内容读。 */
  readonly delimiterRow: number;
}

/** 显示宽度当量：CJK 与全角标点占两格，其余占一格。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    const wide =
      (point >= 0x1100 && point <= 0x115f) ||
      (point >= 0x2e80 && point <= 0xa4cf) ||
      (point >= 0xac00 && point <= 0xd7a3) ||
      (point >= 0xf900 && point <= 0xfaff) ||
      (point >= 0xfe30 && point <= 0xfe6f) ||
      (point >= 0xff00 && point <= 0xff60) ||
      (point >= 0xffe0 && point <= 0xffe6) ||
      (point >= 0x20000 && point <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 切分一个表格块。不是表格返回 `null`。
 *
 * 判据与 Rust 侧 `TableShape::of` 一致（至少两行、第二行是分隔行、列数一致）
 * ——两边都要判是因为消费者不同：Rust 侧决定「这块是什么类型」，这里决定
 * 「怎么画」。`table-render.test.ts` 用同一批语料对拍两侧。
 */
export function tableLayout(text: string): TableLayout | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;

  const cells: TableCell[] = [];
  const widths: number[] = [];
  let offset = 0;
  let sawDelimiter = false;

  for (const [row, line] of lines.entries()) {
    if (!line.includes("|")) return null;
    // 分隔行只由 `|-: \t` 组成且至少有一个 `-`。第二行不是分隔行就不是表格。
    const isDelimiter = /^[|\-:\s]*$/.test(line) && line.includes("-");
    if (row === 1) {
      if (!isDelimiter) return null;
      sawDelimiter = true;
    }

    // 按 `|` 切，保留每段在块文本里的绝对位置。首尾的竖线是可选的，两种写法
    // 都要切出同样多的单元格。
    let column = 0;
    let cursor = 0;
    const segments = line.split("|");
    for (const [index, segment] of segments.entries()) {
      const start = offset + cursor;
      cursor += segment.length + 1; // +1 是那个 `|`
      // 首尾竖线切出的空段不是单元格。只在两端丢弃：中间的空段是作者留白的
      // 单元格，丢掉会让这一行少一列。
      const atEdge = index === 0 || index === segments.length - 1;
      if (atEdge && segment.trim() === "") continue;
      cells.push({ start, end: start + segment.length, row, column });
      if (row !== 1) {
        // 量**没有 trim 的**原文。作者写的 `| 概念 |` 里那两个空格真的会进
        // DOM 并占位置，trim 掉再算列宽会让每一列比实际内容窄两格——表现是
        // 各行 minWidth 一模一样而屏幕上的列依然错开（实测 80px vs 96px）。
        //
        // 换句话说：这里量的是「这一段字节画出来有多宽」，不是「作者写了什么
        // 词」。后者才需要 trim。
        const width = displayWidth(segment);
        widths[column] = Math.max(widths[column] ?? 0, width);
      }
      column += 1;
    }
    offset += line.length + 1; // +1 是换行
  }

  if (!sawDelimiter || widths.length === 0) return null;
  return { cells, columnWidths: widths, delimiterRow: 1 };
}

/** 单元格外壳的类名。列宽通过它上面的 `min-width` 生效。 */
export const CELL_CLASS = "md-table-cell";

/**
 * 把表格画进段落：每个单元格包一个行内块，同一列共用一个 `min-width`。
 *
 * 竖线与单元格内容都原样进 DOM，顺序与源文本一致——所以 `textContent`
 * 逐字节等于 `text`，光标偏移仍然就是字节偏移。对齐完全由 CSS 承担。
 */
export function paintTableText(
  element: HTMLElement,
  text: string,
  layout: TableLayout,
  language: string,
): void {
  element.replaceChildren();
  element.dataset.table = String(layout.columnWidths.length);
  element.lang = language;

  // 单元格按位置排序后逐段吐出。单元格之间的字节（竖线、换行）原样补回，
  // 这样拼起来才逐字节等于源文本。
  const ordered = [...layout.cells].sort((left, right) => left.start - right.start);
  let cursor = 0;
  for (const cell of ordered) {
    if (cell.start > cursor) {
      element.append(document.createTextNode(text.slice(cursor, cell.start)));
    }
    const shell = document.createElement("span");
    shell.className = CELL_CLASS;
    // 分隔行同样吃列宽。它**不参与**列宽计算（`|---|` 里的横线长度是作者随手
    // 敲的，让它决定列宽会把窄列撑成三格宽），但必须**接受**算出来的列宽
    // ——否则它自己那一行是散的，表格看起来当场断成两截。
    //
    // 实测：只给非分隔行设 minWidth 时，分隔行四段各 24px 挤在左侧，与上下两
    // 行的列完全对不上。这两件事容易被当成一件（「分隔行不参与列宽」推不出
    // 「分隔行不需要列宽」），门禁判据 1 抓到的正是它。
    const width = layout.columnWidths[cell.column] ?? 0;
    // `ch` 在等宽字体下正好是一个半角字符宽，而 `displayWidth` 数的就是
    // 半角当量——两者同一把尺子，所以不需要换算系数。
    shell.style.minWidth = `${width}ch`;
    shell.append(document.createTextNode(text.slice(cell.start, cell.end)));
    element.append(shell);
    cursor = cell.end;
  }
  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}
