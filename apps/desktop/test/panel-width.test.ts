/**
 * 面板宽度：钳制、像素与档位的互认、以及「换档作废拖动值、同档保留」
 * 这条状态机。DOM 拖动本身开在真窗口里才有意义，这里问的是不需要窗口的部分。
 */

import { describe, expect, test } from "bun:test";

import {
  clampPanelWidth,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MAX_VW,
  PANEL_WIDTH_MIN,
  PanelWidthControl,
  presetMatchingPx,
} from "../src/shell/panel-width";

/** applyPreset 只读 style 与 querySelectorAll 两个面；一个替身足够。 */
const fakeRoot = (): { root: HTMLElement; writes: Map<string, string> } => {
  const writes = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => void writes.set(name, value),
    },
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  return { root, writes };
};

describe("宽度钳制", () => {
  test("低于下限回到下限，高于上限回到上限", () => {
    expect(clampPanelWidth(10, 2000)).toBe(PANEL_WIDTH_MIN);
    expect(clampPanelWidth(5000, 2000)).toBe(Math.min(PANEL_WIDTH_MAX, 2000 * PANEL_WIDTH_MAX_VW));
  });

  test("视口窄时上限跟着视口走", () => {
    // 60vw 比 720 还小的时候，面板不许盖过舞台的那个比例。
    expect(clampPanelWidth(5000, 1000)).toBe(600);
  });

  test("取整到整像素", () => {
    expect(clampPanelWidth(400.6, 2000)).toBe(401);
  });
});

describe("像素与档位互认", () => {
  test("恰好是某一档的像素才认得出档位", () => {
    expect(presetMatchingPx(320)).toBe("narrow");
    expect(presetMatchingPx(400)).toBe("regular");
    expect(presetMatchingPx(500)).toBeNull();
  });
});

describe("拖动值与档位是同一个状态", () => {
  test("换档作废拖动值，同档重投影保留它", () => {
    const { root, writes } = fakeRoot();
    const control = new PanelWidthControl();

    control.applyPreset(root, "regular");
    expect(writes.get("--panel-width")).toBe("400px");

    control.setCustom(500);
    expect(writes.get("--panel-width")).toBe("500px");

    // 同一份档位再投影一次（换主题、改排版都会走这条路）：拖动值要还在。
    control.applyPreset(root, "regular");
    expect(writes.get("--panel-width")).toBe("500px");

    // 换档：「选这一档」就是作者要的宽度，拖动值作废。
    control.applyPreset(root, "narrow");
    expect(writes.get("--panel-width")).toBe("320px");
  });

  test("clearCustom 回到档位：作者在设置里点了档位的语义", () => {
    const { root, writes } = fakeRoot();
    const control = new PanelWidthControl();

    control.applyPreset(root, "narrow");
    control.setCustom(500);
    control.clearCustom();
    expect(writes.get("--panel-width")).toBe("320px");
    expect(control.currentPx()).toBe(320);
  });

  test("没有任何投影时也有答案，不留 undefined 给 CSS", () => {
    expect(new PanelWidthControl().currentPx()).toBe(400);
  });

  test("持久化的自由宽度随投影进场，重启后面板还是拖出来的宽度", () => {
    const { root, writes } = fakeRoot();
    const control = new PanelWidthControl();

    // 启动：Config 里存着上次拖出的 500px，档位仍是 regular。
    control.applyPreset(root, "regular", 500);
    expect(writes.get("--panel-width")).toBe("500px");

    // 换档作废它：服务端在选档时已清，本地是「换档」这条规则负责同一时刻。
    control.applyPreset(root, "narrow", 500);
    expect(writes.get("--panel-width")).toBe("320px");
  });

  test("空值不动手头的拖动值——「没变」与「清除」不是一回事", () => {
    const { root, writes } = fakeRoot();
    const control = new PanelWidthControl();

    control.applyPreset(root, "regular", 500);
    control.applyPreset(root, "regular", null);
    expect(writes.get("--panel-width")).toBe("500px");
  });
});

describe("与 Config 的接缝", () => {
  test("持久化只有一座桥：自由宽度走 setPanelWidthPx，恰好像档走 setPanelWidth", async () => {
    const source = await Bun.file("apps/desktop/src/shell/panel-width.ts").text();
    // 两座桥之外没有第三条路，verify:config-authority 守着这条。
    expect(source).toContain('{ kind: "setPanelWidthPx", value: px }');
    expect(source).toContain('{ kind: "setPanelWidth", value: preset }');
  });

  test("持久化的自由宽度真的进了外观投影，不只是写出去就完", async () => {
    const source = await Bun.file("apps/desktop/src/shell/appearance.ts").text();
    expect(source).toContain("appearance.panel_width_px");
  });
});

describe("样式表与模块同一个数", () => {
  test("面板宽度的上限在 CSS 与钳制里是同一个", async () => {
    const css = await Bun.file("apps/desktop/src/styles/surfaces.css").text();
    // 两处（data-quarter 与 dispatch）都引用同一对数；漂移其中一处，
    // 拖到上限的面板会被样式表再钳一次，而模块还以为宽度是自己的。
    const pair = `min(${PANEL_WIDTH_MAX}px, ${PANEL_WIDTH_MAX_VW * 100}vw)`;
    expect(css.split(pair).length - 1).toBeGreaterThanOrEqual(2);
  });
});
