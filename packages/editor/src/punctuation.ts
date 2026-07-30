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
