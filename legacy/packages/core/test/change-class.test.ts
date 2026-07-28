import { describe, expect, test } from "bun:test";
import type { ReviewSlice, SliceKind } from "../src/index.ts";
import { classifyChange, classifyProposal } from "../src/index.ts";

/** Classification reads kind and text; lead and trail are spacing, not signal. */
const slice = (id: string, kind: SliceKind, text: string): ReviewSlice => ({
  id,
  kind,
  text,
  lead: "",
  trail: "",
});

/**
 * The safety property this file exists for: a semantic change must never be
 * classified as formatting. A missed formatting fix costs one keystroke; a
 * meaning change waved through in bulk costs the author a sentence they never
 * agreed to, in a manuscript they will publish under their own name.
 */

describe("Change classification", () => {
  test("half-width to full-width punctuation is formatting", () => {
    expect(classifyChange("他说,好。", "他说，好。")).toBe("formatting");
  });

  test("removing a space between Chinese and Latin is formatting", () => {
    expect(classifyChange("用 Bun 跑", "用Bun跑")).toBe("formatting");
  });

  test("straight quotes to typographic quotes is formatting", () => {
    expect(classifyChange('他说"走"', "他说「走」")).toBe("formatting");
  });

  test("ellipsis normalisation is formatting", () => {
    expect(classifyChange("等等...", "等等……")).toBe("formatting");
  });

  test("moving punctuation across a clause boundary is semantic", () => {
    expect(classifyChange("下雨天留客，天留我不留。", "下雨天，留客天，留我不？留。")).toBe(
      "semantic",
    );
  });

  test("changing an emoji ZWJ sequence is semantic", () => {
    expect(classifyChange("工程师 👩‍💻", "工程师 👩💻")).toBe("semantic");
  });

  test("changing one character is semantic", () => {
    expect(classifyChange("雾散了。", "雨散了。")).toBe("semantic");
  });

  test("deleting a word is semantic even when punctuation also moves", () => {
    expect(classifyChange("他慢慢地走了,很久。", "他走了。")).toBe("semantic");
  });

  test("reordering two clauses is semantic though every character survives", () => {
    expect(classifyChange("他停笔,雾散了。", "雾散了,他停笔。")).toBe("semantic");
  });

  test("a digit change is semantic", () => {
    expect(classifyChange("第三章", "第四章")).toBe("semantic");
  });

  /* Latin letters carry meaning: 'bun' to 'Bun' is a correction, not a sweep. */
  test("a Latin case change is semantic, not cosmetic", () => {
    expect(classifyChange("用 bun 跑", "用 Bun 跑")).toBe("semantic");
  });

  test("adding a sentence is semantic", () => {
    expect(classifyChange("他走了。", "他走了。天亮了。")).toBe("semantic");
  });

  test("one semantic slice makes the whole proposal semantic", () => {
    const cls = classifyProposal([
      slice("s0", "same", "他说"),
      slice("s1", "del", ",好。"),
      slice("s2", "ins", "，妙。"),
    ]);

    expect(cls).toBe("semantic");
  });

  test("a proposal of pure punctuation sweeps is formatting", () => {
    const cls = classifyProposal([
      slice("s0", "del", "他说,好.她说,行."),
      slice("s1", "ins", "他说，好。她说，行。"),
    ]);

    expect(cls).toBe("formatting");
  });

  /**
   * Reordering is the case that breaks a classifier built on concatenation.
   * Every removed sentence is also an added sentence, so gluing the two sides
   * together produces two strings that differ only in the order of their
   * characters — and the skeleton test cannot see order across a join. The
   * proposal was then offered for bulk accept, which is the one outcome this
   * module exists to prevent: a meaning change riding through in one click.
   */
  test("swapping two sentences is semantic, not a formatting sweep", () => {
    const cls = classifyProposal([
      slice("s0", "del", "他走了。"),
      slice("s1", "del", "天亮了。"),
      slice("s2", "ins", "天亮了。"),
      slice("s3", "ins", "他走了。"),
    ]);

    expect(cls).toBe("semantic");
  });

  test("moving one sentence past an untouched one is semantic", () => {
    const cls = classifyProposal([
      slice("s0", "del", "第一句。"),
      slice("s1", "same", "中间的一句。"),
      slice("s2", "ins", "第一句。"),
    ]);

    expect(cls).toBe("semantic");
  });

  /**
   * The pairing must not become so strict that a genuine sweep across several
   * sentences stops qualifying — false negatives cost a keystroke, but enough
   * of them make the bulk path useless.
   */
  test("a punctuation sweep over many sentences is still formatting", () => {
    const cls = classifyProposal([
      slice("s0", "del", "他说,好."),
      slice("s1", "ins", "他说，好。"),
      slice("s2", "del", "她说,行."),
      slice("s3", "ins", "她说，行。"),
    ]);

    expect(cls).toBe("formatting");
  });
});
