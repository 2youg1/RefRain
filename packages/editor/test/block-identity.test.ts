import { describe, expect, test } from "bun:test";
import { type Block, replaceText } from "../src/index.ts";

/*
 * SPEC 7.3: a block id survives a replacement.
 *
 * Minting a fresh id on replacement detaches every queued Proposal, every
 * compensating undo, and every decoration anchor at once — silently, because
 * nothing throws. Selective undo is the only feature that exposes it, which is
 * why the assertion lives here rather than waiting for that feature to exist.
 */
describe("block identity", () => {
  const block: Block = { id: "01923f4c-7b2a-7000-8000-000000000001", text: "原文。" };

  test("a replacement keeps the block's id", () => {
    expect(replaceText(block, "改写后。").id).toBe(block.id);
  });

  test("a replacement carries the new text", () => {
    expect(replaceText(block, "改写后。").text).toBe("改写后。");
  });

  test("an empty replacement is a deletion, not a no-op", () => {
    const delta = replaceText(block, "");
    expect(delta.id).toBe(block.id);
    expect(delta.text).toBe("");
  });

  test("replacing does not mutate the block it was given", () => {
    replaceText(block, "改写后。");
    expect(block.text).toBe("原文。");
  });
});
