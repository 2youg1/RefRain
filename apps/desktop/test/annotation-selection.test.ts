/**
 * 勾选要活过面板的一次开合。
 *
 * 这些断言的来由是一个真缺陷：选择原本是 `AnnotationSurface` 的组件本地信号，
 * 面板一关就随 DOM 一起消失。作者勾了十条、回正文核对一句、再打开——空的。
 */

import { describe, expect, test } from "bun:test";

import { AnnotationSelection } from "../src/shell/annotation-selection";

const silent = () => {};

describe("勾选", () => {
  test("勾上再点一次就取消——同一个复选框两种意思", () => {
    const selection = new AnnotationSelection(silent);
    selection.toggle("a");
    expect(selection.has("a")).toBe(true);
    selection.toggle("a");
    expect(selection.has("a")).toBe(false);
  });

  test("多选互不影响", () => {
    const selection = new AnnotationSelection(silent);
    selection.toggle("a");
    selection.toggle("b");
    selection.toggle("a");
    expect([...selection.selected]).toEqual(["b"]);
    expect(selection.count).toBe(1);
  });
});

describe("什么时候该忘掉，什么时候不该", () => {
  test("派发之后清空——意图已经交出去了", () => {
    const selection = new AnnotationSelection(silent);
    selection.toggle("a");
    selection.toggle("b");
    selection.clear();
    expect(selection.count).toBe(0);
  });

  test("已经不存在的批注要放手", () => {
    // 批注可能在别处被删掉。留着它，派发会带上一个取不到引文的 id，
    // 而失败发生在派发那一刻，离作者做这个选择已经很远。
    const selection = new AnnotationSelection(silent);
    selection.toggle("a");
    selection.toggle("gone");
    selection.retain(["a", "b"]);
    expect([...selection.selected]).toEqual(["a"]);
  });

  test("投影没少东西就不广播——否则面板每帧重绘", () => {
    let announcements = 0;
    const selection = new AnnotationSelection(() => {
      announcements += 1;
    });
    selection.toggle("a");
    expect(announcements).toBe(1);
    selection.retain(["a", "b", "c"]);
    expect(announcements).toBe(1);
  });

  test("已经空了就不再广播", () => {
    let announcements = 0;
    const selection = new AnnotationSelection(() => {
      announcements += 1;
    });
    selection.clear();
    expect(announcements).toBe(0);
  });
});

describe("这个模块存在的理由", () => {
  test("同一个选择跨越面板的开合", () => {
    // 面板开合在这一层没有对应物——这正是重点：选择归会话，
    // 面板的生死碰不到它。组件里那个 createSignal 做不到这件事，
    // 因为它和 DOM 同生共死。
    const selection = new AnnotationSelection(silent);
    selection.toggle("第三章-批注-1");
    selection.toggle("第三章-批注-2");

    // 作者关掉面板去看正文，再打开——这一层什么都没发生。
    expect(selection.count).toBe(2);
    expect(selection.has("第三章-批注-1")).toBe(true);
  });

  test("换文档不由这一层决定要不要清——清是调用方的判断", () => {
    // 故意不提供「切文档自动清空」：那是 Workbench 知道的事。
    // 这一层只拥有「现在选了哪些」，不猜谁该让它改变。
    const selection = new AnnotationSelection(silent);
    selection.toggle("a");
    selection.retain([]);
    expect(selection.count).toBe(0);
  });
});
