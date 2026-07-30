import { describe, expect, test } from "bun:test";
import { applyLocally, type Block } from "../src/index";

const percentile = (samples: number[], fraction: number): number => {
  const ordered = samples.toSorted((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? Number.POSITIVE_INFINITY;
};

describe("editor input scale", () => {
  test("a settled replacement does not copy or scan a 100,000-block projection", () => {
    const blocks: Block[] = Array.from({ length: 100_000 }, (_, index) => ({
      id: `b:${index}`,
      text: `text ${index}`,
    }));
    const original = blocks;
    const samples: number[] = [];
    let current = blocks;

    for (let index = 0; index < 500; index += 1) {
      const started = performance.now();
      current = applyLocally(current, [
        { kind: "replace", blocks: ["b:50000"], text: `changed ${index}` },
      ]);
      samples.push(performance.now() - started);
    }

    expect(current).toBe(original);
    expect(current[50_000]?.text).toBe("changed 499");
    expect(percentile(samples, 0.95)).toBeLessThan(4);
  });
});
