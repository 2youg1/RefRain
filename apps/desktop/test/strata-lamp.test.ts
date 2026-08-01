/** Stratum order and distinct side/overhead lamp geometry. */

import { describe, expect, test } from "bun:test";

import {
  type LampKind,
  type LampPlacement,
  lampFacing,
  lampPlacement,
  type PanelSide,
} from "../src/shell/lamp";
import { STRATA, strataDeclarations, stratum } from "../src/shell/strata";

/** 点着的灯必有位置；拿不到位置就是这条测试失败，而不是类型问题。 */
function lit(kind: Exclude<LampKind, "off">, side: PanelSide = "left"): LampPlacement {
  const place = lampPlacement(kind, side);
  expect(place).not.toBeNull();
  return place as LampPlacement;
}

describe("层的次序", () => {
  test("自下而上：正文、光、四区、书脊、菜单", () => {
    expect(stratum("manuscript")).toBeLessThan(stratum("lamp"));
    expect(stratum("lamp")).toBeLessThan(stratum("quarter"));
    expect(stratum("quarter")).toBeLessThan(stratum("spine"));
    expect(stratum("spine")).toBeLessThan(stratum("menu"));
  });

  test("STRATA 是自下而上的", () => {
    const values = STRATA.map(stratum);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  test("每层都出现在生成的变量里，且样式表能拿到数字", () => {
    const css = strataDeclarations();
    for (const name of STRATA) {
      expect(css).toContain(`--z-${name}: ${stratum(name)};`);
    }
  });
});

describe("灯有位置", () => {
  test("不点灯就没有位置", () => {
    expect(lampPlacement("off", "left")).toBeNull();
  });

  test("单侧灯挂在面板那一侧，翻转面板就换边", () => {
    const left = lit("side", "left");
    const right = lit("side", "right");
    expect(left.x).toBeLessThan(0);
    expect(right.x).toBeGreaterThan(1);
    expect(lampFacing(left)).toBe(1);
    expect(lampFacing(right)).toBe(-1);
  });

  test("全侧灯居中且在头顶之上，没有侧向", () => {
    const overhead = lit("overhead");
    expect(overhead.x).toBe(0.5);
    expect(overhead.y).toBeLessThan(0);
    expect(lampFacing(overhead)).toBe(0);
  });

  test("侧灯照不到对面的角落，顶灯照全场", () => {
    // 照不到的那个角落，正是「光有位置」唯一能被眼睛读到的证据。
    expect(lit("side").reach).toBeLessThan(1);
    expect(lit("overhead").reach).toBeGreaterThan(1);
  });
});
