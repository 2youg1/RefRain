/** Public editor contract. The Rust domain owns canonical bytes; these values are projections. */

/**
 * A block as the domain hands it over: an opaque id, its text, and — when the
 * bridge sends it — the byte shape the viewport uses to predict its height.
 *
 * The shape is optional because blocks are also created locally, ahead of the
 * domain's confirmation, and those have no shape until it comes back. A block
 * without one falls back to the flat estimate, which is what every block used
 * before.
 */
export interface Block {
  readonly id: string;
  readonly text: string;
  /** Display-width equivalents: CJK and full-width punctuation count two. */
  readonly widthUnits?: number;
  /** Line breaks the author typed. The block occupies at least this many plus one. */
  readonly hardLines?: number;
  /** The widest single line: a narrow block does not wrap just because it is long. */
  readonly maxLineUnits?: number;
  /** A fence keeps the author's lines instead of wrapping. */
  readonly isFence?: boolean;
}

/** The document the adapter projects: a revision and its blocks. */
export interface EditorDocument {
  readonly revision: string;
  readonly blocks: readonly Block[];
}

/** One independently locatable text change. */
export type EditorChange =
  | { readonly kind: "replace"; readonly blocks: readonly string[]; readonly text: string | null }
  | { readonly kind: "insert"; readonly before: string | null; readonly texts: readonly string[] };

/** The sole text path from the editor to the domain. */
export interface EditorAction {
  readonly baseRevision: string;
  readonly changes: readonly EditorChange[];
}

/** The injected cross-layer callback: the only way text leaves the editor. */
export interface EditorPort {
  /** Called with every settled action. The host confirms asynchronously. */
  readonly submit: (action: EditorAction) => void;
}

/** How much the author has selected. Null when the selection is collapsed. */
export interface SelectionMeasure {
  /** Characters, counted by code point so a CJK glyph counts as one. */
  readonly characters: number;
  /** How many blocks the selection touches. One for an ordinary selection. */
  readonly blocks: number;
}

export type EditorFormat = "strong" | "emphasis";

export type { BlockPrefix } from "./block-prefix";

import type { BlockPrefix } from "./block-prefix";

export interface PunctuationFinding {
  readonly id: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly original: string;
  readonly suggested: string;
  readonly rule: string;
}

export interface EditorAnnotationProjection {
  readonly id: string;
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: "highlight" | "comment";
  readonly anchorState: "anchored" | "drifted";
}

export interface EditorContext {
  readonly blockId: string;
  readonly canFormat: boolean;
  readonly canDeleteEmpty: boolean;
  readonly selection: {
    readonly start: number;
    readonly end: number;
    readonly quote: string;
  } | null;
  readonly punctuation: readonly PunctuationFinding[];
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export interface EditorHandle {
  /** Move the base the adapter diffs against after the domain confirms. */
  setRevision(revision: string): void;
  /** Project a different document after a switch or an external change. */
  replace(document: EditorDocument): void;
  /** Put the caret in a block, at an optional character offset. */
  focus(blockId?: string, offset?: number): void;
  /** Return the collapsed caret, or null when the selection is elsewhere. */
  caret(): { blockId: string; offset: number } | null;
  /** Capture the semantic block and safe actions for one editor target. */
  context(target: EventTarget | null): EditorContext | null;
  /** Format the selection captured by the latest editor context request. */
  formatSelection(kind: EditorFormat): boolean;
  /**
   * Toggle a block-level Markdown prefix on the block holding the caret.
   *
   * Separate from `formatSelection` because the two are different syntaxes: an
   * inline mark wraps a range, a prefix rewrites the start of every line. They
   * also answer "is it already on?" differently.
   */
  applyBlockPrefix(prefix: BlockPrefix): boolean;
  /** Remove the captured empty block through the ordinary EditorAction path. */
  deleteEmptyBlock(): boolean;
  /** Confirm one still-current punctuation finding through one EditorAction. */
  applyPunctuation(finding: PunctuationFinding): boolean;
  /**
   * Observe how much text is selected, for a low-noise readout.
   *
   * Not `context()`: that answers for one right-click target and captures a
   * selection for a later action. This is a running measure of what the author
   * has highlighted, and it must survive a drag across paragraphs — the count
   * is over the whole selection, not the block it started in.
   *
   * Returns a function that stops observing.
   */
  onSelectionMeasured(listener: (measure: SelectionMeasure | null) => void): () => void;
  /** Project persisted anchors without inserting markup into manuscript text. */
  setAnnotations(annotations: readonly EditorAnnotationProjection[]): void;
  /** During composition, candidate text is not settled manuscript text. */
  isComposing(): boolean;
  /**
   * Resolve once no composition is in flight.
   *
   * A save during IME composition must wait for the author to finish choosing
   * candidates. Waiting on the composition event is exact; a timer is a guess
   * that is simultaneously too long for fast typists and too short for slow
   * ones.
   */
  whenSettled(): Promise<void>;
  destroy(): void;
}
