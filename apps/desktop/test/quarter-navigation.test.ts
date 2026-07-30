/**
 * 层导航：Cmd+1..4。
 *
 * 最要紧的两条是「记得上次」与「没有宾语就不假装」——前者是 KL9 的裁定，
 * 后者决定作者在空工作台上按 Cmd+4 时看到什么（什么都不该发生，而不是
 * 跳进一个空面板）。
 */

import { describe, expect, test } from "bun:test";

import {
  type AgentDestination,
  navigateTo,
  type QuarterActions,
  QuarterMemory,
  runQuarterKey,
} from "../src/shell/quarter-navigation";
import { quarterForKey } from "../src/shell/quarters";

describe("数字键落在哪一层", () => {
  test("1..4 依次是设置、文件、编辑、Agent", () => {
    expect(quarterForKey("1")).toBe("settings");
    expect(quarterForKey("2")).toBe("files");
    expect(quarterForKey("3")).toBe("editing");
    expect(quarterForKey("4")).toBe("agent");
  });

  test("第五个数字没有对应的层", () => {
    expect(quarterForKey("5")).toBeNull();
    expect(quarterForKey("0")).toBeNull();
  });
});

describe("每一层去哪儿", () => {
  const memory = () => new QuarterMemory();

  test("设置层：打开设置", () => {
    expect(navigateTo("settings", memory(), true)).toEqual({ kind: "openSettings" });
  });

  test("设置层不需要稿子——作者可以先调好再开工", () => {
    expect(navigateTo("settings", memory(), false)).toEqual({ kind: "openSettings" });
  });

  test("文件层：把焦点交给 Rail，它始终在场", () => {
    expect(navigateTo("files", memory(), false)).toEqual({ kind: "focusRail" });
  });

  test("编辑层：收起面板，光标还给稿子", () => {
    expect(navigateTo("editing", memory(), true)).toEqual({ kind: "returnToManuscript" });
  });
});

describe("没有宾语时不假装", () => {
  test("没有稿子，「回到正文」不接管", () => {
    // 静默什么都不做，比跳到一个空白舞台诚实。
    expect(navigateTo("editing", new QuarterMemory(), false)).toBeNull();
  });

  test("没有稿子，Agent 层不接管——批注没有可锚之处", () => {
    expect(navigateTo("agent", new QuarterMemory(), false)).toBeNull();
  });
});

describe("Agent 层记得上次停在哪（KL9 裁定）", () => {
  test("从没用过时落在批注——它锚在正文上，最贴近此刻在做的事", () => {
    expect(navigateTo("agent", new QuarterMemory(), true)).toEqual({
      kind: "openReference",
      reference: { kind: "annotations" },
    });
  });

  test("上次用的是派发，Cmd+4 就回派发", () => {
    const remembered = new QuarterMemory();
    remembered.rememberAgent("dispatch");
    expect(navigateTo("agent", remembered, true)).toEqual({
      kind: "openStage",
      stage: "dispatch",
    });
  });

  test("上次用的是连接，Cmd+4 就回连接", () => {
    const remembered = new QuarterMemory();
    remembered.rememberAgent({ reference: { kind: "connections" } });
    expect(navigateTo("agent", remembered, true)).toEqual({
      kind: "openReference",
      reference: { kind: "connections" },
    });
  });

  test("记的是最后一次，不是第一次", () => {
    const remembered = new QuarterMemory();
    remembered.rememberAgent("dispatch");
    remembered.rememberAgent({ reference: { kind: "connections" } });
    const destination: AgentDestination = remembered.agent;
    expect(destination).toEqual({ reference: { kind: "connections" } });
  });

  test("只有 Agent 层记忆——另外三层没有可记的分歧", () => {
    // 记了也没用：设置/文件/编辑各自只有一个去处。若哪天设置层要记住
    // 停在哪一节，那是 settingsSection 的事，不是这里。
    const remembered = new QuarterMemory();
    remembered.rememberAgent("dispatch");
    expect(navigateTo("settings", remembered, true)).toEqual({ kind: "openSettings" });
    expect(navigateTo("files", remembered, true)).toEqual({ kind: "focusRail" });
  });
});

describe("整条路径：从按键到动作", () => {
  const spy = () => {
    const calls: string[] = [];
    const actions: QuarterActions = {
      openSettings: () => calls.push("settings"),
      focusRail: () => calls.push("rail"),
      returnToManuscript: () => calls.push("manuscript"),
      openDispatch: () => calls.push("dispatch"),
      openReference: (reference) => calls.push(`reference:${reference.kind}`),
    };
    return { calls, actions };
  };

  test("四个数字各调各的动作", () => {
    const { calls, actions } = spy();
    for (const key of ["1", "2", "3", "4"]) {
      runQuarterKey(key, new QuarterMemory(), true, actions);
    }
    expect(calls).toEqual(["settings", "rail", "manuscript", "reference:annotations"]);
  });

  test("上次用过派发，Cmd+4 直接开派发", () => {
    const { calls, actions } = spy();
    const memory = new QuarterMemory();
    memory.rememberAgent("dispatch");
    expect(runQuarterKey("4", memory, true, actions)).toBe(true);
    expect(calls).toEqual(["dispatch"]);
  });

  test("去不了的层：报 false，且一个动作都不调", () => {
    // 「不接管」必须同时满足两件事——返回 false 让调用方别 preventDefault，
    // 以及真的什么都没做。只断言返回值的话，一个「先执行再返回 false」的
    // 实现照样通过，而作者会看到面板跳了一下又回来。
    const { calls, actions } = spy();
    expect(runQuarterKey("4", new QuarterMemory(), false, actions)).toBe(false);
    expect(runQuarterKey("3", new QuarterMemory(), false, actions)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("不是层的数字：报 false，不调动作", () => {
    const { calls, actions } = spy();
    expect(runQuarterKey("7", new QuarterMemory(), true, actions)).toBe(false);
    expect(calls).toEqual([]);
  });
});
