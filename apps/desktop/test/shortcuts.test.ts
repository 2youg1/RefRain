/**
 * 快捷键：次序本身就是规矩，不必开窗口逐个按就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { handleShortcut, type ShortcutTargets } from "../src/shell/shortcuts";

function press(
  init: { key: string; ctrl?: boolean; shift?: boolean; composing?: boolean; input?: boolean },
  overrides: Partial<ShortcutTargets> = {},
) {
  const calls: string[] = [];
  let prevented = false;
  const event = {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: false,
    shiftKey: init.shift ?? false,
    isComposing: init.composing ?? false,
    target: init.input === true ? { tagName: "INPUT" } : null,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent;

  const targets: ShortcutTargets = {
    composing: () => false,
    save: () => calls.push("save"),
    undo: () => calls.push("undo"),
    toggleCommandMenu: () => calls.push("command-menu"),
    toggleKara: () => calls.push("kara"),
    focusSearch: () => calls.push("search"),
    menuOpen: () => false,
    closeMenu: () => calls.push("close-menu"),
    panelDepth: () => 0,
    closePanel: () => calls.push("close-panel"),
    goToQuarter: (key: string) => {
      calls.push(`quarter-${key}`);
      return true;
    },
    ...overrides,
  };

  const handled = handleShortcut(event, targets);
  return { handled, calls, prevented };
}

describe("handleShortcut", () => {
  test("Ctrl+S 保存，Ctrl+K 命令面板，Ctrl+Enter KARA，Ctrl+F 搜索", () => {
    expect(press({ key: "s", ctrl: true }).calls).toEqual(["save"]);
    expect(press({ key: "k", ctrl: true }).calls).toEqual(["command-menu"]);
    expect(press({ key: "Enter", ctrl: true }).calls).toEqual(["kara"]);
    expect(press({ key: "f", ctrl: true }).calls).toEqual(["search"]);
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

describe("Ctrl+Z 撤销", () => {
  test("Ctrl+Z 撤销一步，且必定 preventDefault——内核已拒绝原生 historyUndo，壳层这一下之后两条路不会赛跑", () => {
    const result = press({ key: "z", ctrl: true });
    expect(result.calls).toEqual(["undo"]);
    expect(result.prevented).toBe(true);
  });

  test("没有修饰键的 z 是作者在写字", () => {
    expect(press({ key: "z" }).calls).toEqual([]);
    expect(press({ key: "z" }).handled).toBe(false);
  });

  test("Ctrl+Shift+Z 不绑——领域没有 redo，绑一个空键是许诺不存在的能力", () => {
    const refused = press({ key: "z", ctrl: true, shift: true });
    expect(refused.handled).toBe(false);
    expect(refused.prevented).toBe(false);
  });

  test("焦点在原生输入框里时让位——那是浏览器自己的文本撤销", () => {
    const refused = press({ key: "z", ctrl: true, input: true });
    expect(refused.handled).toBe(false);
    expect(refused.prevented).toBe(false);
  });
});

describe("Cmd+1..4 按层直达", () => {
  test("数字键交给层导航，并带上按的是哪一个", () => {
    expect(press({ key: "1", ctrl: true }).calls).toEqual(["quarter-1"]);
    expect(press({ key: "4", ctrl: true }).calls).toEqual(["quarter-4"]);
  });

  test("那一层此刻去不了时，这一下不被接管", () => {
    // 没有稿子时按 Cmd+4：批注没有可锚之处。**不 preventDefault**——
    // 这一下没被我们接管，就该按浏览器的默认行为走，而不是被静默吃掉。
    const refused = press({ key: "4", ctrl: true }, { goToQuarter: () => false });
    expect(refused.handled).toBe(false);
    expect(refused.prevented).toBe(false);
  });

  test("没有修饰键的数字是作者在写字", () => {
    // 「第 3 章」里的 3 必须落进正文。
    expect(press({ key: "3" }).calls).toEqual([]);
  });

  test("接管的那一下 preventDefault——否则浏览器会去切标签页", () => {
    expect(press({ key: "2", ctrl: true }).prevented).toBe(true);
  });
});
