import { describe, expect, test } from "bun:test";
import { applyBlocks, parseSource, serializeSource, sourceBlocks } from "../src/roundtrip.ts";

/**
 * INV-5: bytes the author did not edit come back unchanged.
 *
 * The lower bound this release commits to. Not arbitrary Markdown fidelity —
 * a paragraph the author rewrote is replaced, and every byte around it is
 * sliced out of the original and put back exactly as it was read.
 *
 * Everything here failed before `roundtrip.ts` existed: `trim()` on load ate
 * the ideographic indent Chinese prose is written with, a blank line inside a
 * fence split one code block into two, and consecutive blank lines collapsed
 * to one. Twelve bytes vanished from a 186-byte manuscript that nobody had
 * touched.
 */

const roundTrips = (source: string): boolean =>
  serializeSource(parseSource(source), new Map()) === source;

describe("source fidelity", () => {
  test("an ideographic indent survives a load and a save", () => {
    const source = "　　全角空格缩进的段落，中文写作常用。\n\n第二段。\n";
    expect(roundTrips(source)).toBe(true);
    expect(sourceBlocks(parseSource(source))[0]?.text).toBe(
      "　　全角空格缩进的段落，中文写作常用。",
    );
  });

  test("a blank line inside a fence does not split the code block", () => {
    const source = "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后记\n";
    const doc = parseSource(source);
    expect(sourceBlocks(doc)).toHaveLength(3);
    expect(sourceBlocks(doc)[1]?.text).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(roundTrips(source)).toBe(true);
  });

  test("a tilde fence is a fence too", () => {
    const source = "~~~\n\n~~~\n";
    expect(sourceBlocks(parseSource(source))).toHaveLength(1);
    expect(roundTrips(source)).toBe(true);
  });

  test("consecutive blank lines are not collapsed", () => {
    const source = "一\n\n\n\n二\n";
    expect(roundTrips(source)).toBe(true);
  });

  test("trailing double spaces — a hard line break — survive", () => {
    const source = "行尾两个空格  \n下一行。\n\n第二段。\n";
    expect(roundTrips(source)).toBe(true);
  });

  test("a four-space indented code block is not stripped", () => {
    const source = "段落。\n\n    indented code\n    second line\n\n结尾。\n";
    expect(roundTrips(source)).toBe(true);
  });

  test("CRLF survives, because Windows is the first platform this ships to", () => {
    const source = "第一段。\r\n\r\n第二段。\r\n";
    expect(roundTrips(source)).toBe(true);
  });

  test("a file with no trailing newline does not grow one", () => {
    expect(roundTrips("只有一段，末尾无换行")).toBe(true);
  });

  test("a byte-order mark stays at the front", () => {
    expect(roundTrips("\uFEFF第一段。\n\n第二段。\n")).toBe(true);
  });

  test("leading and trailing blank lines are kept", () => {
    expect(roundTrips("\n\n中间。\n\n\n")).toBe(true);
  });

  test("astral characters survive, counted as the runtime counts them", () => {
    expect(roundTrips("𝄞 音乐符号，非 BMP。\n\n😀 表情。\n")).toBe(true);
  });

  test("an empty file stays empty", () => {
    expect(roundTrips("")).toBe(true);
  });

  test("the whole corpus of known damage round-trips at once", () => {
    const source = [
      "# 标题",
      "",
      "　　全角空格缩进的段落，中文写作常用。",
      "",
      "",
      "",
      "行尾双空格  ",
      "接续行。",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "    四空格缩进的码块",
      "",
      "> 引用。",
      "",
    ].join("\n");
    expect(roundTrips(source)).toBe(true);
  });
});

describe("editing one block leaves the rest byte-identical", () => {
  const source =
    "　　第一段，有缩进。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n　　第三段。\n";

  test("a replaced block keeps its own surrounding whitespace", () => {
    const doc = parseSource(source);
    const first = sourceBlocks(doc)[0];
    expect(first).toBeDefined();
    const out = serializeSource(doc, new Map([[first?.id ?? "", "　　第一段，改过了。"]]));
    expect(out).toBe(
      "　　第一段，改过了。\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n　　第三段。\n",
    );
  });

  test("an edit to the last block does not disturb the first", () => {
    const doc = parseSource(source);
    const last = sourceBlocks(doc)[2];
    const out = serializeSource(doc, new Map([[last?.id ?? "", "改写。"]]));
    expect(out.startsWith("　　第一段，有缩进。\n\n```ts")).toBe(true);
    expect(out.endsWith("改写。\n")).toBe(true);
  });

  test("emptying a block removes its text and not its neighbours", () => {
    const doc = parseSource("一\n\n二\n\n三\n");
    const second = sourceBlocks(doc)[1];
    const out = serializeSource(doc, new Map([[second?.id ?? "", ""]]));
    expect(out).toBe("一\n\n\n\n三\n");
  });

  test("an unknown block id changes nothing", () => {
    const doc = parseSource(source);
    expect(serializeSource(doc, new Map([["nope", "x"]]))).toBe(source);
  });
});

describe("block identity is stable across a reload", () => {
  test("the same bytes yield the same identifiers", () => {
    const source = "一\n\n二\n\n三\n";
    const first = sourceBlocks(parseSource(source, "ch1")).map((b) => b.id);
    const second = sourceBlocks(parseSource(source, "ch1")).map((b) => b.id);
    expect(first).toEqual(second);
    expect(first).toEqual(["ch1:b0", "ch1:b1", "ch1:b2"]);
  });
});

describe("reordering keeps whitespace at its document position", () => {
  test("moving the second block first neither injects its old gap nor joins the old first block", () => {
    const doc = parseSource("A\n\n\nB\n\nC\n", "chapter");
    const [first, second, third] = sourceBlocks(doc);
    if (!first || !second || !third) throw new Error("fixture did not parse into three blocks");

    expect(applyBlocks(doc, [second, first, third])).toBe("B\n\n\nA\n\nC\n");
  });

  test("the document prefix and both interior gaps survive a complete reversal", () => {
    const doc = parseSource("\nA\n\n\nB\n\nC\n", "chapter");
    const [first, second, third] = sourceBlocks(doc);
    if (!first || !second || !third) throw new Error("fixture did not parse into three blocks");

    expect(applyBlocks(doc, [third, second, first])).toBe("\nC\n\n\nB\n\nA\n");
  });

  test("inserting before the old first block keeps the prefix and a default separator", () => {
    const doc = parseSource("\nA\n\n\nB\n", "chapter");
    const [first, second] = sourceBlocks(doc);
    if (!first || !second) throw new Error("fixture did not parse into two blocks");

    expect(applyBlocks(doc, [{ id: "new", text: "N" }, first, second])).toBe("\nN\n\nA\n\n\nB\n");
  });
});
