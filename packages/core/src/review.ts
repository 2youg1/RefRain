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
 * Longest common subsequence over sentences. Unchanged sentences surface as
 * context so the author reviews only what actually moved.
 */
export const sliceProposal = (proposal: Proposal): ReviewSlice[] => {
  const before = sentences(proposal.before);
  const after = proposal.after === null ? [] : sentences(proposal.after);
  const width = after.length + 1;

  // Flat row-major LCS table. One typed array beats an array of arrays here:
  // it keeps the index arithmetic in one place and stays contiguous in memory.
  const common = new Int32Array((before.length + 1) * width);
  const lengthAt = (i: number, j: number): number => common[i * width + j] ?? 0;

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i]?.text === after[j]?.text
          ? lengthAt(i + 1, j + 1) + 1
          : Math.max(lengthAt(i + 1, j), lengthAt(i, j + 1));

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

  return slices;
};
