import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextChange, TextHead } from "../src/index.ts";
import { applyTextAction, blockAt, currentText, loadProject, saveChapter } from "../src/index.ts";

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

  test("a shuffled cross-block replacement stays block-identical after save and reload", () => {
    const root = mkdtempSync(join(tmpdir(), "refrain-cross-block-"));
    const path = join(root, "01.md");
    writeFileSync(path, "甲。\n\n乙。\n\n丙。\n");

    try {
      const project = loadProject(root);
      const chapter = project.chapters[0];
      const [first, second, third] = chapter?.head.blocks ?? [];
      if (
        chapter === undefined ||
        first === undefined ||
        second === undefined ||
        third === undefined
      )
        throw new Error("cross-block fixture did not load three blocks");

      const after = applyTextAction(
        chapter.head,
        [{ blockIds: [first.id, second.id], text: "乙改。\n\n甲改。" }],
        "shuffled cross-block replacement",
      );
      const saved = saveChapter(project, chapter.id, after, chapter.stamp);
      if (!saved.ok) throw new Error(`cross-block fixture refused save: ${saved.reason}`);
      const reparsed = loadProject(root).chapters[0]?.head;
      if (reparsed === undefined) throw new Error("saved cross-block fixture did not reload");

      expect(readFileSync(path, "utf8")).toBe("乙改。\n\n甲改。\n\n丙。\n");
      expect(after.blocks).toEqual(reparsed.blocks);
      expect(after.blocks.map((block) => block.id)).toEqual([first.id, second.id, third.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two changes on one block are refused rather than silently merged", () => {
    // A run returning several Review Slices for one Edit Scope produces exactly
    // this. The map was keyed on blockIds[0], so the second verdict overwrote
    // the first and the reader lost a judgment they had signed, with no message.
    expect(() =>
      applyTextAction(
        head(),
        [
          { blockIds: ["b2"], text: "剑没有松。" },
          { blockIds: ["b2"], text: "剑落下了。" },
        ],
        "test",
      ),
    ).toThrow(/two changes address block b2/);
  });

  test("a later change inside a multi-block scope is refused rather than duplicated", () => {
    expect(() =>
      applyTextAction(
        head(),
        [
          { blockIds: ["b1", "b2"], text: "第一段改。\n\n第二段改。" },
          { blockIds: ["b2"], text: "第二段又改。" },
        ],
        "overlapping range changes",
      ),
    ).toThrow(/two changes address block b2/);
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

  /**
   * Where a chain of insertions lands is decided by the chain, not by the order
   * the changes happen to arrive in. Grouping them by slot and keeping each
   * group in declaration order looks right whenever the caller declared the
   * chain head first — which is what every other test here does, and why this
   * defect survived three tests written to cover exactly this feature. Shuffled
   * declaration produced a manuscript in the wrong order, silently, where the
   * previous implementation had refused the action outright.
   */
  test("a chain lands in chain order however it was declared", () => {
    const before: TextHead = { id: "h0", blocks: [{ id: "k", text: "末段。" }], cause: "seed" };
    const link = (id: string, text: string, beforeBlockId: string): TextChange => ({
      kind: "insert",
      blockIds: [],
      blockId: id,
      text,
      beforeBlockId,
    });

    // A before B, B before C, C before the existing block.
    const a = link("A", "甲。", "B");
    const b = link("B", "乙。", "C");
    const c = link("C", "丙。", "k");

    for (const declared of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [a, c, b],
    ]) {
      const after = applyTextAction(before, declared, "a shuffled chain");
      expect(after.blocks.map((block) => block.id)).toEqual(["A", "B", "C", "k"]);
    }
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
