/**
 * Plain-text documents: the grammar is picked by the document's format, the
 * whole document highlights with it, and pasted code loses not one character.
 *
 * `code-highlight.test.ts` proves the tokeniser works; this file proves the
 * format wiring reaches it — the same split as fence-highlight-wiring.test.ts.
 * The DOM here is a stub, not a browser.
 */

import { describe, expect, test } from "bun:test";
import { documentLanguage, isHighlightable, tokenizeCode } from "../src/code-highlight";
import type { DocumentFormat } from "../src/model";
import { splitPastedText } from "../src/virtual-manuscript-view";

/** Every format v0.2.4 edits natively, with its expected grammar. */
const FORMATS: readonly (readonly [DocumentFormat, string | null])[] = [
  ["markdown", null],
  ["latex", "latex"],
  ["typescript", "typescript"],
  ["rust", "rust"],
  ["python", "python"],
  ["go", "go"],
  ["lean", "lean"],
  ["css", "css"],
  ["html", "xml"],
  ["xml", "xml"],
  ["toml", "toml"],
  ["yaml", "yaml"],
];

describe("the grammar picked by the document format", () => {
  test("every format maps to its expected grammar", () => {
    for (const [format, language] of FORMATS) {
      expect(documentLanguage(format)).toBe(language);
    }
  });

  test("every picked grammar is embedded in this build", () => {
    // Nothing reaches the network for a grammar: a name that is not embedded
    // would degrade the whole document to uncoloured text.
    for (const [format, language] of FORMATS) {
      if (language === null) continue;
      expect(isHighlightable(language), `${format} -> ${language}`).toBe(true);
    }
  });

  test("markdown takes no whole-document grammar", () => {
    expect(documentLanguage("markdown")).toBeNull();
  });
});

describe("whole-document colouring", () => {
  const SAMPLES: readonly (readonly [DocumentFormat, string])[] = [
    ["rust", 'fn main() {\n    let 强调 = "**加粗**";\n}\n'],
    ["typescript", "const answer: number = 42;\nexport default answer;\n"],
    ["python", "def main():\n    return 42\n"],
    ["go", 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n'],
    ["lean", "theorem one_eq_one : 1 = 1 := rfl\n"],
    ["css", "body { margin: 0; }\n"],
    ["html", '<!DOCTYPE html>\n<html lang="zh"></html>\n'],
    ["xml", '<?xml version="1.0"?>\n<root/>\n'],
    ["toml", '[package]\nname = "refrain"\n'],
    ["yaml", "version: 2\nitems:\n  - one\n"],
    ["latex", "\\documentclass{article}\n\\begin{document}\n\\end{document}\n"],
  ];

  test("the author's bytes survive tokenising exactly, per format", async () => {
    for (const [format, sample] of SAMPLES) {
      const language = documentLanguage(format);
      expect(language, format).not.toBeNull();
      if (language === null) continue;
      const lines = await tokenizeCode(sample, language, "vitesse-light");
      expect(lines.length, format).toBeGreaterThan(0);
      const rebuilt = lines.map((line) => line.map((token) => token.text).join("")).join("\n");
      expect(rebuilt, format).toBe(sample);
    }
  });

  test("tokens carry colours from the theme", async () => {
    const lines = await tokenizeCode("fn main() {}", "rust", "vitesse-light");
    const keyword = (lines[0] ?? []).find((token) => token.text === "fn");
    expect(keyword?.color).not.toBe("");
  });
});

describe("pasted code loses nothing", () => {
  test("indentation and blank lines survive the split", () => {
    const pasted = "fn main() {\n    let x = 1;\n\n    let y = 2;\n}";
    expect(splitPastedText(pasted, "rust")).toEqual([
      "fn main() {",
      "    let x = 1;",
      "",
      "    let y = 2;",
      "}",
    ]);
  });

  test("a trailing carriage return is not line content", () => {
    expect(splitPastedText("one\r\ntwo\r\n", "rust")).toEqual(["one", "two", ""]);
  });

  test("markdown still splits on blank lines and trims", () => {
    const pasted = "  第一段。\n\n  第二段。\n";
    expect(splitPastedText(pasted, "markdown")).toEqual(["第一段。", "第二段。"]);
  });

  test("markdown structure punctuation stays literal text", () => {
    // What would be a fence, a heading and a table in Markdown is pasted as
    // ordinary lines in plain text.
    const pasted = "# not a heading\n```\n| a |\n|---|---|";
    expect(splitPastedText(pasted, "rust")).toEqual([
      "# not a heading",
      "```",
      "| a |",
      "|---|---|",
    ]);
  });
});
