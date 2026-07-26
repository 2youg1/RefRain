import { describe, expect, test } from "bun:test";
import {
  applyTextAction,
  currentText,
  selectiveUndo,
  type TextAction,
  type TextHead,
} from "../src/index.ts";

const head = (blocks: [string, string][]): TextHead => ({
  id: "h0",
  blocks: blocks.map(([id, text]) => ({ id, text })),
  cause: "test",
});

const action = (blockId: string, before: string, after: string): TextAction => ({
  id: `act-${blockId}`,
  changes: [{ blockIds: [blockId], text: after }],
  undoes: [{ blockIds: [blockId], text: before }],
  at: "2026-07-26T00:00:00.000Z",
  cause: "author edit",
});

describe("undoing one action without replaying history", () => {
  test("a disjoint later action keeps its effect exactly", () => {
    const start = head([
      ["b1", "第一句。"],
      ["b2", "第二句。"],
    ]);
    const first = action("b1", "第一句。", "第一句改过。");
    const second = action("b2", "第二句。", "第二句改过。");

    let manuscript = applyTextAction(start, first.changes, first.id);
    manuscript = applyTextAction(manuscript, second.changes, second.id);

    const result = selectiveUndo(manuscript, first, [second]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toBe("第一句。\n\n第二句改过。");
  });

  test("the compensation is appended, so the head advances rather than rewinds", () => {
    const start = head([["b1", "原文。"]]);
    const first = action("b1", "原文。", "改过。");
    const manuscript = applyTextAction(start, first.changes, first.id);

    const result = selectiveUndo(manuscript, first, []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head.id).not.toBe(manuscript.id);
    expect(result.head.cause).toContain("selective-undo");
  });

  test("ten thousand disjoint actions later, the first still undoes cleanly", () => {
    const blocks: [string, string][] = Array.from({ length: 10_001 }, (_, i) => [
      `b${i}`,
      `第 ${i} 句。`,
    ]);
    let manuscript = head(blocks);

    const first = action("b0", "第 0 句。", "第 0 句改过。");
    manuscript = applyTextAction(manuscript, first.changes, first.id);

    const later: TextAction[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const a = action(`b${i}`, `第 ${i} 句。`, `第 ${i} 句改过。`);
      later.push(a);
      manuscript = applyTextAction(manuscript, a.changes, a.id);
    }

    const started = performance.now();
    const result = selectiveUndo(manuscript, first, later);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(currentText(result.head)).toContain("第 0 句。");
    expect(currentText(result.head)).toContain("第 10000 句改过。");
    // Replaying the history would be linear in ten thousand actions; this is
    // one compensating action against the current head.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("when a later action touched the same text", () => {
  test("an intersecting action produces a conflict rather than a silent overwrite", () => {
    const start = head([["b1", "原文。"]]);
    const first = action("b1", "原文。", "第一次改。");
    const second = action("b1", "第一次改。", "第二次改。");

    let manuscript = applyTextAction(start, first.changes, first.id);
    manuscript = applyTextAction(manuscript, second.changes, second.id);

    const result = selectiveUndo(manuscript, first, [second]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("later-action-intersects");
  });

  test("the conflict states all three texts, so the author can judge", () => {
    const start = head([["b1", "原文。"]]);
    const first = action("b1", "原文。", "第一次改。");
    const second = action("b1", "第一次改。", "第二次改。");

    let manuscript = applyTextAction(start, first.changes, first.id);
    manuscript = applyTextAction(manuscript, second.changes, second.id);

    const result = selectiveUndo(manuscript, first, [second]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.before).toBe("原文。");
    expect(result.after).toBe("第一次改。");
    expect(result.current).toBe("第二次改。");
  });

  test("a multi-block conflict reports the block that actually intersected", () => {
    const start = head([
      ["b1", "甲。"],
      ["b2", "乙。"],
    ]);
    const first: TextAction = {
      id: "both",
      changes: [
        { blockIds: ["b1"], text: "甲一。" },
        { blockIds: ["b2"], text: "乙一。" },
      ],
      undoes: [
        { blockIds: ["b1"], text: "甲。" },
        { blockIds: ["b2"], text: "乙。" },
      ],
      at: "2026-07-26T00:00:00.000Z",
      cause: "author edit",
    };
    const second = action("b2", "乙一。", "乙二。");
    let manuscript = applyTextAction(start, first.changes, first.id);
    manuscript = applyTextAction(manuscript, second.changes, second.id);

    const result = selectiveUndo(manuscript, first, [second]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toMatchObject({ before: "乙。", after: "乙一。", current: "乙二。" });
  });

  test("the manuscript is untouched while a conflict awaits judgment", () => {
    const start = head([["b1", "原文。"]]);
    const first = action("b1", "原文。", "第一次改。");
    const second = action("b1", "第一次改。", "第二次改。");

    let manuscript = applyTextAction(start, first.changes, first.id);
    manuscript = applyTextAction(manuscript, second.changes, second.id);
    const before = currentText(manuscript);

    selectiveUndo(manuscript, first, [second]);

    expect(currentText(manuscript)).toBe(before);
  });
});

describe("a compensation is itself undoable", () => {
  test("undoing the undo restores the change", () => {
    const start = head([["b1", "原文。"]]);
    const first = action("b1", "原文。", "改过。");
    const manuscript = applyTextAction(start, first.changes, first.id);

    const undone = selectiveUndo(manuscript, first, []);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;

    const redone = selectiveUndo(undone.head, undone.compensation, []);
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(currentText(redone.head)).toBe("改过。");
  });
});
