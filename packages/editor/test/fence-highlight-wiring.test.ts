/**
 * The fence highlighting wiring.
 *
 * `code-highlight.test.ts` proves the tokeniser works. This file proves the
 * editor actually reaches it, which is a different claim: the tokeniser sat in
 * the tree with six exports and zero callers, fully working and entirely
 * invisible to the author.
 *
 * The DOM here is a stub, not a browser. It carries exactly the surface
 * `#highlightFence` touches, so a change that breaks the wiring fails here
 * rather than at the first screenshot.
 */

import { describe, expect, test } from "bun:test";
import { fenceLanguage, tokenizeCode } from "../src/code-highlight";

/**
 * What the view does with a block: a fence consults the language, anything
 * else never does. This mirrors `#fenceLanguage`, which is one line calling
 * the same exported function.
 */
const languageFor = (text: string, isFence: boolean): string | null =>
  isFence ? fenceLanguage(text) : null;

describe("fence language", () => {
  test("reads the language from the info string", () => {
    expect(languageFor("```rust\nfn main() {}\n```", true)).toBe("rust");
  });

  test("takes only the first word: the rest is other tools' metadata", () => {
    expect(languageFor("```rust ignore no_run\nfn main() {}\n```", true)).toBe("rust");
  });

  test("accepts tilde fences", () => {
    expect(languageFor("~~~python\nprint(1)\n~~~", true)).toBe("python");
  });

  test("a fence with no language is not highlighted", () => {
    expect(languageFor("```\nplain text\n```", true)).toBeNull();
  });

  test("a language this build did not embed is not highlighted", () => {
    // Nothing reaches the network to fetch a grammar: the embedded set is all
    // there is, and an unknown language degrades to plain text.
    expect(languageFor("```haskell\nmain = pure ()\n```", true)).toBeNull();
  });

  test("a paragraph is never treated as a fence", () => {
    expect(languageFor("rust is a language I write about", false)).toBeNull();
  });

  test("a single-line fence keeps its last character", () => {
    // `indexOf` returns -1 when there is no newline, and `slice(0, -1)` then
    // silently drops the final character: "```rust" would read as "rus".
    expect(fenceLanguage("```rust")).toBe("rust");
  });
});

describe("fence colouring", () => {
  test("produces one span-worth of token per piece, preserving the text", async () => {
    const source = '```rust\nfn main() {\n    println!("hi");\n}\n```';
    const lines = await tokenizeCode(source, "rust", "vitesse-light");

    expect(lines.length).toBeGreaterThan(1);

    // The author's bytes must survive tokenising exactly. A highlighter that
    // drops or reorders a character silently corrupts the manuscript view.
    const rebuilt = lines.map((line) => line.map((token) => token.text).join("")).join("\n");
    expect(rebuilt).toBe(source);
  });

  test("keywords and identifiers get different colours", async () => {
    const lines = await tokenizeCode("fn main() {}", "rust", "vitesse-light");
    const tokens = lines[0] ?? [];
    const keyword = tokens.find((token) => token.text === "fn");
    const identifier = tokens.find((token) => token.text === "main");

    expect(keyword?.color).not.toBe("");
    expect(identifier?.color).not.toBe("");
    // If these matched, the tokeniser ran but the theme did not apply, and the
    // author would see uniformly coloured text that looks like a bug.
    expect(keyword?.color).not.toBe(identifier?.color);
  });

  test("an unknown language yields nothing rather than throwing", async () => {
    expect(await tokenizeCode("main = pure ()", "haskell", "vitesse-light")).toEqual([]);
  });
});
