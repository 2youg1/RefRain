/**
 * 保存失败时，作者拿得到 Rust 给的出路。
 *
 * `document-session` 一直在产出 `recovery`，而界面层零消费——作者只看到一句
 * 「保存失败:...」，不知道该做什么。这是 U-6。
 *
 * 测试形状按「完备性断言」写：**枚举从生成的类型取，逐项断言有译文**。
 * 只测「我举的例子渲染对了」证明不了「六个都写了」，而漏掉的那一个恰好会在
 * 作者保存失败的时刻渲染成空白。
 */
import { describe, expect, test } from "bun:test";
import type { RecoveryStep } from "../src/generated/bindings.gen";
import { RECOVERY_TEXT } from "../src/ui/recovery-text";

// 域来自生成的联合类型，不来自记忆：凭记忆列的表恰好会漏掉忘了的那个。
const EVERY_STEP = [
  "retry",
  "choose-another-location",
  "choose-another-name",
  "grant-permission",
  "open-settings",
  "report-defect",
] as const satisfies readonly RecoveryStep[];

describe("recovery steps become sentences the author can act on", () => {
  test.each(EVERY_STEP)("%s has author-facing text", (step) => {
    const text = RECOVERY_TEXT[step];
    expect(text).toBeString();
    expect(text.length).toBeGreaterThan(0);
  });

  test("the table covers the union exactly, with nothing extra", () => {
    expect(Object.keys(RECOVERY_TEXT).sort()).toEqual([...EVERY_STEP].sort());
  });

  test("no step leaks an implementation term to the author", () => {
    // 作者读到的是自己的语言，不是错误码或英文枚举名。
    for (const step of EVERY_STEP) {
      const text = RECOVERY_TEXT[step];
      expect(text).not.toContain(step);
      expect(text).not.toMatch(/[a-z]+-[a-z]+/);
    }
  });

  test("each step says something different", () => {
    // 两个步骤给同一句话，等于其中一个没被真正回答。
    const seen = new Set(Object.values(RECOVERY_TEXT));
    expect(seen.size).toBe(EVERY_STEP.length);
  });
});
