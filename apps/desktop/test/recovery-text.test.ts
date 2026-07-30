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

/**
 * 域从生成的联合类型取，不从记忆里列。
 *
 * 这里原本是一份手抄的六项清单加 `satisfies readonly RecoveryStep[]`，
 * 注释也写着「不来自记忆」——但 `satisfies` 只保证**清单里的都合法**，
 * 不保证**合法的都在清单里**。于是领域新增两个步骤时，它一声不响。
 *
 * `EXPECTED` 用一个 `Record<RecoveryStep, true>` 声明：漏掉任何一个成员
 * 都会编译失败，这才是完整性。**能编译过就等于域是全的。**
 */
const EXPECTED: Record<RecoveryStep, true> = {
  retry: true,
  "choose-another-location": true,
  "choose-another-name": true,
  "grant-permission": true,
  "open-settings": true,
  "report-defect": true,
  "compare-with-frozen-text": true,
  "send-again": true,
};

const EVERY_STEP = Object.keys(EXPECTED) as readonly RecoveryStep[];

describe("recovery steps become sentences the author can act on", () => {
  test.each([...EVERY_STEP])("%s has author-facing text", (step) => {
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
