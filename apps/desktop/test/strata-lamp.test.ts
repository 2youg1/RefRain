/**
 * 层与光。
 *
 * 这两组断言里最要紧的一条是「两盏灯必须不一样」。前两轮我改了两次灯，KL9 两次
 * 说看不出区别，而全部门禁一路绿灯——因为没有任何一条断言问过「side 和 overhead
 * 产生的东西是否不同」。测试通过不代表灯做对了，只代表没人问过这个问题。
 */

import { describe, expect, test } from "bun:test";

import {
  type LampKind,
  type LampPlacement,
  lampFacing,
  lampPlacement,
  type PanelSide,
  rimIntensity,
  shadowThrow,
} from "../src/shell/lamp";
import { above, STRATA, strataDeclarations, stratum } from "../src/shell/strata";

/** 点着的灯必有位置；拿不到位置就是这条测试失败，而不是类型问题。 */
function lit(kind: Exclude<LampKind, "off">, side: PanelSide = "left"): LampPlacement {
  const place = lampPlacement(kind, side);
  expect(place).not.toBeNull();
  return place as LampPlacement;
}

describe("层的次序", () => {
  test("自下而上：正文、光、四区、书脊", () => {
    expect(above("lamp", "manuscript")).toBe(true);
    expect(above("quarter", "lamp")).toBe(true);
    expect(above("spine", "quarter")).toBe(true);
  });

  test("光在正文之上、四区之下——这是「面板挡住光」得以成立的唯一原因", () => {
    expect(stratum("manuscript")).toBeLessThan(stratum("lamp"));
    expect(stratum("lamp")).toBeLessThan(stratum("quarter"));
  });

  test("菜单盖得住书脊", () => {
    // 否则右键菜单会被脊挡住，而脊只是退到后面的面板留下的痕迹。
    expect(above("menu", "spine")).toBe(true);
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

describe("两盏灯必须不一样", () => {
  const side = lit("side");
  const overhead = lit("overhead");

  test("侧灯的影子主要横着倒，顶灯的主要竖着落", () => {
    const s = shadowThrow(side, 1200);
    const o = shadowThrow(overhead, 1200);
    expect(Math.abs(s.x)).toBeGreaterThan(Math.abs(s.y));
    expect(Math.abs(o.y)).toBeGreaterThan(Math.abs(o.x));
  });

  test("影子的方向差得足够远，不是同一圈影子换了参数", () => {
    const s = shadowThrow(side, 1200);
    const o = shadowThrow(overhead, 1200);
    const angle = (v: { x: number; y: number }) => Math.atan2(v.y, v.x);
    const apart = Math.abs(angle(s) - angle(o));
    // 至少差 45 度。前两轮两盏灯的影子几乎同向，所以看着一样。
    expect(apart).toBeGreaterThan(Math.PI / 4);
  });

  test("侧灯在舞台两端造出明暗差，顶灯左右一样亮", () => {
    const sideNear = rimIntensity(side, 0.1);
    const sideFar = rimIntensity(side, 0.9);
    expect(sideNear).toBeGreaterThan(sideFar);

    expect(rimIntensity(overhead, 0.1)).toBe(rimIntensity(overhead, 0.9));
  });
});

describe("立在光里的东西", () => {
  const side = lit("side");

  test("离灯越近越亮——多层书脊因此自动有前后", () => {
    const layers = [0.08, 0.16, 0.24, 0.32].map((at) => rimIntensity(side, at));
    for (let i = 1; i < layers.length; i += 1) {
      expect(layers[i]).toBeLessThan(layers[i - 1] as number);
    }
  });

  test("灯照不到的地方就是不亮", () => {
    expect(rimIntensity(side, 2)).toBe(0);
  });

  test("衰减是平方的：第一层与第二层的差，大于第三层与第四层的差", () => {
    // 一盏灯，不是一片天光。
    const [a, b, c, d] = [0.08, 0.16, 0.24, 0.32].map((at) => rimIntensity(side, at)) as [
      number,
      number,
      number,
      number,
    ];
    expect(a - b).toBeGreaterThan(c - d);
  });
});
