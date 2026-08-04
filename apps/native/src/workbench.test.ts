import { expect, test } from "bun:test";
import {
  DESTINATION_COUNT,
  DESTINATION_MANUSCRIPT,
  destinationAt,
  destinationForOrdinal,
  isDestination,
  NAVIGATION_MOVED,
  NAVIGATION_NEEDS_DOCUMENT,
  NAVIGATION_UNCHANGED,
  navigate,
  needsDocument,
  settleAfterDocument,
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

test("every destination is reachable by its key position and survives the index round trip", () => {
  for (let index = 0; index < DESTINATION_COUNT; index += 1) {
    expect(destinationForOrdinal(index + 1)).toBe(index);
    expect(destinationAt(index)).toBe(index);
    expect(isDestination(index)).toBe(true);
  }
});

test("a key or index outside the destination list refuses rather than lands somewhere", () => {
  // 极值：0 与末位加一各在两端外。回落必须是稿子，不是「最后一个去处」。
  expect(destinationForOrdinal(0)).toBe(-1);
  expect(destinationForOrdinal(DESTINATION_COUNT + 1)).toBe(-1);
  expect(destinationForOrdinal(1.5)).toBe(-1);
  expect(destinationAt(-1)).toBe(DESTINATION_MANUSCRIPT);
  expect(destinationAt(DESTINATION_COUNT)).toBe(DESTINATION_MANUSCRIPT);
  expect(destinationAt(1.5)).toBe(DESTINATION_MANUSCRIPT);
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

test("navigating to where you already are reports unchanged, not a move", () => {
  // 近失手：把「已经在这里」当成一次 move，会重发一次请求并重放动画。
  expect(navigate(1, 1, false)).toBe(NAVIGATION_UNCHANGED);
  expect(navigate(2, 2, true)).toBe(NAVIGATION_UNCHANGED);
});

test("closing the manuscript evicts a destination that was reading it", () => {
  expect(settleAfterDocument(2, false)).toBe(DESTINATION_MANUSCRIPT);
  expect(settleAfterDocument(6, false)).toBe(DESTINATION_MANUSCRIPT);
  // 不读稿子的去处留在原地：换项目不该把作者从设置里赶出来。
  expect(settleAfterDocument(7, false)).toBe(7);
  expect(settleAfterDocument(2, true)).toBe(2);
});
