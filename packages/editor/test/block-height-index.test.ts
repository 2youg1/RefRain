import { describe, expect, test } from "bun:test";
import { BlockHeightIndex } from "../src/block-height-index";

describe("block height index", () => {
  test("prefix heights and scroll lookup stay local at 100,000 blocks", () => {
    const heights = Array.from({ length: 100_000 }, (_, index) => (index % 10 === 0 ? 180 : 40));
    const index = new BlockHeightIndex(heights);

    expect(index.length).toBe(100_000);
    expect(index.prefix(10)).toBe(540);
    expect(index.span(10, 20)).toBe(540);
    expect(index.atOffset(0)).toBe(0);
    expect(index.atOffset(179)).toBe(0);
    expect(index.atOffset(180)).toBe(1);
    expect(index.atOffset(index.prefix(50_000) + 2)).toBe(50_000);

    const total = index.total;
    index.update(50_000, 240);
    expect(index.total).toBe(total + 60);
    expect(index.prefix(50_000)).toBe(2_700_000);
    expect(index.prefix(50_001)).toBe(2_700_240);
  });

  test("invalid measurements cannot corrupt the scroll model", () => {
    const index = new BlockHeightIndex([40, 40]);
    index.update(0, Number.NaN);
    index.update(1, -10);

    expect(index.total).toBe(80);
    expect(index.span(-20, 99)).toBe(80);
    expect(index.atOffset(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("unknown blocks share an estimate without overwriting measured blocks", () => {
    const index = BlockHeightIndex.uniform(100_000, 40);

    index.update(0, 180);
    index.update(50_000, 240);
    index.setEstimate(60);

    expect(index.measuredAverage).toBe(210);
    expect(index.prefix(1)).toBe(180);
    expect(index.span(1, 50_000)).toBe(49_999 * 60);
    expect(index.atOffset(index.prefix(50_000) + 2)).toBe(50_000);

    index.invalidate(50_000);
    expect(index.measuredAverage).toBe(180);
    expect(index.span(50_000, 50_001)).toBe(60);
  });
});
