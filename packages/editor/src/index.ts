/**
 * The ProseMirror adapter.
 *
 * This package is framework-free: it imports no Vue and no generated Tauri
 * binding (SPEC 6.2). It is the only module that touches manuscript DOM, and
 * the only path from an editor transaction to the domain is an EditorAction.
 *
 * R0 establishes the boundary. The adapter itself lands in R1, after the
 * falsification clause in SPEC 7.5 is settled.
 */

/** A block as the domain hands it over: an opaque id and its text. */
export interface Block {
  readonly id: string;
  readonly text: string;
}

/**
 * One block's change within an EditorAction.
 *
 * The id survives a replacement (SPEC 7.3). Minting a new id here detaches
 * every queued Proposal, compensating undo, and decoration anchor at once, and
 * selective undo is the only feature that exposes it.
 */
export interface BlockDelta {
  readonly id: string;
  readonly text: string;
}

/**
 * The sole text path from the editor to the domain (SPEC 7.2). It is an input
 * to a Text Action, not a second domain model.
 */
export interface EditorAction {
  readonly baseRevision: string;
  readonly deltas: readonly BlockDelta[];
}

/** Preserves block identity across a replacement. */
export function replaceText(block: Block, text: string): BlockDelta {
  return { id: block.id, text };
}
