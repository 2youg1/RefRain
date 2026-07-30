/**
 * 派发的措辞。
 *
 * 这些函数从 625 行的会话模块里搬出来，搬出来才看见两个被上下文盖住的缺陷：
 * 措辞表每次调用都重建，以及终态被枚举了两遍。第二个是真缺陷——加一个终态而漏改
 * 另一处，作者就能去取消一个已经结束的 Run。
 */

import { describe, expect, test } from "bun:test";

import type { RunDto, Tokens } from "../src/generated/bindings.gen";
import { runStatusLabel, terminal, tokenLabel } from "../src/shell/dispatch-wording";

const run = (progress: string, failure: string | null = null): RunDto =>
  ({ progress, failure }) as unknown as RunDto;

describe("一个 Run 走到哪一步", () => {
  test("每一步都有中文说法", () => {
    const steps = ["queued", "authorized", "launching", "dispatched", "completed", "cancelled"];
    for (const step of steps) {
      expect(runStatusLabel(run(step))).not.toBe(step);
    }
  });

  test("失败带上原因", () => {
    expect(runStatusLabel(run("failed", "harness 没有回应"))).toBe("失败：harness 没有回应");
  });

  test("没有原因的失败仍然说得出口", () => {
    // 早先的写法会拼出「失败：」这样一个悬着的冒号。
    expect(runStatusLabel(run("failed"))).toBe("失败");
  });

  test("认不出的状态原样交出，不编一句", () => {
    expect(runStatusLabel(run("teleported"))).toBe("teleported");
  });
});

describe("终态只有一处权威", () => {
  test("完成、失败、取消之后不能再取消", () => {
    for (const step of ["completed", "failed", "cancelled"]) {
      expect(terminal(run(step))).toBe(true);
    }
  });

  test("在途的几步仍可取消", () => {
    for (const step of ["queued", "authorized", "launching", "dispatched"]) {
      expect(terminal(run(step))).toBe(false);
    }
  });

  test("每个终态都说得出中文——两张表同源", () => {
    // 此前 terminal() 与措辞表各枚举一遍。一处加了另一处没加，
    // 症状是取消按钮出现在一个已经完成的 Run 上。
    for (const step of ["completed", "failed", "cancelled"]) {
      expect(runStatusLabel(run(step))).not.toBe(step);
    }
  });
});

describe("token 的数字", () => {
  const tokens = (kind: string, value?: number): Tokens => ({ kind, value }) as unknown as Tokens;

  test("实报与预估在措辞上分得开", () => {
    // 把预估读成实报会让作者对成本产生错误的信心。
    expect(tokenLabel(tokens("actual", 1200))).toContain("实报");
    expect(tokenLabel(tokens("estimated", 1200))).toContain("预估");
    expect(tokenLabel(tokens("actual", 1200))).not.toBe(tokenLabel(tokens("estimated", 1200)));
  });

  test("数字如实转述，不做换算", () => {
    // RefRain 不做计费换算，只转述 harness 给的数字。
    expect(tokenLabel(tokens("actual", 1200))).toContain("1200");
  });

  test("拿不到就说拿不到", () => {
    expect(tokenLabel(tokens("unknown"))).toBe("token 未知");
  });
});
