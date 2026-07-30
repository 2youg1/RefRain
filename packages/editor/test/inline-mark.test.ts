import { describe, expect, test } from "bun:test";
import { applyInlineMark, inlineMarkState } from "../src/inline-mark";

// The defect this file exists to prevent: formatting used to wrap
// unconditionally, so a second bold produced `****text****`. State is read from
// the block's own Markdown source, which is the only text authority.

describe("inlineMarkState", () => {
  test("plain text is off", () => {
    expect(inlineMarkState("Alpha beta", 0, 5, "strong")).toBe("off");
  });

  test("markers immediately outside the selection are on", () => {
    expect(inlineMarkState("**Alpha** beta", 2, 7, "strong")).toBe("on");
  });

  test("markers inside the selection are mixed", () => {
    expect(inlineMarkState("**Alpha** beta", 0, 14, "strong")).toBe("mixed");
  });

  test("strong and emphasis are independent", () => {
    expect(inlineMarkState("**Alpha**", 2, 7, "emphasis")).toBe("off");
    expect(inlineMarkState("*Alpha*", 1, 6, "emphasis")).toBe("on");
  });

  test("a double marker does not read as emphasis on", () => {
    // `**Alpha**` sliced at the emphasis boundary must not claim emphasis is on:
    // the character outside is another `*`, so the delimiters are a strong pair.
    expect(inlineMarkState("**Alpha**", 1, 8, "emphasis")).toBe("off");
  });
});

describe("applyInlineMark", () => {
  test("off adds the marker", () => {
    expect(applyInlineMark("Alpha beta", 0, 5, "strong")).toEqual({
      text: "**Alpha** beta",
      start: 2,
      end: 7,
    });
  });

  test("on removes the marker instead of nesting", () => {
    expect(applyInlineMark("**Alpha** beta", 2, 7, "strong")).toEqual({
      text: "Alpha beta",
      start: 0,
      end: 5,
    });
  });

  test("bold twice returns the original text", () => {
    const once = applyInlineMark("Alpha beta", 0, 5, "strong");
    const twice = applyInlineMark(once.text, once.start, once.end, "strong");
    expect(twice.text).toBe("Alpha beta");
    expect(twice.text).not.toContain("****");
  });

  test("mixed normalizes inner markers before wrapping once", () => {
    expect(applyInlineMark("**Alpha** beta", 0, 14, "strong")).toEqual({
      text: "**Alpha beta**",
      start: 2,
      end: 12,
    });
  });

  test("emphasis nests inside strong rather than colliding", () => {
    expect(applyInlineMark("**Alpha**", 2, 7, "emphasis")).toEqual({
      text: "***Alpha***",
      start: 3,
      end: 8,
    });
  });

  test("leading and trailing whitespace shrinks inward", () => {
    // CommonMark: `** text **` is not emphasis, so the marker must land on
    // non-whitespace characters or the author gets literal asterisks.
    expect(applyInlineMark("say  text  here", 3, 11, "strong")).toEqual({
      text: "say  **text**  here",
      start: 7,
      end: 11,
    });
  });

  test("a selection of only whitespace is refused", () => {
    expect(applyInlineMark("say   here", 3, 6, "strong")).toBeNull();
  });

  test("an empty selection is refused", () => {
    expect(applyInlineMark("Alpha", 2, 2, "strong")).toBeNull();
  });

  test("an unpaired marker inside the selection is left alone", () => {
    // The author typed a lone `*`. Stripping it would edit text they did not
    // select for removal; only paired markers are normalized.
    expect(applyInlineMark("a * b", 0, 5, "strong")).toEqual({
      text: "**a * b**",
      start: 2,
      end: 7,
    });
  });
});
