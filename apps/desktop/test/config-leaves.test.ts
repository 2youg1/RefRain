/**
 * 作者在设置里改了什么。
 *
 * 这几十行此前住在 `SettingsSurface.tsx` 里，零测试，而它们决定「撤销本次调整」
 * 到底撤掉哪几项：漏掉一项，作者以为撤销了而它还留着；多算一项，他没动过的东西
 * 被改回去。两种都不该发生。
 */

import { describe, expect, test } from "bun:test";

import { divergedPaths, leavesOf, readLeaf, writeLeaf } from "../src/shell/config-leaves";

describe("把配置拍平成叶子", () => {
  test("嵌套的键连成路径", () => {
    const leaves = leavesOf({ typography: { serif: "Noto", size: 17 } });
    expect([...leaves.keys()].sort()).toEqual(["typography.serif", "typography.size"]);
  });

  test("值按序列化比——数字与同形字符串不是一回事", () => {
    const numeric = leavesOf({ size: 17 });
    const textual = leavesOf({ size: "17" });
    expect(numeric.get("size")).not.toBe(textual.get("size"));
  });

  test("undefined 与 null 合流：作者看到的都是「这项没设」", () => {
    expect(leavesOf({ lamp: undefined }).get("lamp")).toBe(leavesOf({ lamp: null }).get("lamp"));
  });

  test("数组作为一个值，不逐项拆开", () => {
    // 字体优先级是一个整体；拆成 fonts.0 / fonts.1 会让换顺序读作两处改动。
    const leaves = leavesOf({ fonts: ["A", "B"] });
    expect([...leaves.keys()]).toEqual(["fonts"]);
  });

  test("空配置拍出空叶子", () => {
    expect(leavesOf({}).size).toBe(0);
  });
});

describe("读一条路径", () => {
  const tree = { typography: { serif: "Noto", nested: { deep: 1 } } };

  test("读得到嵌套的值", () => {
    expect(readLeaf(tree, "typography.serif")).toBe("Noto");
    expect(readLeaf(tree, "typography.nested.deep")).toBe(1);
  });

  test("不存在的路径读作 undefined，不抛错", () => {
    expect(readLeaf(tree, "typography.missing")).toBeUndefined();
    expect(readLeaf(tree, "nowhere.at.all")).toBeUndefined();
  });

  test("中途撞上非对象也读作没有这一项", () => {
    // 配置的形状会随版本变；一条过时的路径不该让整个设置页崩掉。
    expect(readLeaf(tree, "typography.serif.further")).toBeUndefined();
  });
});

describe("写一条路径", () => {
  test("写得进已有的层", () => {
    const tree: Record<string, unknown> = { typography: { serif: "Noto" } };
    writeLeaf(tree, "typography.serif", "Source Han");
    expect(readLeaf(tree, "typography.serif")).toBe("Source Han");
  });

  test("缺失的层会被建出来", () => {
    const tree: Record<string, unknown> = {};
    writeLeaf(tree, "panel.material.blur", 12);
    expect(readLeaf(tree, "panel.material.blur")).toBe(12);
  });

  test("写 undefined 是删掉这一项，而不是把它设成 undefined", () => {
    // 作者的意思是「回到没设的状态」；留一个 undefined 键会让拍平结果多出一条。
    const tree: Record<string, unknown> = { lamp: "side" };
    writeLeaf(tree, "lamp", undefined);
    expect("lamp" in tree).toBe(false);
    expect(leavesOf(tree).size).toBe(0);
  });

  test("挡路的非对象被替换成层，不是静默失败", () => {
    const tree: Record<string, unknown> = { panel: "solid" };
    writeLeaf(tree, "panel.blur", 8);
    expect(readLeaf(tree, "panel.blur")).toBe(8);
  });

  test("空路径什么也不做", () => {
    const tree: Record<string, unknown> = { a: 1 };
    writeLeaf(tree, "", 2);
    expect(tree).toEqual({ a: 1, "": 2 });
  });
});

describe("哪几项变了", () => {
  test("值不同就是变了", () => {
    const before = leavesOf({ lamp: "off", size: 17 });
    const after = leavesOf({ lamp: "side", size: 17 });
    expect(divergedPaths(before, after)).toEqual(["lamp"]);
  });

  test("什么都没动就是空", () => {
    const same = { lamp: "side", typography: { serif: "Noto" } };
    expect(divergedPaths(leavesOf(same), leavesOf(same))).toEqual([]);
  });

  test("新出现的键算变了", () => {
    // 一项从「没设」变成「设了值」，作者确实动过它。
    const paths = divergedPaths(leavesOf({}), leavesOf({ lamp: "side" }));
    expect(paths).toEqual(["lamp"]);
  });

  test("消失的键也算变了", () => {
    const paths = divergedPaths(leavesOf({ lamp: "side" }), leavesOf({}));
    expect(paths).toEqual(["lamp"]);
  });

  test("多处改动全部报出，不只报第一处", () => {
    const before = leavesOf({ lamp: "off", panel: { width: "narrow" } });
    const after = leavesOf({ lamp: "side", panel: { width: "full" } });
    expect(divergedPaths(before, after).sort()).toEqual(["lamp", "panel.width"]);
  });

  test("撤销一条路径后它不再出现在差异里", () => {
    // 这是撤销的闭环：读出旧值、写回去、差异清空。
    const entry = { lamp: "off", size: 17 };
    const now: Record<string, unknown> = { lamp: "side", size: 17 };
    const mark = leavesOf(entry);
    const changed = divergedPaths(mark, leavesOf(now));
    for (const path of changed) writeLeaf(now, path, readLeaf(entry, path));
    expect(divergedPaths(mark, leavesOf(now))).toEqual([]);
  });
});
