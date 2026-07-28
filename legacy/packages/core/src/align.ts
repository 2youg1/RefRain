/**
 * Making a long manuscript affordable to compare.
 *
 * The alignment two callers need — the review engine over sentences, the edit
 * log over blocks — is the same alignment, and both of them paid for a table
 * over the whole document. That table is `(n+1)(m+1)` cells of four bytes, so
 * a 40,000-block manuscript asks for 6.4 billion cells: past the ceiling on a
 * single Int32Array, which means the allocation throws rather than merely
 * thrashing. An author with a long book pressed Ctrl+S and the application
 * died, whatever they had changed — the table is allocated before anything is
 * compared, so changing one word cost exactly as much as rewriting everything.
 *
 * The fix exploits what is true of a manuscript rather than of strings in
 * general: almost all of it is unchanged, in long runs. Cutting at those runs
 * turns one enormous table into a handful of small ones, and the diff of the
 * whole equals the diffs of the parts joined by the runs between them.
 *
 * Hirschberg and Myers were both measured against this. Hirschberg fixes the
 * memory and leaves the time; Myers fixes neither at this scale. Segmentation
 * wins because the assumption behind it is the one that holds.
 */

/** An unchanged run this long is a safe place to cut the problem in two. */
export const ANCHOR = 8;

/**
 * How far the search looks for a matching line before giving up.
 *
 * A mismatch is usually a rewritten paragraph, sometimes an insertion of a
 * few. Beyond this the two texts have genuinely diverged and there is nothing
 * to gain from looking further — the region simply stays whole and gets a
 * table of its own.
 */
const PROBE = 64;

/**
 * The largest table worth allocating for one region.
 *
 * 16 million cells is 64 MB, which a machine with room to open the manuscript
 * certainly has. Past it the region is not aligned at all: it is reported as a
 * wholesale replacement, which is both true and cheap. Refusing to allocate is
 * the point — the previous behaviour was to try, and to take the application
 * down with it.
 */
export const TABLE_BUDGET = 16_000_000;

export interface Region<T> {
  readonly before: readonly T[];
  readonly after: readonly T[];
  /** Where this region starts in each side, so callers can report positions. */
  readonly beforeAt: number;
  readonly afterAt: number;
  /** An anchor is identical on both sides and needs no alignment at all. */
  readonly anchor: boolean;
}

/**
 * Find where two sequences resynchronise after a mismatch.
 *
 * Advancing both sides one step each — which is what this did — is only right
 * when the author rewrote a paragraph in place. One inserted paragraph puts
 * every later line one position out, so nothing matches again for the rest of
 * the document, no anchor is ever found, and the whole point of segmenting is
 * lost precisely when the manuscript is longest. Probing both offsets finds
 * the shift and keeps the anchors.
 */
const resync = (
  before: readonly string[],
  after: readonly string[],
  i: number,
  j: number,
): readonly [number, number] => {
  for (let d = 1; d <= PROBE; d++) {
    // Deletion before insertion is arbitrary but must be consistent, or the
    // same pair of texts aligns differently depending on which side is longer.
    if (i + d < before.length && before[i + d] === after[j]) return [i + d, j];
    if (j + d < after.length && before[i] === after[j + d]) return [i, j + d];
  }
  return [i + 1, j + 1];
};

/**
 * Cut two sequences into regions at their long unchanged runs.
 *
 * Anchors come back as regions too, marked, so a caller can copy them through
 * without comparing them and still reconstruct the whole.
 */
export const segment = <T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
): Region<T>[] => {
  const left = before.map(keyOf);
  const right = after.map(keyOf);
  const out: Region<T>[] = [];

  let i = 0;
  let j = 0;
  let heldI = 0;
  let heldJ = 0;

  const flush = (): void => {
    if (heldI === 0 && heldJ === 0) return;
    out.push({
      before: before.slice(i - heldI, i),
      after: after.slice(j - heldJ, j),
      beforeAt: i - heldI,
      afterAt: j - heldJ,
      anchor: false,
    });
    heldI = 0;
    heldJ = 0;
  };

  while (i < before.length && j < after.length) {
    if (left[i] !== right[j]) {
      const [nextI, nextJ] = resync(left, right, i, j);
      heldI += nextI - i;
      heldJ += nextJ - j;
      i = nextI;
      j = nextJ;
      continue;
    }

    let run = 0;
    while (i + run < before.length && j + run < after.length && left[i + run] === right[j + run])
      run++;

    if (run >= ANCHOR) {
      flush();
      out.push({
        before: before.slice(i, i + run),
        after: after.slice(j, j + run),
        beforeAt: i,
        afterAt: j,
        anchor: true,
      });
      i += run;
      j += run;
      continue;
    }

    i += run;
    j += run;
    heldI += run;
    heldJ += run;
  }

  heldI += before.length - i;
  heldJ += after.length - j;
  i = before.length;
  j = after.length;
  flush();

  return out;
};

/**
 * Longest-common-subsequence lengths for one region, or nothing.
 *
 * Returning `undefined` rather than throwing is deliberate: a region too large
 * to align is a normal event on a long manuscript, and the caller's answer —
 * report it as one wholesale replacement — is correct and cheap. Throwing
 * would make the size of the author's book a crash.
 */
export const commonTable = (
  before: readonly string[],
  after: readonly string[],
): ((i: number, j: number) => number) | undefined => {
  const width = after.length + 1;
  const cells = (before.length + 1) * width;
  if (cells > TABLE_BUDGET || !Number.isSafeInteger(cells)) return undefined;

  const common = new Int32Array(cells);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));

  return at;
};
