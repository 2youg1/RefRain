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

/**
 * The blocks a change touches — the single authority for that question.
 *
 * `InsertTextChange.blockIds` is `readonly []`, an empty tuple: the type
 * promises the field never names a block, and the block being created lives in
 * `blockId`. Anything that reads `change.blockIds` directly is therefore blind
 * to insertions. Selective undo read it five times and reported a clean undo
 * for an inserted block a later action had rewritten — success, on a check
 * that had looked at nothing.
 *
 * Read this instead of the field.
 */
export const touchedBlocks = (change: TextChange): readonly BlockId[] =>
  change.kind === "insert" ? [change.blockId] : change.blockIds;
