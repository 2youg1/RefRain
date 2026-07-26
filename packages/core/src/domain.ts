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

/** Replace a run of existing blocks, or delete it when text is null. */
export interface RangeTextChange {
  readonly kind?: "range";
  readonly blockIds: readonly BlockId[];
  readonly text: string | null;
}

/** Restore or add one block at a stable lineage boundary. */
export interface InsertTextChange {
  readonly kind: "insert";
  readonly blockIds: readonly [];
  readonly text: string;
  readonly blockId: BlockId;
  /** Absent means append; a named boundary that vanished is a conflict. */
  readonly beforeBlockId?: BlockId;
}

/** One independently locatable item inside a Text Action. */
export type TextChange = RangeTextChange | InsertTextChange;
