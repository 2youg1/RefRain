/**
 * 面板栈的规矩：不必开窗口就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { PanelStack } from "../src/shell/panel-stack";

const panel = (key: string) => ({ key, title: key });
const keys = (stack: PanelStack) => stack.layers.map((layer) => layer.key);

describe("PanelStack", () => {
  test("展开一层是压栈，路径就是屏幕上并排的那几层", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    expect(keys(stack)).toEqual(["settings", "settings/typography"]);
    expect(stack.top?.key).toBe("settings/typography");
  });

  test("同一个按钮再按一次就收起", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings"));
    expect(keys(stack)).toEqual([]);
  });

  test("点栈里靠内的一层是回到它，不是开一个副本", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    stack.open(panel("settings/typography/fonts"));
    stack.open(panel("settings"));
    expect(keys(stack)).toEqual(["settings"]);
  });

  test("Escape 退一步，不是关掉整条路径", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("library"));
    stack.open(panel("library/interviews"));
    stack.back();
    expect(keys(stack)).toEqual(["library"]);
    stack.back();
    expect(keys(stack)).toEqual([]);
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

  test("has 认得路径上的每一层，不只是顶层", () => {
    const stack = new PanelStack(() => undefined);
    stack.open(panel("settings"));
    stack.open(panel("settings/typography"));
    expect(stack.has("settings")).toBe(true);
    expect(stack.has("settings/typography")).toBe(true);
    expect(stack.has("library")).toBe(false);
  });
});
