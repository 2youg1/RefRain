import { describe, expect, test } from "bun:test";
import { placeContextMenu } from "../src/shell/context-menu-placement";

const viewport = { width: 800, height: 600 };
const menu = { width: 160, height: 184 };

const overlaps = (
  placement: { x: number; y: number; width: number; height: number },
  anchor: { left: number; top: number; right: number; bottom: number },
): boolean =>
  placement.x < anchor.right &&
  placement.x + placement.width > anchor.left &&
  placement.y < anchor.bottom &&
  placement.y + placement.height > anchor.top;

describe("context menu placement", () => {
  test("uses the right side when it is available", () => {
    const anchor = { left: 300, top: 240, right: 360, bottom: 260 };
    const placed = placeContextMenu(anchor, { x: 330, y: 250 }, viewport, menu);
    expect(placed.x).toBeGreaterThan(anchor.right);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("flips left at the right edge", () => {
    const anchor = { left: 720, top: 240, right: 780, bottom: 260 };
    const placed = placeContextMenu(anchor, { x: 750, y: 250 }, viewport, menu);
    expect(placed.x + placed.width).toBeLessThan(anchor.left);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("moves above when horizontal space is unavailable near the bottom", () => {
    const anchor = { left: 4, top: 560, right: 796, bottom: 580 };
    const placed = placeContextMenu(anchor, { x: 400, y: 570 }, viewport, menu);
    expect(placed.y + placed.height).toBeLessThan(anchor.top);
    expect(overlaps(placed, anchor)).toBe(false);
  });

  test("shrinks to a small viewport and stays inside its edges", () => {
    const placed = placeContextMenu(
      { left: 140, top: 100, right: 180, bottom: 120 },
      { x: 160, y: 110 },
      { width: 240, height: 180 },
      menu,
    );
    expect(placed.width).toBeLessThanOrEqual(216);
    expect(placed.height).toBeLessThanOrEqual(156);
    expect(placed.x).toBeGreaterThanOrEqual(12);
    expect(placed.y).toBeGreaterThanOrEqual(12);
    expect(placed.x + placed.width).toBeLessThanOrEqual(228);
    expect(placed.y + placed.height).toBeLessThanOrEqual(168);
  });
});
