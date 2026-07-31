#!/usr/bin/env bun
/**
 * Freezes the roundtrip corpora as bytes on disk.
 *
 * The v0.1.x corpora lived inside a TypeScript array, which made them readable
 * by exactly one runtime. INV-5 is now asserted from Rust and from TypeScript
 * against the same bytes, so the corpora become assets: one file per shape,
 * plus a manifest carrying each file's SHA-256.
 *
 * The output is not committed. This file is the authority; the .md files on disk are its
 * product, regenerated before every build and gate run. Rust reads
 * layouts.json at compile time via include_str!, so generation must happen
 * before cargo, not merely before the tests.
 *
 * A corpus that changes is a corpus that stopped being evidence about the
 * defect it was cut from — so the manifest digests are asserted every run, and
 * editing a string here without the digest moving is a gate failure.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Each entry is a shape that has damaged, or could damage, an author's file. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["ideographic-indent", "　　全角空格缩进的段落，中文写作常用。\n\n第二段也缩进。\n"],
  ["half-width-indent", "    four spaces open this line\n\nplain.\n"],
  ["consecutive-blank-lines", "一\n\n\n\n二\n\n\n三\n"],
  ["fence-holding-a-blank-line", "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后记\n"],
  ["tilde-fence", "~~~\n\n~~~\n\n之后。\n"],
  ["nested-fence-markers", "````md\n```ts\n\nconst a = 1;\n```\n````\n"],
  ["hard-line-break", "行尾双空格  \n接续行。\n\n第二段。\n"],
  ["crlf", "第一段。\r\n\r\n第二段。\r\n\r\n\r\n第三段。\r\n"],
  ["no-trailing-newline", "只有一段，末尾无换行"],
  ["byte-order-mark", "\uFEFF第一段。\n\n第二段。\n"],
  ["leading-blank-lines", "\n\n\n开头前有空行。\n"],
  ["trailing-blank-lines", "结尾后有空行。\n\n\n\n"],
  ["astral-characters", "𝄞 音乐符号，非 BMP。\n\n😀 表情符号。\n"],
  ["mixed-scripts", "漢字とかなの段落。\n\n　　全角インデント。\n\nLatin paragraph.\n"],
  ["blockquote-and-list", "> 引用。\n> 续行。\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n"],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n\n后文。\n"],
  ["tabs", "\t制表符开头。\n\n\t\t两个制表符。\n"],
  ["empty-file", ""],
  ["only-whitespace", "\n\n   \n\n"],
  [
    "everything-at-once",
    [
      "# 标题",
      "",
      "　　全角空格缩进的段落。",
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
    ].join("\n"),
  ],
];

const directory = "tests/corpora";
mkdirSync(directory, { recursive: true });

const manifest = CORPUS.map(([name, text]) => {
  const bytes = Buffer.from(text, "utf8");
  writeFileSync(join(directory, `${name}.md`), bytes);
  return {
    name,
    file: `${name}.md`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

writeFileSync(
  join(directory, "manifest.json"),
  `${JSON.stringify({ corpora: manifest }, null, 2)}\n`,
);

console.log(`froze ${manifest.length} corpora into ${directory}`);
