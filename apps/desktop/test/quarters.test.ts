/**
 * 四区。
 *
 * 最要紧的断言是方向性：上层可以和下层并存，**反过来不行**。一条只测了「能并存」
 * 的断言会同时被正确实现和「什么都不管」的实现通过——必须同时钉住不能做的那一半。
 */

import { describe, expect, test } from "bun:test";

import { QUARTERS, quarterForKey, takesWholeStage } from "../src/shell/quarters";

describe("层的次序", () => {
  test("四个区，不多不少", () => {
    expect(QUARTERS).toEqual(["settings", "files", "editing", "agent"]);
  });
});

describe("键盘按层走", () => {
  test("1 到 4 直达四个区", () => {
    expect(QUARTERS.map((_, i) => quarterForKey(String(i + 1)))).toEqual([...QUARTERS]);
  });

  test("没有第五层", () => {
    expect(quarterForKey("5")).toBeNull();
    expect(quarterForKey("0")).toBeNull();
    expect(quarterForKey("x")).toBeNull();
  });
});

describe("谁占满舞台", () => {
  // 这个函数决定正文还在不在屏幕上（占满时正文整行 display:none），
  // 而它此前零测试覆盖。两个方向都要钉住：只测「裁决占满」的断言，
  // 会被「一切都占满」的实现照样通过。

  test("裁决占满：逐句判断提案时，对照的是那一句，不是整篇稿子", () => {
    expect(takesWholeStage({ reference: null, stage: "review" })).toBe(true);
  });

  test("设置不占满：作者改字号时必须看得见自己的字", () => {
    // Settings must coexist with the manuscript so typography changes remain visible.
    expect(takesWholeStage({ reference: "settings", stage: "writing" })).toBe(false);
  });

  test("写作与派发都不占满", () => {
    expect(takesWholeStage({ reference: null, stage: "writing" })).toBe(false);
    expect(takesWholeStage({ reference: null, stage: "dispatch" })).toBe(false);
  });

  test("连接与批注是面板，不是场景", () => {
    expect(takesWholeStage({ reference: "connections", stage: "writing" })).toBe(false);
    expect(takesWholeStage({ reference: "annotations", stage: "writing" })).toBe(false);
  });

  test("裁决期间开着设置，仍然占满——场景压过面板", () => {
    // 两者同时成立时不能变成「谁后判谁说了算」。裁决是场景，
    // 它的性质不因为作者顺手开了个面板而改变。
    expect(takesWholeStage({ reference: "settings", stage: "review" })).toBe(true);
  });
});
