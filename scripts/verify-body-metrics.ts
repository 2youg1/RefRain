#!/usr/bin/env bun
/**
 * Plan v0.2.3 §3.0-1: the manuscript body must not carry font-level
 * punctuation compression.
 *
 * ## What was there and why it had to go
 *
 * The body used to set `font-feature-settings: "halt" 1, "vhal" 1` together
 * with `font-variant-east-asian: proportional-width`. Measured here in
 * Chromium, after `document.fonts.load()`, with `「你好」，世界。！？` at 100px:
 *
 * | font | features on | features off |
 * |---|---:|---:|
 * | Noto Sans SC | 678px | 950px |
 * | Zen Kaku Gothic New | 1000px | 1000px |
 *
 * The Chinese face loses 272px; the Japanese face does not move at all,
 * because Zen Kaku ships none of those OpenType features. So one manuscript's
 * Chinese and Japanese paragraphs were being set to two different metrics, and
 * the author never asked for either. The rule was living inside a font file:
 * swap the font and the page changes, with nothing in the repository recording
 * that a decision was made.
 *
 * Punctuation compression belongs to `@refrain/typeset`'s language presets,
 * where GB/T 15834 §5.1.10 (half-width at line end) and JLREQ §3.1.9 (the
 * space after a full stop is kept) can disagree — as they do — instead of one
 * font's opinion silently applying to both.
 *
 * ## Why a gate rather than a comment
 *
 * "Make CJK punctuation tighter" is a reasonable-sounding change that anyone
 * might make, and the CSS property is the obvious place to make it. The
 * comment in surfaces.css explains the reasoning; this makes the reasoning
 * enforceable.
 *
 * Injection proof: put `"halt" 1` back into the manuscript rule and this
 * exits 1 naming the file and line.
 */

import { readFileSync } from "node:fs";

const FILE = "apps/desktop/src/styles/surfaces.css";
const source = readFileSync(FILE, "utf8");
const lines = source.split("\n");

/**
 * The OpenType features that compress CJK punctuation, and the
 * `font-variant-east-asian` values that do the same through a different
 * property. Both spellings reach the same glyphs, so both are checked.
 */
const COMPRESSION_FEATURES = ["halt", "vhal", "palt", "vpal", "pwid", "twid", "qwid"] as const;
const COMPRESSION_VARIANTS = ["proportional-width", "full-width"] as const;

interface Finding {
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

const findings: Finding[] = [];

// Only the manuscript body is governed. Interface chrome may set whatever it
// likes — a toolbar is not a page of prose, and forbidding these properties
// everywhere would be a rule nobody could follow.
//
// The region runs from the `.editor-host` block's opening brace to its closing
// one. Scanning the whole file instead would report the navigation rail's
// legitimate settings as violations, and a gate whose failures are mostly
// false is a gate people learn to skip.
const start = lines.findIndex((line) => /^\.editor-host\s*\{/.test(line));
if (start === -1) {
  console.error(`FAIL  verify:body-metrics: cannot find the .editor-host rule in ${FILE}`);
  process.exit(1);
}
let depth = 0;
let end = start;
for (let index = start; index < lines.length; index += 1) {
  const line = lines[index] ?? "";
  depth += (line.match(/\{/g) ?? []).length;
  depth -= (line.match(/\}/g) ?? []).length;
  if (depth === 0 && index > start) {
    end = index;
    break;
  }
}

// A region of zero or one line means the brace matching failed, and every
// assertion below would then pass by scanning nothing.
if (end - start < 3) {
  console.error(
    `FAIL  verify:body-metrics: the .editor-host rule spans ${end - start} lines, which cannot be right`,
  );
  process.exit(1);
}

for (let index = start; index <= end; index += 1) {
  const raw = lines[index] ?? "";
  // Comments explain why these features are absent and must not be read as
  // their presence. Without this the file's own explanation fails the gate.
  const line = raw.replace(/\/\*.*?\*\//g, "").replace(/^\s*\*.*/, "");
  if (line.trim() === "") continue;

  for (const feature of COMPRESSION_FEATURES) {
    if (new RegExp(`["']${feature}["']`).test(line)) {
      findings.push({
        line: index + 1,
        text: raw.trim(),
        why: `"${feature}" compresses CJK punctuation in the font, so the rule depends on which font is loaded`,
      });
    }
  }
  for (const variant of COMPRESSION_VARIANTS) {
    if (/font-variant-east-asian/.test(line) && new RegExp(`\\b${variant}\\b`).test(line)) {
      findings.push({
        line: index + 1,
        text: raw.trim(),
        why: `font-variant-east-asian: ${variant} reaches the same glyphs as the feature above`,
      });
    }
  }
}

if (findings.length > 0) {
  console.error(
    "FAIL  verify:body-metrics: the manuscript body carries font-level punctuation compression",
  );
  for (const finding of findings) {
    console.error(`      ${FILE}:${finding.line}  ${finding.text}`);
    console.error(`        ${finding.why}`);
  }
  console.error("      Punctuation metrics belong to @refrain/typeset's language presets,");
  console.error("      where Chinese and Japanese can differ. Measured cost of leaving this");
  console.error("      in: Noto Sans SC 678px vs 950px, Zen Kaku Gothic New unchanged.");
  process.exit(1);
}

// The properties must be present and neutral, not merely absent. Absent means
// "whatever the font decides", which is the same failure with no line to point
// at — and a gate that passes on an empty rule measures nothing.
const region = lines.slice(start, end + 1).join("\n");
const neutral = [/font-feature-settings:\s*normal/, /font-variant-east-asian:\s*normal/];
const unset = neutral.filter((pattern) => !pattern.test(region));
if (unset.length > 0) {
  console.error("FAIL  verify:body-metrics: the manuscript body does not state neutral metrics");
  console.error("      Expected both `font-feature-settings: normal` and");
  console.error("      `font-variant-east-asian: normal` inside .editor-host, so that the");
  console.error("      absence of compression is a decision on the page rather than an");
  console.error("      accident of which font happens to be loaded.");
  process.exit(1);
}

console.log(
  `PASS  verify:body-metrics  (.editor-host, lines ${start + 1}–${end + 1}, ${COMPRESSION_FEATURES.length} features checked)`,
);
