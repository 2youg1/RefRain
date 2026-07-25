import { describe, expect, test } from "bun:test";
import type { TextHead } from "../src/index.ts";
import { applyTextAction, blockAt, currentText } from "../src/index.ts";

const head = (): TextHead => ({
  id: "h0",
  blocks: [
    { id: "b1", text: "黑暗中有人问。" },
    { id: "b2", text: "声音很熟。" },
  ],
  cause: "initial",
});

describe("Text Action", () => {
  test("replacing a block yields a new Text Head, leaving the old one intact", () => {
    const before = head();
    const after = applyTextAction(before, [{ blockIds: ["b2"], text: "剑没有松。" }], "test");

    expect(currentText(after)).toBe("黑暗中有人问。\n\n剑没有松。");
    expect(currentText(before)).toBe("黑暗中有人问。\n\n声音很熟。");
    expect(after.id).not.toBe(before.id);
  });

  test("an untouched block keeps its identity across the action", () => {
    const before = head();
    const after = applyTextAction(before, [{ blockIds: ["b2"], text: "剑没有松。" }], "test");

    expect(blockAt(after, "b1")).toEqual(blockAt(before, "b1"));
  });
});
