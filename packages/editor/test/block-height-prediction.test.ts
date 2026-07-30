/**
 * Does predicting from shape beat averaging?
 *
 * The claim is that a block's height is not a quantity to be guessed from other
 * blocks: its shape is known from its bytes. This test measures the claim on a
 * clustered corpus, because that is where a bad estimator shows. A uniform
 * random corpus makes every estimator look fine — the fixture would be too
 * kind, and the gate would pass on an estimator that fails in a real document.
 *
 * The metric is prefix-sum error, because that is what the viewport asks for:
 * "how tall is everything above block k". And it is the worst case, not the
 * median, because what an author perceives is the scrollbar jumping — a tail
 * event, not a typical one.
 */
import { describe, expect, test } from "bun:test";
import { BlockHeightIndex } from "../src/block-height-index";

const BLOCKS = 4000;

/**
 * Real manuscripts cluster: long passages of prose, then a run of dialogue,
 * then a code listing. Heights are correlated with position, which is exactly
 * what defeats a single average.
 */
function clusteredHeights(): number[] {
  const heights: number[] = [];
  let cursor = 0;
  while (heights.length < BLOCKS) {
    const runLength = 20 + (cursor % 7) * 15;
    const kind = cursor % 4;
    const height = kind === 0 ? 320 : kind === 1 ? 38 : kind === 2 ? 92 : 56;
    for (let index = 0; index < runLength && heights.length < BLOCKS; index += 1) {
      heights.push(height);
    }
    cursor += 1;
  }
  return heights;
}

/**
 * Lines the shape scan would predict.
 *
 * **This fixture was too kind on the first pass and it produced a false 0.00%.**
 * Dividing the true height by a constant makes the prediction exactly
 * proportional to the truth, so alpha recovers it perfectly and the estimator
 * looks flawless. A real prediction is not proportional to the truth: the shape
 * knows display width and hard breaks, but not where a line happens to break,
 * how a fence is styled, or that this paragraph ends one character past a line
 * boundary. Those are per-block errors that no global scalar can absorb.
 *
 * So each prediction carries a deterministic per-block error of up to ±18%,
 * plus a systematic factor for alpha to find. A fixture that cannot fail an
 * estimator cannot certify one either.
 */
function predictionsFor(heights: readonly number[]): number[] {
  return heights.map((height, index) => {
    const wobble = 1 + (((index * 37) % 41) / 41 - 0.5) * 0.36;
    return (height / 18.5) * wobble;
  });
}

function worstPrefixError(index: BlockHeightIndex, truth: readonly number[]): number {
  let running = 0;
  let worst = 0;
  for (let count = 1; count <= truth.length; count += 1) {
    running += truth[count - 1] ?? 0;
    const estimated = index.prefix(count);
    worst = Math.max(worst, Math.abs(estimated - running) / running);
  }
  return worst;
}

/** Measure a spread-out sample, as scrolling would. */
function measureSample(index: BlockHeightIndex, truth: readonly number[], count: number): void {
  const stride = Math.max(1, Math.floor(truth.length / count));
  for (let at = 0; at < truth.length && at / stride < count; at += stride) {
    index.update(at, truth[at] ?? 0);
  }
}

describe("predicting block heights from shape", () => {
  const truth = clusteredHeights();
  const predictions = predictionsFor(truth);

  test("a single global average is as bad as reported, on this corpus", () => {
    const flat = BlockHeightIndex.uniform(truth.length, 40);
    measureSample(flat, truth, 200);
    // Its estimate stays the constructor's, which is what the old code did.
    const error = worstPrefixError(flat, truth);
    expect(error).toBeGreaterThan(0.2);
  });

  test("shape predictions plus one calibration scalar beat it by a wide margin", () => {
    const shaped = BlockHeightIndex.uniform(truth.length, 40);
    shaped.setPredictedLines(predictions);
    measureSample(shaped, truth, 200);

    const flat = BlockHeightIndex.uniform(truth.length, 40);
    measureSample(flat, truth, 200);

    const shapedError = worstPrefixError(shaped, truth);
    const flatError = worstPrefixError(flat, truth);
    console.log(
      `worst prefix error — shaped ${(shapedError * 100).toFixed(2)}% vs flat ${(flatError * 100).toFixed(2)}%`,
    );
    expect(shapedError).toBeLessThan(flatError / 3);
  });

  test("the calibration converges within a few dozen measurements", () => {
    // Measured: alpha reaches ~18.5 (the true factor) by 10 samples and stays
    // there — 17.46 at 10, 18.29 at 20, 18.65 at 200, 18.60 at 2000.
    const few = BlockHeightIndex.uniform(truth.length, 40);
    few.setPredictedLines(predictions);
    measureSample(few, truth, 10);

    const many = BlockHeightIndex.uniform(truth.length, 40);
    many.setPredictedLines(predictions);
    measureSample(many, truth, 500);

    expect(Math.abs(many.calibration - 18.5)).toBeLessThan(0.5);
    expect(Math.abs(few.calibration - 18.5)).toBeLessThan(1.5);
  });

  test("the residual error is per-block shape error, which no global scalar removes", () => {
    // This is the honest ceiling, and worth stating so nobody tunes toward a
    // number the design cannot reach. alpha absorbs a systematic factor; it
    // cannot absorb the ±18% per-block error this fixture injects, so the
    // worst-case prefix error settles at 7-9% and more samples do not lower it.
    // Reducing it further means a better shape formula, not a better scalar.
    const index = BlockHeightIndex.uniform(truth.length, 40);
    index.setPredictedLines(predictions);
    measureSample(index, truth, 500);
    const error = worstPrefixError(index, truth);
    expect(error).toBeLessThan(0.12);
    expect(error).toBeGreaterThan(0.02);
  });

  test("with nothing measured it falls back to the flat estimate", () => {
    const index = BlockHeightIndex.uniform(10, 40);
    index.setPredictedLines([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    // No calibration exists yet, so predictions cannot be turned into pixels.
    expect(index.prefix(10)).toBe(400);
  });

  test("a measured block leaves the prediction tree exactly once", () => {
    const index = BlockHeightIndex.uniform(3, 40);
    index.setPredictedLines([2, 2, 2]);
    index.update(0, 37);
    // One measured block at 37px over 2 predicted lines: alpha = 18.5.
    // The other two are predicted: 2 lines * 18.5 each.
    expect(index.prefix(3)).toBeCloseTo(37 + 2 * 37, 5);
    // Measuring the same block again must not double-count its lines.
    index.update(0, 74);
    expect(index.calibration).toBeCloseTo(37, 5);
  });

  test("invalidating a block returns it to the prediction tree", () => {
    const index = BlockHeightIndex.uniform(3, 40);
    index.setPredictedLines([2, 2, 2]);
    index.update(0, 37);
    index.update(1, 37);
    const before = index.prefix(3);
    index.invalidate(1);
    index.update(1, 37);
    expect(index.prefix(3)).toBeCloseTo(before, 5);
  });

  test("blocks without a shape still use the flat estimate", () => {
    const index = BlockHeightIndex.uniform(4, 40);
    // Only the first two carry shapes.
    index.setPredictedLines([2, 2]);
    index.update(0, 37);
    // block 1 predicted at alpha (18.5) * 2 lines; blocks 2 and 3 unshaped.
    expect(index.prefix(4)).toBeCloseTo(37 + 37 + 40 + 40, 5);
  });
});
