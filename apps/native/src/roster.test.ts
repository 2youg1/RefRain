import { describe, expect, test } from "bun:test";
import { afterRefresh, hasRow, NO_ROW, settle, step } from "./roster.ts";

describe("名录的游标永远指向一个存在的行", () => {
  test("空名录上的游标是 NO_ROW，不是 0", () => {
    // 0 是一个真实的行。空名录上返回 0 会让「选中的那一行」指向不存在的东西，
    // 而调用方看不出区别——命令按钮会亮着，按下去落在空处。
    expect(settle(0, 0)).toBe(NO_ROW);
    expect(settle(5, 0)).toBe(NO_ROW);
    expect(hasRow(NO_ROW, 0)).toBe(false);
  });

  test("越界的游标回到最近的一端，而不是回到第一行", () => {
    // 近失手：`Math.min(cursor, count-1)` 与「回到 0」在 count=3、cursor=9 时
    // 都是合法答案，但后者把作者从末尾弹回开头。收走末行时他的注意力在末尾。
    expect(settle(9, 3)).toBe(2);
    expect(settle(-4, 3)).toBe(0);
  });

  test("移动撞到两端就停，不绕回", () => {
    expect(step(0, -1, 3)).toBe(0);
    expect(step(2, 1, 3)).toBe(2);
    expect(step(0, 1, 3)).toBe(1);
    expect(step(0, 1, 0)).toBe(NO_ROW);
  });

  test("名录变短之后游标停在原位，只有名录空了才交出 NO_ROW", () => {
    // 这是本模块存在的理由：连着处理三封信不该每次重新找位置。
    expect(afterRefresh(1, 5)).toBe(1);
    expect(afterRefresh(4, 2)).toBe(1);
    expect(afterRefresh(3, 0)).toBe(NO_ROW);
  });

  test("极端：只有一行时上下都停在那一行", () => {
    expect(step(0, 1, 1)).toBe(0);
    expect(step(0, -1, 1)).toBe(0);
    expect(hasRow(0, 1)).toBe(true);
  });
});
