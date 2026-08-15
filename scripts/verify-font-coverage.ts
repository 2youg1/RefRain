#!/usr/bin/env bun
/**
 * The embedded face must draw every character the interface can show.
 *
 * The interface uses one face for all of its text (`app_main.zig` sets
 * `typography.font_id` and `mono_font_id` to the manuscript face). The SDK does
 * not change the face for one codepoint: an uncovered codepoint gets the
 * `.notdef` advance in the layout and a block in the paint. Thus a label with
 * one uncovered character shows a block on the screen, and all tests stay green.
 *
 * This occurred: the binary contained an 8,127-codepoint subset, and three
 * controls on the settings screen showed blocks. One of them was the name of the
 * default theme.
 *
 * This gate reads the codepoints from the label tables, and the face from
 * `build.zig`. It does not have a second list of characters.
 *
 * Injection proof: change `manuscript_font` in `build.zig` to the subset face,
 * or add a label with an uncovered character. This gate then exits 1 and gives
 * the codepoint, the label, and the file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const nativeDir = join(root, "apps/native");

/**
 * The files that hold interface text. Each is the single authority for its own
 * words: the command labels, the destination labels, the theme names, and the
 * screens.
 */
const labelSources: readonly string[] = [
  "src/commands.zig",
  "src/workbench_view.zig",
  "src/app_main.zig",
  "src/rail.zig",
  "src/veil.zig",
  "src/document_language.zig",
  "src/generated/themes.zig",
];

/** The face that `build.zig` embeds as the interface font. */
function embeddedFacePath(): string {
  const build = readFileSync(join(nativeDir, "build.zig"), "utf8");
  const match = build.match(/const manuscript_font = b\.path\("([^"]+)"\);/);
  if (match?.[1] === undefined) {
    throw new Error(
      "build.zig no longer names the manuscript font; this gate cannot find the face",
    );
  }
  return join(nativeDir, match[1]);
}

/** The codepoints of a TrueType face, from the format 4 unicode cmap. */
function faceCoverage(path: string): Set<number> {
  const font = readFileSync(path);
  const tableCount = font.readUInt16BE(4);
  let cmapOffset = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + 16 * index;
    if (font.toString("ascii", record, record + 4) === "cmap") {
      cmapOffset = font.readUInt32BE(record + 8);
    }
  }
  if (cmapOffset === 0) throw new Error(`${path} has no cmap table`);
  const subtableCount = font.readUInt16BE(cmapOffset + 2);
  let format4 = 0;
  for (let index = 0; index < subtableCount; index += 1) {
    const record = cmapOffset + 4 + 8 * index;
    const offset = cmapOffset + font.readUInt32BE(record + 4);
    if (font.readUInt16BE(offset) === 4) format4 = offset;
  }
  if (format4 === 0) throw new Error(`${path} has no format 4 unicode cmap`);
  const segmentBytes = font.readUInt16BE(format4 + 6);
  const segments = segmentBytes / 2;
  const covered = new Set<number>();
  for (let index = 0; index < segments; index += 1) {
    const end = font.readUInt16BE(format4 + 14 + 2 * index);
    const start = font.readUInt16BE(format4 + 16 + segmentBytes + 2 * index);
    if (end === 0xffff) continue;
    for (let codepoint = start; codepoint <= end; codepoint += 1) covered.add(codepoint);
  }
  return covered;
}

/** One string in the source, with the position that a reader can go to. */
interface Label {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * The double-quoted strings of a Zig file, without the comments.
 *
 * A comment can hold any character, and a comment is not on the screen. A
 * string is. Escape sequences stay as they are: `\n` and `\"` are ASCII, and
 * ASCII is in every face.
 */
function labelsOf(file: string): Label[] {
  const text = readFileSync(join(nativeDir, file), "utf8");
  const labels: Label[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const code = line.replace(/\/\/.*$/, "");
    for (const match of code.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const value = match[1];
      if (value !== undefined && value.length > 0) {
        labels.push({ file, line: index + 1, text: value });
      }
    }
  }
  return labels;
}

const facePath = embeddedFacePath();
const covered = faceCoverage(facePath);
const failures: string[] = [];
let checked = 0;
let characters = 0;

for (const file of labelSources) {
  for (const label of labelsOf(file)) {
    checked += 1;
    for (const character of label.text) {
      const codepoint = character.codePointAt(0);
      if (codepoint === undefined) continue;
      // Control characters are layout, not glyphs.
      if (codepoint < 0x20) continue;
      characters += 1;
      if (covered.has(codepoint)) continue;
      const hex = codepoint.toString(16).toUpperCase().padStart(4, "0");
      failures.push(`${file}:${label.line}: U+${hex} ${character} in "${label.text}"`);
    }
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:font-coverage: the embedded face cannot draw these characters");
  for (const failure of failures.slice(0, 40)) console.error(`      ${failure}`);
  if (failures.length > 40) console.error(`      ... and ${failures.length - 40} more`);
  console.error(`      face: ${facePath} (${covered.size} codepoints)`);
  process.exit(1);
}

console.log(
  `PASS  verify:font-coverage  (${characters} characters in ${checked} labels, ` +
    `all in a face of ${covered.size} codepoints)`,
);
