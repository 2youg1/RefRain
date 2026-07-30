/**
 * 面板的方向与时长：两个值只有一个来源。
 */

import { describe, expect, test } from "bun:test";

import {
  PANEL_MOTION_MS,
  PANEL_STILL_MS,
  panelMotion,
  prefersReducedMotion,
} from "../src/shell/panel-motion";

describe("panelMotion", () => {
  test("左侧栈从左边进来，右侧栈从右边进来", () => {
    expect(panelMotion("left", true, false).enterFrom).toBe("-100%");
    expect(panelMotion("right", true, false).enterFrom).toBe("100%");
  });

  test("开着动画是 300ms 左右，关掉是 1ms 而不是 0", () => {
    expect(panelMotion("left", true, false).duration).toBe(PANEL_MOTION_MS);
    // 0 会让「关掉动画」走上另一条没有过渡的代码路径；1ms 保留同一条。
    expect(panelMotion("left", false, false).duration).toBe(PANEL_STILL_MS);
    expect(PANEL_STILL_MS).toBeGreaterThan(0);
  });

  test("系统要求减少动态效果时，应用内开关不能把它覆盖回去", () => {
    expect(panelMotion("left", true, true).duration).toBe(PANEL_STILL_MS);
  });

  test("缓动是先快后慢：前半段就走完大半路程", () => {
    const easing = panelMotion("left", true, false).easing;
    const [x1, y1] =
      /cubic-bezier\(([\d.]+),\s*([\d.]+)/.exec(easing)?.slice(1, 3).map(Number) ?? [];
    // 第一个控制点在对角线之上（y1 > x1）就是减速曲线。反过来会让界面读起来在拖。
    expect(y1).toBeGreaterThan(x1 as number);
  });

  test("没有 matchMedia 的环境按「不要求减少动效」算，不当作故障", () => {
    const original = globalThis.matchMedia;
    Reflect.deleteProperty(globalThis, "matchMedia");
    expect(prefersReducedMotion()).toBe(false);
    if (original) globalThis.matchMedia = original;
  });
});
