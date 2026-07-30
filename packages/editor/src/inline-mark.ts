/**
 * Inline Markdown marks as a toggle over the block's own source text.
 *
 * The manuscript's Markdown source is the only text authority, so a mark is
 * applied by rewriting that string, never by editing the DOM. Reading the
 * current state before writing is what keeps a second bold from producing
 * `****text****`: the second press removes the pair it finds.
 */

export type InlineMark = "strong" | "emphasis";

/** Whether a character range already carries a mark. */
export type MarkState = "on" | "off" | "mixed";

const MARKER: Readonly<Record<InlineMark, string>> = {
  strong: "**",
  emphasis: "*",
};

/** One rewritten block plus the range the same characters now occupy. */
export interface MarkEdit {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A run of `*` at `index`, scanned outward. `**a**` must not read as emphasis
 * with an extra asterisk beside it, so a marker only counts when the run
 * length matches the mark exactly.
 */
function asteriskRunBefore(text: string, index: number): number {
  let length = 0;
  while (index - length - 1 >= 0 && text[index - length - 1] === "*") length += 1;
  return length;
}

function asteriskRunAfter(text: string, index: number): number {
  let length = 0;
  while (index + length < text.length && text[index + length] === "*") length += 1;
  return length;
}

/** Trim a range inward to non-whitespace. CommonMark rejects `** text **`. */
function shrinkToContent(
  text: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from] ?? "")) from += 1;
  while (to > from && /\s/.test(text[to - 1] ?? "")) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

/** Paired marker positions strictly inside a range, outermost pairs first. */
function pairedMarkersWithin(
  text: string,
  start: number,
  end: number,
  marker: string,
): readonly number[] {
  const positions: number[] = [];
  let index = start;
  while (index <= end - marker.length) {
    if (
      text.startsWith(marker, index) &&
      asteriskRunAfter(text, index) === marker.length &&
      asteriskRunBefore(text, index) === 0
    ) {
      positions.push(index);
      index += marker.length;
      continue;
    }
    index += 1;
  }
  // A lone marker is the author's literal text, not a pair we may strip.
  return positions.length % 2 === 0 ? positions : positions.slice(0, -1);
}

/** Read the mark state of a character range in one block's source text. */
export function inlineMarkState(
  text: string,
  start: number,
  end: number,
  mark: InlineMark,
): MarkState {
  const marker = MARKER[mark];
  const content = shrinkToContent(text, start, end);
  if (content === null) return "off";
  const before = text.slice(Math.max(0, content.start - marker.length), content.start);
  const after = text.slice(content.end, content.end + marker.length);
  // Measure the whole delimiter run across each boundary, not just the part
  // outside the selection. In `**Alpha**` the emphasis-sized slice `*Alpha*`
  // sits inside a two-asterisk run, so it is a strong pair, not emphasis.
  const openRun = asteriskRunBefore(text, content.start) + asteriskRunAfter(text, content.start);
  const closeRun = asteriskRunBefore(text, content.end) + asteriskRunAfter(text, content.end);
  const wrapped =
    before === marker &&
    after === marker &&
    openRun === marker.length &&
    closeRun === marker.length;
  if (wrapped) return "on";
  return pairedMarkersWithin(text, content.start, content.end, marker).length > 0 ? "mixed" : "off";
}

/**
 * Toggle a mark over a character range. Returns null when there is nothing to
 * mark, so the caller can leave the button inert rather than insert an empty
 * `****`.
 */
export function applyInlineMark(
  text: string,
  start: number,
  end: number,
  mark: InlineMark,
): MarkEdit | null {
  const marker = MARKER[mark];
  const content = shrinkToContent(text, start, end);
  if (content === null) return null;
  const state = inlineMarkState(text, content.start, content.end, mark);

  if (state === "on") {
    const head = text.slice(0, content.start - marker.length);
    const body = text.slice(content.start, content.end);
    const tail = text.slice(content.end + marker.length);
    return { text: `${head}${body}${tail}`, start: head.length, end: head.length + body.length };
  }

  const head = text.slice(0, content.start);
  const tail = text.slice(content.end);
  let body = text.slice(content.start, content.end);
  if (state === "mixed") {
    // Normalize first: the author selected a span where part is already marked
    // and expects one uniform mark, not nested delimiters.
    const positions = pairedMarkersWithin(text, content.start, content.end, marker);
    let stripped = "";
    let cursor = content.start;
    for (const position of positions) {
      stripped += text.slice(cursor, position);
      cursor = position + marker.length;
    }
    stripped += text.slice(cursor, content.end);
    body = stripped;
  }
  return {
    text: `${head}${marker}${body}${marker}${tail}`,
    start: head.length + marker.length,
    end: head.length + marker.length + body.length,
  };
}
