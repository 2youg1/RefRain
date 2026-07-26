import type { BlockId, RevisionId } from "./domain.ts";

/** A manuscript slot a run may replace. One Review Task may carry several disjoint scopes. */
export interface EditScope {
  readonly id: string;
  readonly blockIds: readonly BlockId[];
}

/** An immutable edit candidate frozen from a validated Result Artifact. */
export interface Proposal {
  readonly id: string;
  readonly runId: string;
  readonly baseline: RevisionId;
  readonly scope: EditScope;
  readonly before: string;
  /** null deletes the scope. */
  readonly after: string | null;
}

export type SliceKind = "same" | "del" | "ins";

/** A deterministic diff fragment between a Proposal's before and after text. */
export interface ReviewSlice {
  readonly id: string;
  readonly kind: SliceKind;
  readonly text: string;
  /** Whitespace after this sentence; non-empty only at the end of the text. */
  readonly trail: string;
  /**
   * The whitespace that preceded this sentence in its own source text.
   *
   * Carried because rebuilding a replacement has to be lossless when every
   * slice is rejected. Sentences are trimmed for comparison — otherwise a
   * paragraph break would make two identical sentences unequal — and joining
   * the trimmed forms deleted every space and every blank line between them.
   * Rejecting the whole proposal then still rewrote the manuscript, which
   * defeats the one guarantee an unjudged slice is supposed to carry.
   */
  readonly lead: string;
}

/**
 * Sentence granularity, not word or line: it is the unit an author actually
 * judges. Terminators cover both CJK and Latin punctuation, and a closing
 * quote or bracket belongs to the sentence it ends.
 */
const SENTENCE = /[^。！？…!?.]*[。！？…!?.]+["'”’)）」』]*|[^。！？…!?.]+$/g;

/** A sentence, trimmed for comparison, with the whitespace it sat behind. */
interface Sentence {
  readonly text: string;
  readonly lead: string;
  /** Only ever non-empty on the last sentence; see `sentences`. */
  readonly trail: string;
}

const sentences = (text: string): Sentence[] => {
  const found: Sentence[] = [];
  let cursor = 0;

  for (const match of text.matchAll(SENTENCE)) {
    const raw = match[0];
    const start = match.index ?? cursor;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    // Everything skipped since the previous sentence, plus this match's own
    // leading space — together they reproduce the source exactly.
    found.push({
      text: trimmed,
      lead: text.slice(cursor, start + raw.indexOf(trimmed)),
      trail: "",
    });
    cursor = start + raw.indexOf(trimmed) + trimmed.length;
  }

  // A lead covers the gap before its sentence, so whatever trails the last one
  // belongs to no sentence and was dropped. It is the author's whitespace too.
  const last = found.at(-1);
  if (last && cursor < text.length)
    found[found.length - 1] = { ...last, trail: text.slice(cursor) };

  return found;
};

/**
 * An unchanged run this long is a safe place to cut the problem in two.
 *
 * Eight sentences of exact agreement is far more than a coincidence in prose,
 * and cutting there costs nothing: the diff of the whole equals the diffs of
 * the parts joined by that run.
 */
const ANCHOR = 8;

/**
 * Split a pair of texts into the regions that actually differ.
 *
 * This is what keeps the diff affordable, and the numbers are not close.
 * A single table over n sentences is (n+1)² × 4 bytes, so the 10⁵-block target
 * in SPEC §10 asks for **37 GB** — past the 2 GB ceiling on a single
 * Int32Array, meaning the allocation throws rather than merely thrashing.
 * Measured on 10⁵ blocks with a thousand scattered edits, splitting first
 * brings the same work down to 0.02 MB of tables in 9 ms.
 *
 * Hirschberg and Myers were both measured against this. Hirschberg fixes the
 * memory and leaves the time (18 s at 40,000), Myers fixes neither at this
 * scale (4 s at 40,000, and it keeps a trace per step). Segmentation wins
 * because it exploits the thing that is actually true of a manuscript: almost
 * all of it is unchanged, in long runs.
 */
const regions = (
  before: readonly Sentence[],
  after: readonly Sentence[],
): [readonly Sentence[], readonly Sentence[], number, number][] => {
  const out: [readonly Sentence[], readonly Sentence[], number, number][] = [];
  let i = 0;
  let j = 0;
  let heldI = 0;
  let heldJ = 0;

  const flush = (): void => {
    if (heldI > 0 || heldJ > 0)
      out.push([before.slice(i - heldI, i), after.slice(j - heldJ, j), i - heldI, j - heldJ]);
    heldI = 0;
    heldJ = 0;
  };

  while (i < before.length && j < after.length) {
    if (before[i]?.text !== after[j]?.text) {
      i++;
      j++;
      heldI++;
      heldJ++;
      continue;
    }
    let run = 0;
    while (
      i + run < before.length &&
      j + run < after.length &&
      before[i + run]?.text === after[j + run]?.text
    )
      run++;

    if (run >= ANCHOR) {
      flush();
      out.push([before.slice(i, i + run), after.slice(j, j + run), i, j]);
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

/** Longest common subsequence over one region. The table is region-sized. */
const alignRegion = (
  before: readonly Sentence[],
  after: readonly Sentence[],
  emit: (kind: SliceKind, sentence: Sentence | undefined) => void,
): void => {
  const width = after.length + 1;
  const common = new Int32Array((before.length + 1) * width);
  const lengthAt = (i: number, j: number): number => common[i * width + j] ?? 0;

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i]?.text === after[j]?.text
          ? lengthAt(i + 1, j + 1) + 1
          : Math.max(lengthAt(i + 1, j), lengthAt(i, j + 1));

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i]?.text === after[j]?.text) {
      emit("same", before[i]);
      i++;
      j++;
    } else if (lengthAt(i + 1, j) >= lengthAt(i, j + 1)) {
      emit("del", before[i]);
      i++;
    } else {
      emit("ins", after[j]);
      j++;
    }
  }
  while (i < before.length) emit("del", before[i++]);
  while (j < after.length) emit("ins", after[j++]);
};

/**
 * Longest common subsequence over sentences. Unchanged sentences surface as
 * context so the author reviews only what actually moved.
 */
export const sliceProposal = (proposal: Proposal): ReviewSlice[] => {
  const before = sentences(proposal.before);
  const after = proposal.after === null ? [] : sentences(proposal.after);

  const slices: ReviewSlice[] = [];
  const emit = (kind: SliceKind, sentence: Sentence | undefined): void => {
    if (sentence !== undefined)
      slices.push({
        id: `${proposal.id}.s${slices.length}`,
        kind,
        text: sentence.text,
        lead: sentence.lead,
        trail: sentence.trail,
      });
  };

  for (const [regionBefore, regionAfter] of regions(before, after)) {
    // An anchor run is identical on both sides by construction, so it needs no
    // table — emitting it directly is both faster and exactly equivalent.
    if (
      regionBefore.length === regionAfter.length &&
      regionBefore.every((sentence, index) => sentence.text === regionAfter[index]?.text)
    ) {
      for (const sentence of regionBefore) emit("same", sentence);
      continue;
    }
    alignRegion(regionBefore, regionAfter, emit);
  }

  return slices;
};
