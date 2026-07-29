import { afterEach, describe, expect, test } from "bun:test";
import { cancelScheduledFrame, scheduleFrame } from "../src/frame-scheduler";

const original = globalThis.requestAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = original;
});

describe("frame scheduler", () => {
  test("one frame keeps the latest write for each concern", () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    const writes: string[] = [];

    scheduleFrame("display", () => writes.push("stale"));
    scheduleFrame("display", () => writes.push("current"));
    scheduleFrame("rail", () => writes.push("rail"));

    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(writes).toEqual(["current", "rail"]);
  });

  test("a cancelled concern does not write", () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as typeof requestAnimationFrame;
    let wrote = false;

    scheduleFrame("display", () => {
      wrote = true;
    });
    cancelScheduledFrame("display");
    frames[0]?.(0);

    expect(wrote).toBe(false);
  });
});
