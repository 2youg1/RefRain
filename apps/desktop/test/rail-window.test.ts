/**
 * 名录窗口：不必挂十万个按钮就能问清楚该挂哪一段。
 */

import { describe, expect, test } from "bun:test";

import { railWindow } from "../src/shell/rail-window";

const ROW = 32;

describe("railWindow", () => {
  test("十万行只挂一屏加边", () => {
    const window = railWindow(0, 800, 100_000, ROW);
    expect(window.first).toBe(0);
    expect(window.count).toBeLessThan(60);
    // 省掉的高度必须把滚动条撑到真实长度，否则滑块位置是假的。
    expect(window.padTop + window.count * ROW + window.padBottom).toBe(100_000 * ROW);
  });

  test("滚到中段时窗口跟着走，且上方留出 overscan", () => {
    const window = railWindow(500 * ROW, 800, 100_000, ROW);
    expect(window.first).toBeLessThan(500);
    expect(window.first).toBeGreaterThan(480);
    expect(window.padTop).toBe(window.first * ROW);
  });

  test("容器还没量出高度的那一帧仍然挂出东西", () => {
    // 高度为 0 时算成空窗口，作者看到的是一片空白侧栏。
    expect(railWindow(0, 0, 500, ROW).count).toBeGreaterThan(0);
  });

  test("空名录不产生窗口", () => {
    const window = railWindow(0, 800, 0, ROW);
    expect(window.count).toBe(0);
    expect(window.padTop + window.padBottom).toBe(0);
  });

  test("逼近末尾时报出取下一页，中段不报", () => {
    expect(railWindow(0, 800, 100_000, ROW).nearEnd).toBe(false);
    expect(railWindow(99_990 * ROW, 800, 100_000, ROW).nearEnd).toBe(true);
    // 一屏装得下的短名录一开始就到底了，否则「自动加载」永远不触发。
    expect(railWindow(0, 800, 8, ROW).nearEnd).toBe(true);
  });

  test("窗口不越出名录两端", () => {
    const window = railWindow(1e9, 800, 300, ROW);
    expect(window.first + window.count).toBeLessThanOrEqual(300);
    expect(window.padBottom).toBeGreaterThanOrEqual(0);
  });

  test("行高为零不产生除零", () => {
    expect(Number.isFinite(railWindow(100, 800, 50, 0).padTop)).toBe(true);
  });
});
