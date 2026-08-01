import type { PunctuationFinding } from "./model";

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_OR_DIGIT = /[\p{Script=Latin}\d]/u;
const ASCII_TO_CJK: Readonly<Record<string, string>> = {
  ",": "，",
  ".": "。",
  ":": "：",
  ";": "；",
  "?": "？",
  "!": "！",
  "(": "（",
  ")": "）",
};
const CJK_TO_ASCII: Readonly<Record<string, string>> = {
  "，": ",",
  "。": ".",
  "：": ":",
  "；": ";",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
};

const isCjk = (character: string | undefined): boolean =>
  character !== undefined && CJK.test(character);
const isLatinOrDigit = (character: string | undefined): boolean =>
  character !== undefined && LATIN_OR_DIGIT.test(character);

const inlineCodeRanges = (
  text: string,
): readonly { readonly start: number; readonly end: number }[] => {
  const ranges: { start: number; end: number }[] = [];
  let opening = -1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "`") continue;
    if (opening < 0) opening = index;
    else {
      ranges.push({ start: opening, end: index + 1 });
      opening = -1;
    }
  }
  if (opening >= 0) ranges.push({ start: opening, end: text.length });
  return ranges;
};

const isProtected = (
  index: number,
  ranges: readonly { readonly start: number; readonly end: number }[],
): boolean => ranges.some((range) => index >= range.start && index < range.end);

const isDecimal = (text: string, index: number): boolean =>
  text[index] === "." && /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "");

const isAbbreviationPeriod = (text: string, index: number): boolean => {
  if (text[index] !== ".") return false;
  const before = text.slice(Math.max(0, index - 4), index + 1).toLowerCase();
  return /(?:e\.g\.|i\.e\.|[a-z]\.)$/.test(before) && isLatinOrDigit(text[index - 1]);
};

/**
 * Is this period part of a run of two or more? Then leave the whole run alone.
 *
 * `他想了想...然后说。` used to come back as `他想了想。.。然后说。`: each dot
 * was judged on its own, the first and third saw a CJK neighbour and became
 * 。, and the middle one — CJK on neither side — stayed. Three characters the
 * author typed as one gesture came out as three different characters.
 *
 * A run of dots is an ellipsis the author is spelling in ASCII, or a range, or
 * a placeholder. Whatever it is, it is one token, and this function's only job
 * is to make the loop treat it as one.
 */
function isRunOfDots(text: string, index: number): boolean {
  if (text[index] !== ".") return false;
  return text[index - 1] === "." || text[index + 1] === ".";
}

/**
 * Return conservative, independently confirmable width findings for one block.
 * Source text is never changed here. Ambiguous prose is deliberately left alone.
 */
export function findPunctuation(blockId: string, text: string): readonly PunctuationFinding[] {
  if (/^\s*(```|~~~)/m.test(text) || /\b(?:https?|ftp):\/\//i.test(text)) return [];
  const protectedRanges = inlineCodeRanges(text);
  const findings: PunctuationFinding[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (isProtected(index, protectedRanges)) continue;
    const original = text[index];
    if (original === undefined) continue;
    const before = text[index - 1];
    const after = text[index + 1];
    const cjkSuggestion = ASCII_TO_CJK[original];
    const asciiSuggestion = CJK_TO_ASCII[original];
    let suggested: string | undefined;
    let rule: string | undefined;
    if (
      cjkSuggestion !== undefined &&
      !isDecimal(text, index) &&
      !isAbbreviationPeriod(text, index) &&
      !isRunOfDots(text, index) &&
      (original === "("
        ? isCjk(after)
        : original === ")"
          ? isCjk(before)
          : isCjk(before) || isCjk(after))
    ) {
      suggested = cjkSuggestion;
      rule = "cjk-full-width";
    } else if (
      asciiSuggestion !== undefined &&
      (original === "（"
        ? isLatinOrDigit(after)
        : original === "）"
          ? isLatinOrDigit(before)
          : isLatinOrDigit(before) || isLatinOrDigit(after))
    ) {
      suggested = asciiSuggestion;
      rule = "latin-half-width";
    }
    if (suggested !== undefined && rule !== undefined) {
      findings.push({
        id: `${blockId}:${index}:${rule}`,
        blockId,
        start: index,
        end: index + 1,
        original,
        suggested,
        rule,
      });
    }
  }
  return findings;
}

/** Apply exactly one still-current finding. A stale anchor is a refusal, not a search-and-replace. */
export function applyPunctuationFinding(text: string, finding: PunctuationFinding): string {
  if (text.slice(finding.start, finding.end) !== finding.original) {
    throw new Error("punctuation finding source changed");
  }
  return `${text.slice(0, finding.start)}${finding.suggested}${text.slice(finding.end)}`;
}
