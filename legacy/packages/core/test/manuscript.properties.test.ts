import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  applyTextAction,
  currentText,
  parseSource,
  selectiveUndo,
  serializeSource,
  type TextAction,
  type TextHead,
} from "../src/index.ts";

const PROPERTY = { numRuns: 300, seed: 0x5eed } as const;
const characters = [
  ...Array.from("中文Latin 0123。！？`~#>_-*"),
  "\n",
  "\r",
  "\t",
  "　",
  "﻿",
  "😀",
] as const;
const text = fc
  .array(fc.constantFrom(...characters), { minLength: 0, maxLength: 400 })
  .map((parts) => parts.join(""));
const inline = fc
  .array(fc.constantFrom(...Array.from("中文Latin 0123。！？_-")), {
    minLength: 1,
    maxLength: 24,
  })
  .map((parts) => parts.join(""));

const manuscript = (): TextHead => ({
  id: "property-head",
  blocks: Array.from({ length: 16 }, (_, index) => ({
    id: `b${index}`,
    text: `原文 ${index}。`,
  })),
  cause: "property fixture",
});

const action = (index: number, after: string): TextAction => ({
  id: `a${index}`,
  changes: [{ blockIds: [`b${index}`], text: after }],
  undoes: [{ blockIds: [`b${index}`], text: `原文 ${index}。` }],
  at: "2026-07-28T00:00:00.000Z",
  cause: "property action",
});

describe("manuscript invariants as properties", () => {
  test("loading and saving an unedited Markdown string is byte-identical", () => {
    fc.assert(
      fc.property(text, (source) => {
        expect(serializeSource(parseSource(source), new Map())).toBe(source);
      }),
      PROPERTY,
    );
  });

  test("a random sequence of disjoint Text Actions can be selectively undone in any order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ index: fc.integer({ min: 0, max: 15 }), after: inline }), {
          minLength: 1,
          maxLength: 8,
          selector: (draft) => draft.index,
        }),
        fc.array(fc.integer(), { minLength: 8, maxLength: 8 }),
        (drafts, priority) => {
          const start = manuscript();
          const actions = drafts.map((draft) => action(draft.index, `改写 ${draft.after}`));
          let current = actions.reduce(
            (head, next) => applyTextAction(head, next.changes, next.id),
            start,
          );
          const undoOrder = actions
            .map((next, index) => ({ next, index }))
            .sort((left, right) => priority[left.index]! - priority[right.index]!)
            .map(({ next }) => next);

          for (const next of undoOrder) {
            const appliedAt = actions.indexOf(next);
            const result = selectiveUndo(current, next, actions.slice(appliedAt + 1));
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            current = result.head;
          }
          expect(currentText(current)).toBe(currentText(start));
        },
      ),
      PROPERTY,
    );
  });

  test("an intersecting later action always refuses selective undo without changing the head", () => {
    fc.assert(
      fc.property(inline, inline, inline, (before, middle, after) => {
        const start: TextHead = {
          id: "h0",
          blocks: [{ id: "b0", text: `前 ${before}` }],
          cause: "property fixture",
        };
        const first: TextAction = {
          id: "first",
          changes: [{ blockIds: ["b0"], text: `中 ${middle}` }],
          undoes: [{ blockIds: ["b0"], text: `前 ${before}` }],
          at: "2026-07-28T00:00:00.000Z",
          cause: "first",
        };
        const later: TextAction = {
          id: "later",
          changes: [{ blockIds: ["b0"], text: `后 ${after}` }],
          undoes: [{ blockIds: ["b0"], text: `中 ${middle}` }],
          at: "2026-07-28T00:00:01.000Z",
          cause: "later",
        };
        const current = applyTextAction(
          applyTextAction(start, first.changes, first.id),
          later.changes,
          later.id,
        );
        const bytes = currentText(current);
        const result = selectiveUndo(current, first, [later]);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe("later-action-intersects");
        expect(currentText(current)).toBe(bytes);
      }),
      PROPERTY,
    );
  });
});
