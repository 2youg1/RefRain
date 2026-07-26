/**
 * The display profile decides the frame budget every interaction is measured
 * against, so its edge cases are worth more than its happy path: a zero from a
 * Linux compositor, a fractional Windows scale factor, a panel faster than the
 * 60 Hz most CSS assumes.
 *
 * `Display` is a plain data object in Electron's API, so these run without a
 * window. What they cannot prove is that Electron reports the truth on real
 * hardware — that needs a real monitor and is recorded as such.
 */

import { expect, test } from "bun:test";
import type { Display } from "electron";
import { cssVariables, profileOf } from "../src/main/display.ts";

const display = (
  displayFrequency: number,
  scaleFactor: number,
  size = { width: 1920, height: 1080 },
) => ({ displayFrequency, scaleFactor, size }) as Display;

test("a 60 Hz panel gets the classic frame budget", () => {
  const profile = profileOf(display(60, 1));

  expect(profile.refreshHz).toBe(60);
  expect(profile.frameBudgetMs).toBeCloseTo(16.667, 2);
  expect(profile.highRefresh).toBe(false);
  expect(profile.highDensity).toBe(false);
});

test("a 165 Hz panel gets a budget under seven milliseconds", () => {
  const profile = profileOf(display(165, 1));

  expect(profile.frameBudgetMs).toBeCloseTo(6.06, 2);
  expect(profile.highRefresh).toBe(true);
});

test("a 72 Hz panel counts as high refresh", () => {
  // 61 rather than 75 as the threshold: 72 Hz panels exist and benefit from
  // motion that is not quantised to 60.
  expect(profileOf(display(72, 1)).highRefresh).toBe(true);
});

test("a compositor reporting zero falls back to sixty rather than dividing by zero", () => {
  const profile = profileOf(display(0, 1));

  expect(profile.refreshHz).toBe(60);
  expect(Number.isFinite(profile.frameBudgetMs)).toBe(true);
  expect(profile.frameBudgetMs).toBeCloseTo(16.667, 2);
});

test("a nonsense refresh rate does not produce a nonsense budget", () => {
  for (const reported of [Number.NaN, Number.POSITIVE_INFINITY, -144]) {
    const profile = profileOf(display(reported, 1));
    expect(profile.refreshHz).toBe(60);
    expect(Number.isFinite(profile.frameBudgetMs)).toBe(true);
  }
});

test("a hairline is one device pixel at every density", () => {
  expect(profileOf(display(60, 1)).hairlineCss).toBe(1);
  expect(profileOf(display(60, 2)).hairlineCss).toBe(0.5);
  // 150% is the Windows default on many 4K panels, and the case a 1px border
  // renders blurry on.
  expect(profileOf(display(60, 1.5)).hairlineCss).toBeCloseTo(0.6667, 3);
  expect(profileOf(display(60, 3)).hairlineCss).toBeCloseTo(0.3333, 3);
});

test("a scale factor of zero does not make a hairline infinite", () => {
  const profile = profileOf(display(60, 0));

  expect(profile.scaleFactor).toBe(1);
  expect(Number.isFinite(profile.hairlineCss)).toBe(true);
});

test("an 8K panel at 200% reports its logical size, not its pixel count", () => {
  const profile = profileOf(display(120, 2, { width: 3840, height: 2160 }));

  expect(profile.width).toBe(3840);
  expect(profile.highDensity).toBe(true);
  expect(profile.highRefresh).toBe(true);
});

test("motion is expressed in frames, so a gesture reads the same on any panel", () => {
  const sixty = cssVariables(profileOf(display(60, 1)));
  const fast = cssVariables(profileOf(display(165, 1)));

  // Eight frames either way: 133 ms at 60 Hz, 48 ms at 165 Hz. The count is the
  // constant, not the millisecond value.
  expect(Number.parseFloat(sixty["--motion-normal"] ?? "")).toBeCloseTo(133.3, 0);
  expect(Number.parseFloat(fast["--motion-normal"] ?? "")).toBeCloseTo(48.5, 0);
});

test("every variable the renderer needs carries a unit", () => {
  const variables = cssVariables(profileOf(display(144, 2)));

  expect(variables["--frame-budget"]).toMatch(/ms$/);
  expect(variables["--hairline"]).toMatch(/px$/);
  expect(variables["--motion-quick"]).toMatch(/ms$/);
  // A scale factor is a ratio, so it is the one value that must not carry one.
  expect(variables["--scale-factor"]).toBe("2");
});
