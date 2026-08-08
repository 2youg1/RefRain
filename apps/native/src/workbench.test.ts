import { expect, test } from "bun:test";
import {
  clampRailFraction,
  DESTINATION_COUNT,
  DESTINATION_DISPATCH,
  DESTINATION_FILES,
  DESTINATION_MANUSCRIPT,
  DESTINATION_REVIEW,
  DESTINATION_SETTINGS,
  destinationAt,
  destinationForOrdinal,
  hasRoster,
  isAgentDestination,
  layoutFraction,
  MAX_VISIBLE_LAYERS,
  NAVIGATION_CLOSE,
  NAVIGATION_MOVED,
  NAVIGATION_NEEDS_DOCUMENT,
  NAVIGATION_UNCHANGED,
  navigate,
  needsDocument,
  RAIL_FRACTION_DEFAULT,
  settleAfterDocument,
  stackDepth,
  visibleDepth,
  visibleLayerAt,
} from "./workbench.ts";

test("the needs-document mask names exactly the destinations that read a manuscript", () => {
  // 掩码是手算的常量，所以这条把每一位摊开写死：算错一位在别处只表现为
  // 「某个面板偶尔能空开」，很难归因。
  const expected = [false, false, true, true, true, false, true, false];
  expect(expected.length).toBe(DESTINATION_COUNT);
  expected.forEach((needs, index) => {
    expect(needsDocument(index)).toBe(needs);
  });
});

test("the four quarters own their keys; the rest stay reachable by their position", () => {
  // 旧版 quarters：Cmd+1=设置、Cmd+2=文件、Cmd+3=编辑（正文）、Cmd+4=Agent（记忆）。
  expect(destinationForOrdinal(1, DESTINATION_DISPATCH)).toBe(DESTINATION_SETTINGS);
  expect(destinationForOrdinal(2, DESTINATION_DISPATCH)).toBe(DESTINATION_FILES);
  expect(destinationForOrdinal(3, DESTINATION_DISPATCH)).toBe(DESTINATION_MANUSCRIPT);
  // Agent 区回落到记住的去处，而不是某个固定面板。
  expect(destinationForOrdinal(4, 6)).toBe(6);
  expect(destinationForOrdinal(4, 4)).toBe(4);
  // 记忆值坏了（越界）时回落到派发。
  expect(destinationForOrdinal(4, -1)).toBe(DESTINATION_DISPATCH);
  expect(destinationForOrdinal(4, 99)).toBe(DESTINATION_DISPATCH);
  // 直达键位：Cmd+5..8 与旧版不变（原生的肌肉记忆保留）。
  expect(destinationForOrdinal(5, DESTINATION_DISPATCH)).toBe(4);
  expect(destinationForOrdinal(8, DESTINATION_DISPATCH)).toBe(7);
});

test("a key or index outside the destination list refuses rather than lands somewhere", () => {
  // 极值：0 与末位加一各在两端外。回落必须是稿子，不是「最后一个去处」。
  expect(destinationForOrdinal(0, DESTINATION_DISPATCH)).toBe(-1);
  expect(destinationForOrdinal(9, DESTINATION_DISPATCH)).toBe(-1);
  expect(destinationAt(-1)).toBe(DESTINATION_MANUSCRIPT);
  expect(destinationAt(DESTINATION_COUNT)).toBe(DESTINATION_MANUSCRIPT);
  // 越界的下标不该被当成「需要稿子」——那会让一次坏输入伪装成一次合理拒绝。
  expect(needsDocument(DESTINATION_COUNT)).toBe(false);
  expect(needsDocument(-1)).toBe(false);
});

test("destinations that read a manuscript refuse to open without one", () => {
  for (let index = 0; index < DESTINATION_COUNT; index += 1) {
    if (!needsDocument(index)) continue;
    expect(navigate(DESTINATION_MANUSCRIPT, index, false)).toBe(NAVIGATION_NEEDS_DOCUMENT);
    expect(navigate(DESTINATION_MANUSCRIPT, index, true)).toBe(NAVIGATION_MOVED);
  }
});

test("pressing the same key again closes the destination (old stack: already on top)", () => {
  // 近失手：把「同键再按」当成一次 move，会重发一次请求并重放动画。
  expect(navigate(2, 2, true)).toBe(NAVIGATION_CLOSE);
  expect(navigate(7, 7, false)).toBe(NAVIGATION_CLOSE);
  // 稿子没有可关的：回到稿子就是留在稿子。
  expect(navigate(DESTINATION_MANUSCRIPT, DESTINATION_MANUSCRIPT, true)).toBe(NAVIGATION_UNCHANGED);
  // 文件区是侧栏不是面板：同键再按同样关闭（回正文全宽）。
  expect(navigate(DESTINATION_FILES, DESTINATION_FILES, false)).toBe(NAVIGATION_CLOSE);
});

