/**
 * 书脊与材质：两条视觉规格的算术，不必开窗口就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { materialSpec, supportedMaterial } from "../src/shell/panel-material";
import {
  PANEL_WIDTH,
  panelOffset,
  panelReserve,
  SPINE_STAGGER_MS,
  SPINE_WIDTH,
  spineLayout,
  spineSettleMs,
} from "../src/shell/panel-spine";

describe("书脊", () => {
  test("脊一条挨一条排开，展开的那层让过它们全部", () => {
    const spines = spineLayout(3);
    expect(spines.map((spine) => spine.offset)).toEqual([0, SPINE_WIDTH, SPINE_WIDTH * 2]);
    // 展开的那一层从最后一条脊之后开始，否则会压住它。
    expect(panelOffset(3)).toBe(SPINE_WIDTH * 3);
  });

  test("只有一层时没有脊，版心不被平白让走", () => {
    expect(spineLayout(0)).toEqual([]);
    expect(panelOffset(0)).toBe(0);
  });

  test("脊依次立起，读起来像书一本本上架", () => {
    const delays = spineLayout(4).map((spine) => spine.delayMs);
    expect(delays).toEqual([0, SPINE_STAGGER_MS, SPINE_STAGGER_MS * 2, SPINE_STAGGER_MS * 3]);
    // 严格递增：同时出现就没有「一层层」，只是一起闪一下。
    expect(delays.every((delay, index) => index === 0 || delay > (delays[index - 1] ?? 0))).toBe(
      true,
    );
  });

  test("整条路径立起的时间可以直接当进度用", () => {
    // 最后一条脊的延迟，加上它自己走完的时间。
    expect(spineSettleMs(4, 300)).toBe(SPINE_STAGGER_MS * 3 + 300);
    // 一层时没有错开，就是那一层的时长。
    expect(spineSettleMs(1, 300)).toBe(300);
    expect(spineSettleMs(0, 300)).toBe(300);
  });

  test("正文让开的宽度＝几条脊加展开的那一层", () => {
    // 没有面板时不让：版心不该被平白推走。
    expect(panelReserve(0)).toBe(0);
    // 一层时只有那一层的宽度，没有脊。
    expect(panelReserve(1)).toBe(PANEL_WIDTH);
    // 三层＝两条脊 + 一层。让不够的话，行首会被切掉。
    expect(panelReserve(3)).toBe(SPINE_WIDTH * 2 + PANEL_WIDTH);
  });

  test("负数与乱数不产生负偏移", () => {
    expect(panelOffset(-2)).toBe(0);
    expect(spineLayout(-1)).toEqual([]);
  });
});

describe("面板材质", () => {
  test("三档是同一件事的三种密度：越透，模糊越浅、饱和越高", () => {
    const solid = materialSpec("solid");
    const acrylic = materialSpec("acrylic");
    const liquid = materialSpec("liquid");

    expect(solid.opacity).toBe(1);
    expect(solid.blurPx).toBe(0);
    // 越透明：实心 > 亚克力 > 液态玻璃
    expect(acrylic.opacity).toBeGreaterThan(liquid.opacity);
    // 玻璃的模糊比磨砂浅，所以背后的形状带得过来——这正是两者的分别。
    expect(liquid.blurPx).toBeLessThan(acrylic.blurPx);
    // 而它靠更强的饱和与边缘高光读出厚度。
    expect(liquid.saturate).toBeGreaterThan(acrylic.saturate);
    expect(liquid.rim).toBeGreaterThan(acrylic.rim);
  });

  test("画不动 backdrop-filter 时退到实心，而不是交出一片灰", () => {
    const original = globalThis.CSS;
    Object.defineProperty(globalThis, "CSS", {
      value: { supports: () => false },
      configurable: true,
    });
    expect(supportedMaterial("liquid")).toBe("solid");
    expect(supportedMaterial("acrylic")).toBe("solid");
    Object.defineProperty(globalThis, "CSS", {
      value: { supports: () => true },
      configurable: true,
    });
    expect(supportedMaterial("liquid")).toBe("liquid");
    if (original) Object.defineProperty(globalThis, "CSS", { value: original, configurable: true });
  });

  test("完全没有 CSS.supports 的环境也不当作故障", () => {
    const original = globalThis.CSS;
    Reflect.deleteProperty(globalThis, "CSS");
    expect(supportedMaterial("liquid")).toBe("solid");
    expect(supportedMaterial("solid")).toBe("solid");
    if (original) Object.defineProperty(globalThis, "CSS", { value: original, configurable: true });
  });
});
