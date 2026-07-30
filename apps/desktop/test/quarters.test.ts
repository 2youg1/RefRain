/**
 * 四区。
 *
 * 最要紧的断言是方向性：上层可以和下层并存，**反过来不行**。一条只测了「能并存」
 * 的断言会同时被正确实现和「什么都不管」的实现通过——必须同时钉住不能做的那一半。
 */

import { describe, expect, test } from "bun:test";

import {
  canSendOpposite,
  close,
  depth,
  invalidate,
  type OpenQuarter,
  open,
  persistence,
  QUARTERS,
  quarterForKey,
  reflowsManuscript,
  sideOf,
} from "../src/shell/quarters";

const at = (...quarters: readonly (typeof QUARTERS)[number][]): OpenQuarter[] =>
  quarters.map((quarter) => ({ quarter, side: "main" as const }));

describe("层的次序", () => {
  test("设置最浅，Agent 最深", () => {
    expect(depth("settings")).toBeLessThan(depth("files"));
    expect(depth("files")).toBeLessThan(depth("editing"));
    expect(depth("editing")).toBeLessThan(depth("agent"));
  });

  test("四个区，不多不少", () => {
    expect(QUARTERS).toEqual(["settings", "files", "editing", "agent"]);
  });
});

describe("上层与下层并存", () => {
  test("打开 Agent 时，编辑与文件留在原处", () => {
    // Agent 要引用它们，它们消失了 Agent 就没有宾语。
    const after = open(at("files", "editing"), "agent", "main");
    expect(after.map((entry) => entry.quarter)).toEqual(["files", "editing", "agent"]);
  });

  test("查另一份稿子不该丢掉手上的编辑状态", () => {
    // 若打开文件层会顶掉编辑层，作者就不敢查，只好凭记忆，然后记错。
    const after = open(at("files", "editing"), "files", "opposite");
    expect(after.map((entry) => entry.quarter)).toContain("editing");
  });

  test("再开一次同一个区只是换个位置，不会开出两份", () => {
    const after = open(at("files", "editing"), "editing", "opposite");
    expect(after.filter((entry) => entry.quarter === "editing")).toHaveLength(1);
    expect(sideOf(after, "editing")).toBe("opposite");
  });

  test("开着的区永远按层排好", () => {
    const after = open(open(at(), "agent", "main"), "files", "main");
    expect(after.map((entry) => depth(entry.quarter))).toEqual([1, 3]);
  });
});

describe("下层不能和上层并存", () => {
  test("关掉文件层，其上的编辑与 Agent 一起收走", () => {
    // 稿子都没了，「改这一句」没有意义。
    expect(close(at("settings", "files", "editing", "agent"), "files")).toEqual(at("settings"));
  });

  test("关掉上层不动下层", () => {
    const after = close(at("files", "editing", "agent"), "agent");
    expect(after.map((entry) => entry.quarter)).toEqual(["files", "editing"]);
  });

  test("关掉最底下的区，什么都不剩", () => {
    expect(close(at("settings", "files", "editing"), "settings")).toEqual([]);
  });
});

describe("窗口去哪一边", () => {
  test("只有上层能甩到对侧", () => {
    const state = at("settings", "files", "editing");
    expect(canSendOpposite(state, "editing")).toBe(true);
    expect(canSendOpposite(state, "files")).toBe(true);
  });

  test("根永远在主侧——它是下面那一层，不能宣称与上层对等", () => {
    expect(canSendOpposite(at("settings", "files"), "settings")).toBe(false);
  });

  test("根是「最下面那个开着的区」，不是固定的设置层", () => {
    // 没开设置时，文件层自己就是根。
    expect(canSendOpposite(at("files", "editing"), "files")).toBe(false);
    expect(canSendOpposite(at("files", "editing"), "editing")).toBe(true);
  });

  test("什么都没开时无处可甩", () => {
    expect(canSendOpposite(at(), "agent")).toBe(false);
  });

  test("没指定过位置的区在主侧", () => {
    expect(sideOf(at("files"), "files")).toBe("main");
    expect(sideOf(at("files"), "agent")).toBe("main");
  });
});

describe("稿子在别处被改了", () => {
  test("文件层收走其上的层，自己留下", () => {
    // 这是「下层收走上层」唯一正当的时刻：前提没了，以它为前提的东西就该走。
    const after = invalidate(at("settings", "files", "editing", "agent"), "files");
    expect(after.map((entry) => entry.quarter)).toEqual(["settings", "files"]);
  });

  test("与 close 的差别正在于自己留不留下", () => {
    const state = at("settings", "files", "editing");
    expect(invalidate(state, "files")).not.toEqual(close(state, "files"));
  });
});

describe("键盘按层走", () => {
  test("1 到 4 直达四个区", () => {
    expect(QUARTERS.map((_, i) => quarterForKey(String(i + 1)))).toEqual([...QUARTERS]);
  });

  test("没有第五层", () => {
    expect(quarterForKey("5")).toBeNull();
    expect(quarterForKey("0")).toBeNull();
    expect(quarterForKey("x")).toBeNull();
  });
});

describe("频率决定每一层怎么活", () => {
  test("设置用完就弃——它很少开，常驻等于让没人看的 DOM 参与每一帧", () => {
    expect(persistence("settings")).toBe("discard");
  });

  test("编辑与 Agent 永不销毁——两者同时活跃是常态", () => {
    // KL9：「使用 Agent 的时候肯定也需要直接改东西」。若挂载 Agent 时卸载编辑器，
    // 每次来回都要付一次重建：选区丢失、滚动归零、高亮缓存作废。
    expect(persistence("editing")).toBe("keep");
    expect(persistence("agent")).toBe("keep");
  });

  test("文件层建了就留——拖拽的源不能在拖到一半时消失", () => {
    expect(persistence("files")).toBe("keep");
  });

  test("只有最少用的那一层被丢弃", () => {
    const discarded = QUARTERS.filter((quarter) => persistence(quarter) === "discard");
    expect(discarded).toEqual(["settings"]);
  });
});

describe("面板开合不该动正文的度量", () => {
  test("常规两档只挪位置，不重排", () => {
    // 重排会让作者正看着的那一行跳走，他会理解成自己弄丢了位置。
    expect(reflowsManuscript("narrow")).toBe(false);
    expect(reflowsManuscript("regular")).toBe(false);
  });

  test("铺满是例外——那时正文本就不在视野里", () => {
    expect(reflowsManuscript("full")).toBe(true);
  });
});
