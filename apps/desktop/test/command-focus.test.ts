/**
 * 命令面板的焦点归还：不必开一个真窗口就能问清楚。
 */

import { describe, expect, test } from "bun:test";

import { CommandFocus } from "../src/shell/command-focus";

/** 让 queueMicrotask 排的活儿跑完。 */
const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(() => resolve()));

function makeElement(options: { connected?: boolean; inHotZone?: boolean } = {}) {
  let focused = 0;
  const element = {
    isConnected: options.connected ?? true,
    closest: (selector: string) =>
      options.inHotZone === true && selector === ".universal-button-zone" ? element : null,
    focus: () => {
      focused += 1;
    },
  };
  return { element, focusCount: () => focused };
}

/** 装作 document.activeElement 是某个元素。 */
function withActive(element: unknown, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: { activeElement: element },
    configurable: true,
  });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

// HTMLElement 在 bun 里不存在；instanceof 检查需要一个能通过的构造器。
class FakeHTMLElement {}
Object.defineProperty(globalThis, "HTMLElement", { value: FakeHTMLElement, configurable: true });

const asElement = (source: object): FakeHTMLElement => Object.assign(new FakeHTMLElement(), source);

describe("CommandFocus", () => {
  test("关闭后把焦点还给打开它的地方", async () => {
    const { element, focusCount } = makeElement();
    const target = asElement(element);
    let fellBack = 0;
    const focus = new CommandFocus(
      () => undefined,
      () => {
        fellBack += 1;
      },
    );
    withActive(target, () => focus.show());
    focus.hide();
    await settle();
    expect(focusCount()).toBe(1);
    expect(fellBack).toBe(0);
  });

  test("原处是热区时落回手稿，不把作者关进开合循环", async () => {
    const { element, focusCount } = makeElement({ inHotZone: true });
    let fellBack = 0;
    const focus = new CommandFocus(
      () => undefined,
      () => {
        fellBack += 1;
      },
    );
    withActive(asElement(element), () => focus.show());
    focus.hide();
    await settle();
    expect(focusCount()).toBe(0);
    expect(fellBack).toBe(1);
  });

  test("原处已从 DOM 上下来时落回手稿", async () => {
    const { element, focusCount } = makeElement({ connected: false });
    let fellBack = 0;
    const focus = new CommandFocus(
      () => undefined,
      () => {
        fellBack += 1;
      },
    );
    withActive(asElement(element), () => focus.show());
    focus.hide();
    await settle();
    expect(focusCount()).toBe(0);
    expect(fellBack).toBe(1);
  });

  test("重复 show 不覆盖第一次记下的来处", async () => {
    const first = makeElement();
    const second = makeElement();
    const focus = new CommandFocus(
      () => undefined,
      () => undefined,
    );
    withActive(asElement(first.element), () => focus.show());
    withActive(asElement(second.element), () => focus.show());
    focus.hide();
    await settle();
    expect(first.focusCount()).toBe(1);
    expect(second.focusCount()).toBe(0);
  });

  test("未打开时 hide 什么也不做", async () => {
    let announced = 0;
    let fellBack = 0;
    const focus = new CommandFocus(
      () => {
        announced += 1;
      },
      () => {
        fellBack += 1;
      },
    );
    focus.hide();
    await settle();
    expect(announced).toBe(0);
    expect(fellBack).toBe(0);
  });

  test("toggle 在两态之间走，并广播状态", () => {
    const seen: boolean[] = [];
    const focus = new CommandFocus(
      (open) => seen.push(open),
      () => undefined,
    );
    withActive(null, () => focus.toggle());
    expect(focus.open).toBe(true);
    focus.toggle();
    expect(focus.open).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
