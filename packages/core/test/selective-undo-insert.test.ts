import { describe, expect, test } from "bun:test";
import type { TextAction, TextHead } from "../src/index.ts";
import { applyTextAction, currentText, selectiveUndo } from "../src/index.ts";

/**
 * Selective undo must see the blocks an insertion touched.
 *
 * `InsertTextChange.blockIds` is typed `readonly []` — an empty tuple, so the
 * type itself promises the field never names a block. The block an insertion
 * creates lives in `blockId` instead. Every intersection check in this module
 * walks `blockIds`, which makes an insertion invisible to all of them: undoing
 * an action whose inserted block a later action rewrote reports success and
 * silently discards that later work.
 *
 * This is the failure selective undo exists to prevent. SPEC 7.4 refuses a
 * batch rather than let ordering pick a winner, and the manuscript deserves
 * the same refusal here.
 */

const head = (blocks: { id: string; text: string }[]): TextHead => ({
  id: "h0",
  blocks,
  cause: "fixture",
});

describe("selective undo sees inserted blocks", () => {
  test("undoing an insertion a later action rewrote is refused, not silently applied", () => {
    const start = head([{ id: "b0", text: "甲。" }]);

    /* B inserts a block after b0. Its id lives in `blockId`, not `blockIds`. */
    const insertion: TextAction = {
      id: "a-insert",
      changes: [{ kind: "insert", blockIds: [], text: "乙。", blockId: "b1" }],
      undoes: [],
      at: "2026-07-27T00:00:00.000Z",
      cause: "insert",
    };
    const afterInsert = applyTextAction(start, insertion.changes, insertion.cause);
    expect(currentText(afterInsert)).toBe("甲。\n\n乙。");

    /* C rewrites the block B created. */
    const rewrite: TextAction = {
      id: "a-rewrite",
      changes: [{ kind: "range", blockIds: ["b1"], text: "乙改。" }],
      undoes: [{ kind: "range", blockIds: ["b1"], text: "乙。" }],
      at: "2026-07-27T00:01:00.000Z",
      cause: "rewrite",
    };
    const afterRewrite = applyTextAction(afterInsert, rewrite.changes, rewrite.cause);
    expect(currentText(afterRewrite)).toBe("甲。\n\n乙改。");

    /* Undoing B now would destroy what C wrote, so it must be refused. */
    const result = selectiveUndo(afterRewrite, insertion, [rewrite]);

    if (result.ok) {
      throw new Error(
        `undo was allowed and the manuscript became ${JSON.stringify(currentText(result.head))} — ` +
          "the rewrite in b1 was discarded without a conflict being reported",
      );
    }
    expect(result.reason).toBe("later-action-intersects");
  });
});
