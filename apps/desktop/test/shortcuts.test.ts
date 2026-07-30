/**
 * 快捷键：次序本身就是规矩，不必开窗口逐个按就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { handleShortcut, type ShortcutTargets } from "../src/shell/shortcuts";

function press(
  init: { key: string; ctrl?: boolean; composing?: boolean },
  overrides: Partial<ShortcutTargets> = {},
) {
  const calls: string[] = [];
  let prevented = false;
  const event = {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: false,
    isComposing: init.composing ?? false,
    preventDefault: () => {
      prevented = true;
    },
  } as KeyboardEvent;

  const targets: ShortcutTargets = {
    composing: () => false,
    save: () => calls.push("save"),
    toggleCommandMenu: () => calls.push("command-menu"),
    menuOpen: () => false,
    closeMenu: () => calls.push("close-menu"),
    panelDepth: () => 0,
    closePanel: () => calls.push("close-panel"),
    ...overrides,
  };

  const handled = handleShortcut(event, targets);
  return { handled, calls, prevented };
}

describe("handleShortcut", () => {
  test("Ctrl+S 保存，Ctrl+K 开合命令面板", () => {
    expect(press({ key: "s", ctrl: true }).calls).toEqual(["save"]);
    expect(press({ key: "k", ctrl: true }).calls).toEqual(["command-menu"]);
  });

  test("大写也认——按住 Shift 的手不该被当成没按", () => {
    expect(press({ key: "S", ctrl: true }).calls).toEqual(["save"]);
  });

  test("Escape 先收右键菜单，菜单收完了才退面板", () => {
    // 菜单浮在最上面，作者要收的是它。
    const withMenu = press({ key: "Escape" }, { menuOpen: () => true, panelDepth: () => 2 });
    expect(withMenu.calls).toEqual(["close-menu"]);

    const withoutMenu = press({ key: "Escape" }, { menuOpen: () => false, panelDepth: () => 2 });
    expect(withoutMenu.calls).toEqual(["close-panel"]);
  });

  test("没有菜单也没有面板时，Escape 不归我们管", () => {
    const idle = press({ key: "Escape" });
    expect(idle.handled).toBe(false);
    expect(idle.prevented).toBe(false);
  });

  test("Ctrl+[ 退一层，只在真有面板时接管", () => {
    expect(press({ key: "[", ctrl: true }, { panelDepth: () => 1 }).calls).toEqual(["close-panel"]);
    expect(press({ key: "[", ctrl: true }, { panelDepth: () => 0 }).handled).toBe(false);
  });

  test("组合输入期间一律让位——那时的按键属于输入法", () => {
    // 事件自己报 composing
    expect(press({ key: "s", ctrl: true, composing: true }).handled).toBe(false);
    // 编辑器报 composing（事件没报，但内核知道）
    expect(press({ key: "s", ctrl: true }, { composing: () => true }).handled).toBe(false);
  });

  test("接管的那一下必定 preventDefault，没接管的一定不动它", () => {
    expect(press({ key: "s", ctrl: true }).prevented).toBe(true);
    expect(press({ key: "s" }).prevented).toBe(false);
    expect(press({ key: "a", ctrl: true }).handled).toBe(false);
  });

  test("没有修饰键的 s 是作者在写字，不是保存", () => {
    expect(press({ key: "s" }).calls).toEqual([]);
  });
});
