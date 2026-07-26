import type { ReviewSlice } from "./review.ts";

/**
 * Which changes may be accepted in bulk (SPEC 7.4).
 *
 * The author's rule: formatting may go through in one click, meaning must be
 * read one at a time. That only holds if "formatting" is decidable rather than
 * guessed — a bulk accept that quietly swallows a word change would destroy
 * the trust the whole review model rests on.
 *
 * So the test is deliberately narrow and runs on the text itself: strip the
 * characters this classifier is allowed to touch, and if both sides are then
 * identical, nothing but those characters changed. Anything else — a word, a
 * character, a number, a reordering — falls to `semantic` and must be read.
 * False negatives cost the author a keystroke; false positives cost them a
 * sentence they never agreed to.
 */

export type ChangeClass = "formatting" | "semantic";

/**
 * Characters a formatting-only change may add or remove.
 *
 * ASCII and full-width punctuation are both here because converting , to ，is
 * exactly the kind of sweep this exists for. CJK ideographs, kana, hangul,
 * letters and digits are absent by design: those carry meaning.
 */
const COSMETIC =
  /[\s\u3000\u200b\ufeff,.;:!?'"()[\]{}\-–—…、。，；：！？「」『』（）《》〈〉·・]/gu;

const PUNCTUATION = /[,.;:!?'"()[\]{}\-–—…、。，；：！？「」『』（）《》〈〉·・]/u;
const punctuationClass = (character: string): string => {
  if (",，、".includes(character)) return "comma";
  if (".。".includes(character)) return "stop";
  if (";；".includes(character)) return "semicolon";
  if (":：".includes(character)) return "colon";
  if ("!！".includes(character)) return "exclamation";
  if ("?？".includes(character)) return "question";
  if ('"“”「」'.includes(character)) return "double-quote";
  if ("'‘’『』".includes(character)) return "single-quote";
  if ("(（[【{《〈".includes(character)) return "open";
  if (")）]】}》〉".includes(character)) return "close";
  if ("-–—".includes(character)) return "dash";
  if ("·・".includes(character)) return "middle-dot";
  return "ellipsis";
};

const punctuationShape = (text: string): string => {
  const shape: string[] = [];
  let semanticPosition = 0;
  for (const character of text.replace(/\.{2,}|…+/gu, "…")) {
    if (/[\s\u3000\u200b\ufeff]/u.test(character)) continue;
    if (PUNCTUATION.test(character)) {
      shape.push(`${semanticPosition}:${punctuationClass(character)}`);
      continue;
    }
    semanticPosition += 1;
  }
  return shape.join("|");
};

const skeleton = (text: string): string => text.replace(COSMETIC, "");

/**
 * A slice pair reduced to its meaning-bearing characters. Identical skeletons
 * mean only cosmetic characters moved.
 */
export const classifyChange = (before: string, after: string): ChangeClass =>
  skeleton(before) === skeleton(after) && punctuationShape(before) === punctuationShape(after)
    ? "formatting"
    : "semantic";

/**
 * Classify a whole Proposal from its slices. One semantic slice makes the
 * whole proposal semantic: bulk-accepting a proposal must never let a meaning
 * change ride along with the punctuation fixes around it.
 */
export const classifyProposal = (slices: readonly ReviewSlice[]): ChangeClass => {
  const removed = slices
    .filter((s) => s.kind === "del")
    .map((s) => s.text)
    .join("");
  const added = slices
    .filter((s) => s.kind === "ins")
    .map((s) => s.text)
    .join("");

  return classifyChange(removed, added);
};
