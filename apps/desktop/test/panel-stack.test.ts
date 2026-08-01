/**
 * 面板栈的规矩：不必开窗口就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { PanelStack } from "../src/shell/panel-stack";

const panel = (key: string) => ({ key });

/** 一路退到底，把经过的顶层记下来——路径的形状由此可读。 */
const drain = (stack: PanelStack): string[] => {
  const keys: string[] = [];
  while (stack.top !== null) {
    keys.push(stack.top.key);
    stack.back();
  }
  return keys;
};

describe("PanelStack", () => {
  test("展开一层是压栈，最外一层就是作者正在看的", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    expect(stack.depth).toBe(2);
    expect(stack.top?.key).toBe("settings/typography");
  });

  test("同一个按钮再按一次就收起", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings"));
    expect(stack.depth).toBe(0);
  });

  test("点栈里靠内的一层是回到它，不是开一个副本", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    stack.open(panel("settings/typography/fonts"));
    stack.open(panel("settings"));
    expect(stack.depth).toBe(1);
    expect(stack.top?.key).toBe("settings");
  });

  test("Escape 退一步，不是关掉整条路径", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("library"));
    stack.open(panel("library/interviews"));
    expect(drain(stack)).toEqual(["library/interviews", "library"]);
    // 空栈上再退不该报错，也不该广播
    stack.back();
    expect(stack.depth).toBe(0);
  });

  test("换场景时整条路径让开", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    stack.clear();
    expect(stack.depth).toBe(0);
    expect(stack.top).toBeNull();
  });

  test("每次真实变化广播一次，没变化不广播", () => {
    let beats = 0;
    const stack = new PanelStack(() => {
      beats += 1;
    });
    stack.open(panel("a")); // 1
    stack.back(); // 2
    stack.back(); // 空栈，不广播
    stack.clear(); // 空栈，不广播
    expect(beats).toBe(2);
  });
});
