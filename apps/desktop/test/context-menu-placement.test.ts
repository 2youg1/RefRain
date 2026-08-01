import { describe, expect, test } from "bun:test";
import { placeContextMenu } from "../src/shell/context-menu-placement";

const viewport = { width: 800, height: 600 };
const menu = { width: 160, height: 184 };

const overlaps = (
  placement: { x: number; y: number; width: number; height: number },
  anchor: { left: number; top: number; right: number; bottom: number },
): boolean =>
  placement.x < anchor.right &&
  placement.x + placement.width > anchor.left &&
  placement.y < anchor.bottom &&
  placement.y + placement.height > anchor.top;

describe("context menu placement", () => {
  test("uses the right side when it is available", () => {
    const anchor = { left: 300, top: 240, right: 360, bottom: 260 };
    const placed = placeContextMenu(anchor, { x: 330, y: 250 }, viewport, menu);
    expect(placed.x).toBeGreaterThan(anchor.right);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("flips left at the right edge", () => {
    const anchor = { left: 720, top: 240, right: 780, bottom: 260 };
    const placed = placeContextMenu(anchor, { x: 750, y: 250 }, viewport, menu);
    expect(placed.x + placed.width).toBeLessThan(anchor.left);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("moves above when horizontal space is unavailable near the bottom", () => {
    const anchor = { left: 4, top: 560, right: 796, bottom: 580 };
    const placed = placeContextMenu(anchor, { x: 400, y: 570 }, viewport, menu);
    expect(placed.y + placed.height).toBeLessThan(anchor.top);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("shrinks to a small viewport and stays inside its edges", () => {
    const placed = placeContextMenu(
      { left: 140, top: 100, right: 180, bottom: 120 },
      { x: 160, y: 110 },
      { width: 240, height: 180 },
      menu,
    );
    expect(placed.width).toBeLessThanOrEqual(216);
    expect(placed.height).toBeLessThanOrEqual(156);
    expect(placed.x).toBeGreaterThanOrEqual(12);
    expect(placed.y).toBeGreaterThanOrEqual(12);
    expect(placed.x + placed.width).toBeLessThanOrEqual(228);
    expect(placed.y + placed.height).toBeLessThanOrEqual(168);
  });
});

/*
 * 上面四条断言的都是「不压住选区」，而作者报的问题是**菜单压住正文**。
 * 两者不是同一个命题：让开那几个划中的字、正落在下一段上，四条全绿而三行
 * 正文被腰斩。所以下面这组量的是版心，不是锚点。
 */
describe("context menu keeps clear of the text column", () => {
  const column = { left: 300, right: 700, top: 80, bottom: 560 };
  const wide = { width: 1440, height: 900 };

  const overlapsColumn = (placed: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): boolean =>
    placed.x < column.right &&
    placed.x + placed.width > column.left &&
    placed.y < column.bottom &&
    placed.y + placed.height > column.top;

  test("stands outside the column when the column leaves room beside it", () => {
    // 版心 400/1440 ≈ 28%，两侧都放得下：菜单没有理由压在字上。
    const anchor = { left: 420, top: 300, right: 520, bottom: 320 };
    const placed = placeContextMenu({ anchor, column }, { x: 470, y: 310 }, wide, menu);
    expect(overlapsColumn(placed)).toBe(false);
  });

  test("clears the column even when the selection sits at its left edge", () => {
    // 贴左缘选中时，「锚点右侧」正好落在版心正中——旧实现返回的就是这一处。
    const anchor = { left: 302, top: 120, right: 340, bottom: 140 };
    const placed = placeContextMenu({ anchor, column }, { x: 320, y: 130 }, wide, menu);
    expect(overlapsColumn(placed)).toBe(false);
  });

  test("still returns a placement when the column fills the viewport", () => {
    /*
     * 版心占满时无处可躲，压是唯一选择——这一条把上面两条限定成「有地方就让开」，
     * 而不是「永远不许重叠」。少了它，实现可以靠返回视口外的坐标骗过前两条。
     */
    const full = { left: 0, right: 1440, top: 0, bottom: 900 };
    const anchor = { left: 700, top: 400, right: 760, bottom: 420 };
    const placed = placeContextMenu({ anchor, column: full }, { x: 730, y: 410 }, wide, menu);
    expect(placed.x).toBeGreaterThanOrEqual(12);
    expect(placed.y).toBeGreaterThanOrEqual(12);
    expect(placed.x + placed.width).toBeLessThanOrEqual(wide.width - 12);
    expect(placed.y + placed.height).toBeLessThanOrEqual(wide.height - 12);
  });

  test("accepts a bare rectangle, so callers without a column still work", () => {
    const anchor = { left: 300, top: 240, right: 360, bottom: 260 };
    const placed = placeContextMenu(anchor, { x: 330, y: 250 }, viewport, menu);
    expect(placed.x).toBeGreaterThan(anchor.right);
  });
});
