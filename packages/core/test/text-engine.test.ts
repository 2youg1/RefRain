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

  test("inserting at a lineage boundary is a Text Action", () => {
    const after = applyTextAction(
      head(),
      [
        {
          kind: "insert",
          blockIds: [],
          blockId: "b1.5",
          text: "她没有答。",
          beforeBlockId: "b2",
        },
      ],
      "restore removed block",
    );

    expect(currentText(after)).toBe("黑暗中有人问。\n\n她没有答。\n\n声音很熟。");
    expect(after.cause).toBe("restore removed block");
  });

  test("adjacent insertions resolve their right-hand lineage in one action", () => {
    const after = applyTextAction(
      head(),
      [
        {
          kind: "insert",
          blockIds: [],
          blockId: "b1.5a",
          text: "她停了一会。",
          beforeBlockId: "b1.5b",
        },
        {
          kind: "insert",
          blockIds: [],
          blockId: "b1.5b",
          text: "然后摇头。",
          beforeBlockId: "b2",
        },
      ],
      "insert two paragraphs",
    );

    expect(currentText(after)).toBe("黑暗中有人问。\n\n她停了一会。\n\n然后摇头。\n\n声音很熟。");
  });

  test("an insertion whose lineage boundary vanished fails closed", () => {
    const before = head();

    expect(() =>
      applyTextAction(
        before,
        [
          {
            kind: "insert",
            blockIds: [],
            blockId: "b1.5",
            text: "她没有答。",
            beforeBlockId: "gone",
          },
        ],
        "restore removed block",
      ),
    ).toThrow("cannot insert before missing block gone");
    expect(currentText(before)).toBe("黑暗中有人问。\n\n声音很熟。");
  });
});
