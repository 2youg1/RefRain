// Domain language of SPEC 2. One concept, one word; no synonyms.

export type BlockId = string;
export type TextHeadId = string;
export type RevisionId = string;

/** A locatable unit of the manuscript. Paragraph-granular. */
export interface Block {
  readonly id: BlockId;
  readonly text: string;
}

/** The immutable manuscript state produced by a completed Text Action. */
export interface TextHead {
  readonly id: TextHeadId;
  readonly blocks: readonly Block[];
  /** Why this head exists. Carried into the audit record. */
  readonly cause: string;
}

/** One item inside a Text Action: replace a run of blocks, or delete it. */
export interface TextChange {
  readonly blockIds: readonly BlockId[];
  readonly text: string | null;
}
