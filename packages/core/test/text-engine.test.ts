import { describe, expect, test } from "bun:test";
import type { TextChange, TextHead } from "../src/index.ts";
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

  /**
   * Every insertion scanned the whole block list twice — once to reject a
   * duplicate identifier, once to find the boundary to splice before. Both are
   * linear, both sit inside the loop over changes, and the manuscript SPEC §10
   * names is 10⁵ blocks. Measured before the fix: 20,000 blocks taking 20,000
   * interleaved insertions cost 2370 ms, growing fourfold per doubling.
   *
   * The budget is set far above the fixed cost so an ordinary slow machine
   * passes, while a return to quadratic behaviour fails immediately.
   */
  /**
   * A run of new paragraphs keeps its order by naming its own neighbour: the
   * first insertion's boundary is the second insertion, whose boundary is a
   * block that already exists. The old repeated-splice loop resolved this
   * implicitly, because each insertion was in the array before the next one
   * looked for it. Indexing the blocks once does not have that property, and
   * the first attempt at it threw `cannot insert before missing block` on a
   * chain the unit tests never built — it surfaced only in a scale probe.
   */
  test("an insertion may name another insertion from the same action", () => {
    const before: TextHead = {
      id: "h0",
      blocks: [
        { id: "b0", text: "第一段。" },
        { id: "b1", text: "第二段。" },
      ],
      cause: "seed",
    };

    // n0 before n1, n1 before n2, n2 before the existing b1.
    const after = applyTextAction(
      before,
      [
        { kind: "insert", blockIds: [], blockId: "n0", text: "甲。", beforeBlockId: "n1" },
        { kind: "insert", blockIds: [], blockId: "n1", text: "乙。", beforeBlockId: "n2" },
        { kind: "insert", blockIds: [], blockId: "n2", text: "丙。", beforeBlockId: "b1" },
      ],
      "a chain of insertions",
    );

    expect(after.blocks.map((block) => block.id)).toEqual(["b0", "n0", "n1", "n2", "b1"]);
  });

  test("an insertion chain that closes on itself fails closed", () => {
    const before: TextHead = {
      id: "h0",
      blocks: [{ id: "b0", text: "唯一一段。" }],
      cause: "seed",
    };

    expect(() =>
      applyTextAction(
        before,
        [
          { kind: "insert", blockIds: [], blockId: "n0", text: "甲。", beforeBlockId: "n1" },
          { kind: "insert", blockIds: [], blockId: "n1", text: "乙。", beforeBlockId: "n0" },
        ],
        "a cycle",
      ),
    ).toThrow(/before itself/);
  });

  /**
   * The boundary chain is the shape a run of new paragraphs takes, so walking
   * it must not be quadratic either. Checking the walked set with an array's
   * `includes` measured 39 ms at 8,000 links and rising fourfold per doubling.
   */
  test("a long chain of insertions resolves in linear time", () => {
    const before: TextHead = { id: "h0", blocks: [{ id: "b0", text: "末段。" }], cause: "seed" };
    const changes: TextChange[] = Array.from({ length: 8_000 }, (_, k) => ({
      kind: "insert" as const,
      blockIds: [],
      blockId: `n${k}`,
      text: `第${k}段。`,
      beforeBlockId: k === 7_999 ? "b0" : `n${k + 1}`,
    }));

    const started = performance.now();
    const after = applyTextAction(before, changes, "a chain");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(300);
    expect(after.blocks).toHaveLength(8_001);
    expect(after.blocks[0]?.id).toBe("n0");
    expect(after.blocks.at(-1)?.id).toBe("b0");
  });

  test("interleaved insertions into a long manuscript stay affordable", () => {
    const before: TextHead = {
      id: "h0",
      blocks: Array.from({ length: 20_000 }, (_, i) => ({
        id: `b${i}`,
        text: `第${i}段的正文内容。`,
      })),
      cause: "seed",
    };

    const changes: TextChange[] = Array.from({ length: 20_000 }, (_, k) => ({
      kind: "insert" as const,
      blockIds: [],
      blockId: `n${k}`,
      text: `插入第${k}段。`,
      beforeBlockId: `b${k}`,
    }));

    const started = performance.now();
    const after = applyTextAction(before, changes, "many insertions");
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(400);
    expect(after.blocks).toHaveLength(40_000);
    // Each insertion lands immediately before the block it names.
    expect(after.blocks[0]?.id).toBe("n0");
    expect(after.blocks[1]?.id).toBe("b0");
    expect(after.blocks[2]?.id).toBe("n1");
  });
});
