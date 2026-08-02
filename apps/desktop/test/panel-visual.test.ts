/**
 * 面板几何与材质：两条视觉规格的算术，不必开窗口就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { materialSpec, supportedMaterial } from "../src/shell/panel-material";
import { PANEL_WIDTH, panelLayout, panelReserve } from "../src/shell/panel-spine";

describe("面板几何", () => {
  test("正文让开的宽度＝几层就是几份生效面板宽", () => {
    // 没有面板时不让：版心不该被平白推走。
    expect(panelReserve(0)).toBe("0px");
    // 让位是一个 calc：深度写死，宽度跟变量走——拖动改变量时让位不用重算。
    expect(panelReserve(1)).toBe(`calc(var(--panel-width, ${PANEL_WIDTH}px) * 1)`);
    // 让不够的话，行首会被切掉。
    expect(panelReserve(3)).toBe(`calc(var(--panel-width, ${PANEL_WIDTH}px) * 3)`);
  });

  test("负数与乱数不产生负让位", () => {
    expect(panelReserve(-2)).toBe("0px");
  });

  test("让位与「开着」必须同时给出，否则作者看到的是错位", () => {
    expect(panelLayout(0, false)).toEqual({
      "data-panels": "closed",
      style: { "--panel-reserve": "0px", display: undefined },
    });
    expect(panelLayout(2, false)["data-panels"]).toBe("open");
    // 舞台整个让位时，布局照常给出，只是不显示。
    expect(panelLayout(2, true).style.display).toBe("none");
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
