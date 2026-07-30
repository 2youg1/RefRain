/**
 * 名录长到十万条时，侧栏只挂着看得见的那几十行。
 *
 * 这里不复用手稿那套 Fenwick 树：手稿的块高各不相同，前缀和必须被索引起来；
 * 名录的每一行是同一个高度，第 n 行的位置就是 n×行高。把变高结构套上来，
 * 得到的是一个每次都返回同一个乘法的树。
 *
 * 行高的权威在 CSS（`--rail-row`），由外壳读一次传进来——它是排版决定，
 * 不是这里的常数；两处各写一遍就会在改样式那天错位。
 */

/** 窗口外多挂几行，好让滚动不追着挂载跑。 */
const OVERSCAN = 6;
/** 离末尾还剩这么多行时就去取下一页，不等作者撞到底。 */
const PREFETCH_ROWS = 12;

export interface RailWindow {
  /** 第一个要挂的行号。 */
  readonly first: number;
  /** 要挂几行。 */
  readonly count: number;
  /** 窗口之上被省掉的高度，撑住滚动条。 */
  readonly padTop: number;
  /** 窗口之下被省掉的高度。 */
  readonly padBottom: number;
  /** 视野已经逼近已知的最后一行，该取下一页了。 */
  readonly nearEnd: boolean;
}

/**
 * 算出此刻该挂哪一段。
 *
 * 容器还没量出高度的那一帧，`viewportHeight` 是 0——那时挂 0 行会让作者看到空白，
 * 所以下限是一屏之内至少给出 overscan 那么多行。
 */
export function railWindow(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  rowHeight: number,
): RailWindow {
  const row = rowHeight > 0 ? rowHeight : 1;
  const rows = Math.max(0, Math.floor(total));
  if (rows === 0) return { first: 0, count: 0, padTop: 0, padBottom: 0, nearEnd: true };

  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  // 不给可见行数设下限：窗口两侧各留一段 overscan，容器还没量出高度的那一帧
  // 也仍会挂出 2×OVERSCAN 行。设下限只是把这件事说第二遍。
  const visible = Math.ceil(height / row);

  const first = Math.min(rows - 1, Math.max(0, Math.floor(top / row) - OVERSCAN));
  const last = Math.min(rows, first + visible + OVERSCAN * 2);
  return {
    first,
    count: last - first,
    padTop: first * row,
    padBottom: (rows - last) * row,
    nearEnd: last >= rows - PREFETCH_ROWS,
  };
}
