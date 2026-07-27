import { commonTable, segment } from "./align.ts";
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
 * Align one region, or report it wholesale when it is too large to table.
 *
 * `undefined` from `commonTable` is not an error: a region past the budget is
 * a normal event on a long manuscript, and reporting every sentence in it as
 * deleted-then-inserted is true, coarse, and cheap. The engine used to have no
 * budget at all and allocated whatever the two texts asked for.
 */
const alignRegion = (
  before: readonly Sentence[],
  after: readonly Sentence[],
  emit: (kind: SliceKind, sentence: Sentence | undefined) => void,
): void => {
  const at = commonTable(
    before.map((sentence) => sentence.text),
    after.map((sentence) => sentence.text),
  );

  if (at === undefined) {
    for (const sentence of before) emit("del", sentence);
    for (const sentence of after) emit("ins", sentence);
    return;
  }

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i]?.text === after[j]?.text) {
      emit("same", before[i]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
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

  for (const region of segment(before, after, (sentence) => sentence.text)) {
    // An anchor is identical on both sides by construction, so it needs no
    // table — emitting it directly is both faster and exactly equivalent.
    if (region.anchor) {
      for (const sentence of region.before) emit("same", sentence);
      continue;
    }
    alignRegion(region.before, region.after, emit);
  }

  return slices;
};
