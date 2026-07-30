/** Public editor contract. The Rust domain owns canonical bytes; these values are projections. */

/** A block as the domain hands it over: an opaque id and its text. */
export interface Block {
  readonly id: string;
  readonly text: string;
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

export interface EditorHandle {
  /** Move the base the adapter diffs against after the domain confirms. */
  setRevision(revision: string): void;
  /** Project a different document after a switch or an external change. */
  replace(document: EditorDocument): void;
  /** Put the caret in a block, at an optional character offset. */
  focus(blockId?: string, offset?: number): void;
  /** Return the collapsed caret, or null when the selection is elsewhere. */
  caret(): { blockId: string; offset: number } | null;
  /** During composition, candidate text is not settled manuscript text. */
  isComposing(): boolean;
  destroy(): void;
}
