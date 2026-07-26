import type { BlockId } from "./domain.ts";

/**
 * Source fidelity: the bytes the author did not edit come back unchanged.
 *
 * The manuscript on screen is paragraphs; the manuscript on disk is a byte
 * sequence with an author's whitespace in it. Splitting on blank lines and
 * trimming each piece produced a text that looked the same and was not: an
 * ideographic indent — how Chinese prose marks a paragraph — was silently
 * deleted on load, a blank line inside a fence cut one code block into two,
 * and consecutive blank lines collapsed. A manuscript opened and saved with no
 * edit at all lost twelve bytes out of a hundred and eighty-six.
 *
 * So the parse keeps the original string and records where each block sits in
 * it. Saving replaces only the ranges whose text the author actually changed
 * and slices the rest straight out of the original. That is a weaker promise
 * than lossless Markdown — a block the author rewrites is rewritten — but it
 * is the one promise a writing tool cannot do without, and it costs no
 * dependency: `core` stays at zero (SPEC invariant 5).
 *
 * This is deliberately not a Markdown parser. It knows exactly one construct,
 * the fence, because a fence is the only place where a blank line does not
 * mean a paragraph boundary.
 */

export interface SourceBlock {
  readonly id: BlockId;
  /** Where the block's own text starts in `bytes`, excluding separators. */
  readonly start: number;
  readonly end: number;
  /** What the editor displays. Identical to `bytes.slice(start, end)`. */
  readonly text: string;
}

export interface SourceDocument {
  /** The original text, never modified. Every unedited byte is sliced from it. */
  readonly bytes: string;
  readonly blocks: readonly SourceBlock[];
}

export const sourceBlocks = (doc: SourceDocument): readonly SourceBlock[] => doc.blocks;

/** A fence opens on ``` or ~~~ and closes on the same character, at least as long. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * A run of whitespace-only lines separates blocks, except inside a fence.
 *
 * Returned as index pairs rather than substrings: the caller needs to slice
 * the original, and a substring would lose where it came from.
 */
const blockRanges = (bytes: string): Array<readonly [number, number]> => {
  const ranges: Array<readonly [number, number]> = [];
  let blockStart = -1;
  let blockEnd = -1;
  let fence: string | undefined;
  let cursor = 0;

  const close = (): void => {
    if (blockStart >= 0) ranges.push([blockStart, blockEnd] as const);
    blockStart = -1;
    blockEnd = -1;
  };

  while (cursor <= bytes.length) {
    const newline = bytes.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? bytes.length : newline;
    // \r is part of the line's bytes, not of its content: a CRLF file must not
    // be told its lines end in an invisible character it did not ask about.
    const content = bytes.slice(cursor, lineEnd).replace(/\r$/, "");
    const opener = FENCE.exec(content)?.[1];

    // A fence closes only on its own character, and only on a run at least as
    // long as the one that opened it — which is how a ```` block can contain a
    // ``` block without the inner one ending the outer.
    if (fence === undefined) fence = opener;
    else if (opener?.startsWith(fence[0] ?? "") && opener.length >= fence.length) fence = undefined;

    if (fence === undefined && content.trim().length === 0) close();
    else {
      if (blockStart < 0) blockStart = cursor;
      blockEnd = cursor + content.length;
    }

    if (newline === -1) break;
    cursor = newline + 1;
  }
  close();

  return ranges;
};

/**
 * Read a manuscript without changing it.
 *
 * Identity comes from position, so reloading unchanged text yields the same
 * identifiers and a queued proposal still resolves. `chapterId` scopes them so
 * two chapters open at once cannot collide.
 */
export const parseSource = (bytes: string, chapterId = "src"): SourceDocument => ({
  bytes,
  blocks: blockRanges(bytes).map(([start, end], index) => ({
    id: `${chapterId}:b${index}`,
    start,
    end,
    text: bytes.slice(start, end),
  })),
});

/**
 * Write the manuscript back, changing only what the author changed.
 *
 * Blocks absent from `edited` are copied byte for byte out of the original,
 * along with every separator between them, which is what makes an untouched
 * file save identically. An entry whose text equals what is already there is
 * not an edit and takes the same path.
 */
export const serializeSource = (
  doc: SourceDocument,
  edited: ReadonlyMap<BlockId, string>,
): string => {
  let out = "";
  let cursor = 0;
  for (const block of doc.blocks) {
    const replacement = edited.get(block.id);
    out += doc.bytes.slice(cursor, block.start);
    out += replacement === undefined ? doc.bytes.slice(block.start, block.end) : replacement;
    cursor = block.end;
  }
  return out + doc.bytes.slice(cursor);
};

/**
 * The paragraphs of a manuscript, as the rest of the application sees them.
 *
 * One authority. Three copies of this split lived in `core`, the main process,
 * and the renderer; block identity is positional, so a disagreement about
 * where blocks begin renumbers them across a process boundary and silently
 * detaches every queued proposal from the text it was written against.
 */
export const splitBlocks = (text: string): string[] =>
  blockRanges(text).map(([start, end]) => text.slice(start, end));

/** What separates two blocks when the original file has nothing to say. */
const DEFAULT_SEPARATOR = "\n\n";

/** The bytes standing before a block: the author's blank lines, kept as they are. */
const leadingGap = (doc: SourceDocument, at: number): string =>
  doc.bytes.slice(at === 0 ? 0 : (doc.blocks[at - 1]?.end ?? 0), doc.blocks[at]?.start ?? 0);

/**
 * Write a manuscript back from the blocks the application is holding.
 *
 * A block still carrying an identifier the file minted is written into its own
 * place, keeping the blank lines that stood before it — so rewriting one
 * paragraph does not quietly reformat the two around it. A block with an
 * unfamiliar identifier was inserted and takes the ordinary separator. What
 * follows the last block is copied verbatim, which is how a file that ends
 * without a newline does not grow one.
 *
 * Matching on identity rather than on text costs nothing and gets the case
 * that matters right: an edited paragraph is still the same paragraph, and its
 * surroundings are not the author's edit.
 */
export const applyBlocks = (
  doc: SourceDocument,
  blocks: readonly { readonly id: BlockId; readonly text: string }[],
): string => {
  // A file with no blocks is whitespace, and whitespace is still the author's.
  // Falling through to the loop below returned the empty string and emptied it.
  if (doc.blocks.length === 0 && blocks.length === 0) return doc.bytes;

  const at = new Map(doc.blocks.map((block, index) => [block.id, index]));
  let out = "";
  for (const block of blocks) {
    const found = at.get(block.id);
    if (found === undefined) out += (out.length === 0 ? "" : DEFAULT_SEPARATOR) + block.text;
    else out += (out.length === 0 && found !== 0 ? "" : leadingGap(doc, found)) + block.text;
  }
  const last = doc.blocks[doc.blocks.length - 1];
  return out + (last === undefined ? "" : doc.bytes.slice(last.end));
};

/**
 * The identifier prefix a chapter's blocks were minted under.
 *
 * Read off the blocks rather than passed in, so a caller holding a head cannot
 * hand over a prefix that disagrees with it — which would make every block
 * look inserted and discard the file's whitespace wholesale.
 */
export const blockPrefix = (blocks: readonly { readonly id: BlockId }[]): string => {
  for (const block of blocks) {
    const matched = /^(.+):b\d+$/.exec(block.id);
    if (matched?.[1] !== undefined) return matched[1];
  }
  return "src";
};
