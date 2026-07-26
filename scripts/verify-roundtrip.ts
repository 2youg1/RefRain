/**
 * INV-5: the bytes an author did not edit come back unchanged.
 *
 * This runs the real save path — `loadWorkspace` then `writeChapter`, which is
 * what Ctrl+S reaches — over a corpus of everything known to have been damaged,
 * and compares SHA-256 before and after. A unit test of the parser cannot catch
 * this: the loss happened between the parser and the disk, in a serialiser that
 * rebuilt the file from block text alone and had no way to know what had stood
 * between the blocks.
 *
 * The measurement that opened this release: 186 bytes in, 174 out, nobody
 * having typed anything. An ideographic indent — how a Chinese paragraph opens
 * — deleted on load, a fenced code block cut in two by the blank line inside
 * it, three blank lines flattened to one.
 *
 * Injection proof that this gate bites (SPEC 4.4): restore `.map((t) =>
 * t.trim())` in `parseChapter`, or make `writeChapter` call `serializeChapter`
 * instead of `chapterBytes`, and this exits 1 naming the corpus that broke.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace, writeChapter } from "../packages/core/src/index.ts";

const digest = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** Each entry is a shape that has damaged, or could damage, an author's file. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["ideographic indent", "　　全角空格缩进的段落，中文写作常用。\n\n第二段也缩进。\n"],
  ["half-width indent", "    four spaces open this line\n\nplain.\n"],
  ["consecutive blank lines", "一\n\n\n\n二\n\n\n三\n"],
  ["fence holding a blank line", "前言\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n后记\n"],
  ["tilde fence", "~~~\n\n~~~\n\n之后。\n"],
  ["nested fence markers", "````md\n```ts\n\nconst a = 1;\n```\n````\n"],
  ["hard line break", "行尾双空格  \n接续行。\n\n第二段。\n"],
  ["CRLF", "第一段。\r\n\r\n第二段。\r\n\r\n\r\n第三段。\r\n"],
  ["no trailing newline", "只有一段，末尾无换行"],
  ["byte-order mark", "\uFEFF第一段。\n\n第二段。\n"],
  ["leading blank lines", "\n\n\n开头前有空行。\n"],
  ["trailing blank lines", "结尾后有空行。\n\n\n\n"],
  ["astral characters", "𝄞 音乐符号，非 BMP。\n\n😀 表情符号。\n"],
  ["mixed scripts", "漢字とかなの段落。\n\n　　全角インデント。\n\nLatin paragraph.\n"],
  ["blockquote and list", "> 引用。\n> 续行。\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n"],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |\n\n后文。\n"],
  ["tabs", "\t制表符开头。\n\n\t\t两个制表符。\n"],
  ["empty file", ""],
  ["only whitespace", "\n\n   \n\n"],
  [
    "everything at once",
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

const dir = mkdtempSync(join(tmpdir(), "refrain-verify-roundtrip-"));
const broken: string[] = [];

/**
 * How many blocks each corpus must produce.
 *
 * Only the corpora where a wrong split is invisible in the bytes: a fence
 * holding a blank line is one block, not two, and nothing about the file's
 * bytes would reveal the difference.
 */
const blocks: Readonly<Record<string, number>> = {
  "fence holding a blank line": 3,
  "tilde fence": 2,
  "nested fence markers": 1,
  "consecutive blank lines": 3,
  "everything at once": 6,
  "ideographic indent": 2,
};

try {
  for (const [name, source] of CORPUS) {
    const path = join(dir, `${name.replace(/[^a-z]+/gi, "-")}.md`);
    writeFileSync(path, source, "utf8");
    const before = digest(source);

    const chapter = loadWorkspace([path]).chapters[0];
    if (chapter === undefined) {
      broken.push(`${name}: the workspace did not load the file at all`);
      continue;
    }

    const outcome = writeChapter(path, chapter.head, chapter.stamp);
    if (!outcome.ok) {
      broken.push(`${name}: the save refused with ${outcome.reason}`);
      continue;
    }

    const after = readFileSync(path, "utf8");
    if (digest(after) !== before)
      broken.push(
        `${name}: ${Buffer.byteLength(source)} bytes in, ${Buffer.byteLength(after)} out\n` +
          `      in  ${JSON.stringify(source)}\n` +
          `      out ${JSON.stringify(after)}`,
      );

    // Byte equality alone is too weak a check. A fence split into two blocks
    // still reassembles to the same bytes, so this passed while block identity
    // was wrong — and identity is what a queued proposal is addressed to.
    // Miscounting blocks renumbers every one after the split and detaches the
    // proposals silently, which the author would discover only on merge.
    const expected = blocks[name];
    if (expected !== undefined && chapter.head.blocks.length !== expected)
      broken.push(
        `${name}: split into ${chapter.head.blocks.length} blocks, expected ${expected}\n` +
          `      ${JSON.stringify(chapter.head.blocks.map((b) => b.text))}`,
      );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (broken.length > 0) {
  console.error(`INV-5 violated: ${broken.length} of ${CORPUS.length} corpora changed on save\n`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`PASS  ${CORPUS.length} corpora survive a load and a save byte for byte`);