test("closing the manuscript evicts a destination that was reading it", () => {
  expect(settleAfterDocument(2, false)).toBe(DESTINATION_MANUSCRIPT);
  expect(settleAfterDocument(6, false)).toBe(DESTINATION_MANUSCRIPT);
  // 不读稿子的去处留在原地：换项目不该把作者从设置里赶出来。
  expect(settleAfterDocument(7, false)).toBe(7);
  expect(settleAfterDocument(2, true)).toBe(2);
});

test("the agent layer is exactly the destinations Cmd+4 will remember", () => {
  // 裁决/派发/信箱/连接/历史是 Agent 层；稿子/文件/设置不是。
  expect(isAgentDestination(2)).toBe(true);
  expect(isAgentDestination(3)).toBe(true);
  expect(isAgentDestination(4)).toBe(true);
  expect(isAgentDestination(5)).toBe(true);
  expect(isAgentDestination(6)).toBe(true);
  expect(isAgentDestination(0)).toBe(false);
  expect(isAgentDestination(1)).toBe(false);
  expect(isAgentDestination(7)).toBe(false);
  expect(isAgentDestination(8)).toBe(false);
});

test("the roster destinations are exactly the four with a list to walk", () => {
  // 裁决/派发/信箱/连接有名录；历史没有（它的行是只读的回档名录，由
  // 自己的键走）。这张表是名录键（Ctrl+J/K 与 Alt+J/K）接管的边界。
  expect(hasRoster(DESTINATION_REVIEW)).toBe(true);
  expect(hasRoster(DESTINATION_DISPATCH)).toBe(true);
  expect(hasRoster(4)).toBe(true);
  expect(hasRoster(5)).toBe(true);
  expect(hasRoster(DESTINATION_MANUSCRIPT)).toBe(false);
  expect(hasRoster(DESTINATION_FILES)).toBe(false);
  expect(hasRoster(6)).toBe(false);
  expect(hasRoster(DESTINATION_SETTINGS)).toBe(false);
  expect(hasRoster(8)).toBe(false);
});

test("the visible stack lists panel layers bottom-to-top with the current last", () => {
  // 栈记的是离开的去处（当前层不在栈里）：stack = 1（文件在栈底），
  // 当前层是派发台——可见 = 栈里的面板层 + 当前层。
  const stack = 1;
  expect(visibleDepth(stack, 3)).toBe(2);
  expect(visibleLayerAt(stack, 3, 0)).toBe(DESTINATION_FILES);
  expect(visibleLayerAt(stack, 3, 1)).toBe(3);
  // 独占去处（裁决）当前时：没有侧层。
  expect(visibleDepth(stack, 2)).toBe(0);
  // 超过上限时最旧的层先藏：栈 [文件,派发,信箱] + 当前连接 → 只露三层。
  const deep = 1 + (3 << 3) + (4 << 6);
  expect(stackDepth(deep)).toBe(3);
  expect(visibleDepth(deep, 5)).toBe(MAX_VISIBLE_LAYERS);
  expect(visibleLayerAt(deep, 5, 0)).toBe(3); // 文件被藏起
  expect(visibleLayerAt(deep, 5, 1)).toBe(4);
  expect(visibleLayerAt(deep, 5, 2)).toBe(5);
  // 栈里的独占层不算面板层：栈 [文件,裁决] + 当前派发 → 文件与派发。
  const mixed = 1 + (2 << 3);
  expect(visibleDepth(mixed, 3)).toBe(2);
  expect(visibleLayerAt(mixed, 3, 0)).toBe(DESTINATION_FILES);
  expect(visibleLayerAt(mixed, 3, 1)).toBe(3);
});

test("the split layout is a pure projection of the destination", () => {
  // 稿子与裁决（独占舞台）全宽。
  expect(layoutFraction(DESTINATION_MANUSCRIPT, RAIL_FRACTION_DEFAULT)).toBe(1.0);
  expect(layoutFraction(2, RAIL_FRACTION_DEFAULT)).toBe(1.0);
  // 文件区：侧栏在左，用作者拖出来的宽度。
  expect(layoutFraction(DESTINATION_FILES, RAIL_FRACTION_DEFAULT)).toBe(RAIL_FRACTION_DEFAULT);
  expect(layoutFraction(DESTINATION_FILES, 0.3)).toBe(0.3);
  // 其余去处：面板 32%（≈400px/1280px）在左，正文让到右——单侧极简，
  // 与旧版 panel 同侧（inset-inline-start）同源。
  expect(layoutFraction(3, RAIL_FRACTION_DEFAULT)).toBe(0.32);
  expect(layoutFraction(7, RAIL_FRACTION_DEFAULT)).toBe(0.32);
});

test("the rail fraction clamps to a usable band", () => {
  expect(clampRailFraction(0.05)).toBe(0.1);
  expect(clampRailFraction(0.9)).toBe(0.4);
  expect(clampRailFraction(RAIL_FRACTION_DEFAULT)).toBe(RAIL_FRACTION_DEFAULT);
  expect(clampRailFraction(Number.NaN)).toBe(RAIL_FRACTION_DEFAULT);
});
