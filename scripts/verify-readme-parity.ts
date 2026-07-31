#!/usr/bin/env bun
/**
 * The two READMEs describe the same product.
 *
 * A translated document drifts in one direction almost every time: someone adds
 * a section to the English README, ships it, and the Chinese one silently
 * describes a smaller product. Nobody notices, because each file reads fine on
 * its own — the defect only exists in the relationship between them.
 *
 * So the gate asserts the relationship, not the prose. Section count and order
 * must match. It deliberately says nothing about wording: these are two
 * documents written for two sets of readers, not one document and its
 * transcript, and demanding sentence-level parity would make the Chinese read
 * like a translation.
 *
 * Injection proof that this gate bites: add a `## ` heading to either file and
 * this exits 1, naming the position and both headings.
 */

import { readFileSync } from "node:fs";

const ENGLISH = "README.md";
const CHINESE = "README.zh-CN.md";

const sections = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());

const english = sections(ENGLISH);
const chinese = sections(CHINESE);

const failures: string[] = [];

// A scan finding nothing is a broken scan: both files have sections today, and
// a rename that empties this list must fail rather than pass silently.
if (english.length === 0)
  failures.push(`${ENGLISH}: found no \`## \` sections — is the path right?`);
if (chinese.length === 0)
  failures.push(`${CHINESE}: found no \`## \` sections — is the path right?`);

if (failures.length === 0 && english.length !== chinese.length) {
  failures.push(
    `section counts differ: ${ENGLISH} has ${english.length}, ${CHINESE} has ${chinese.length}`,
  );
  const longer = Math.max(english.length, chinese.length);
  for (let index = 0; index < longer; index += 1) {
    const left = english[index];
    const right = chinese[index];
    if (left === undefined) failures.push(`  ${index + 1}. (missing in ${ENGLISH}) / ${right}`);
    else if (right === undefined)
      failures.push(`  ${index + 1}. ${left} / (missing in ${CHINESE})`);
  }
}

// Both language links must appear in both files, or a reader lands in the wrong
// language with no way back.
for (const [path, text] of [
  [ENGLISH, readFileSync(ENGLISH, "utf8")],
  [CHINESE, readFileSync(CHINESE, "utf8")],
] as const) {
  if (!text.includes(`(${ENGLISH})`) || !text.includes(`(${CHINESE})`)) {
    failures.push(`${path}: the language switcher must link both READMEs`);
  }
}

if (failures.length > 0) {
  console.error("FAIL  verify:readme-parity: the two READMEs describe different products");
  for (const failure of failures) console.error(`      ${failure}`);
  console.error("      Add the missing section, or remove the extra one.");
  process.exit(1);
}

console.log(`PASS  verify:readme-parity  (${english.length} sections in both READMEs)`);
