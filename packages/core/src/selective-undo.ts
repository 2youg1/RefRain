import { type TextChange, type TextHead, touchedBlocks } from "./domain.ts";
import { applyTextAction, blockAt } from "./text-engine.ts";

/**
 * Selective undo (design plan §6.5).
 *
 * Undoing an action from the middle of a history is usually implemented by
 * rewinding and replaying: go back to before the action, drop it, apply
 * everything since. That is linear in the history, and it silently rewrites
 * every later action's identity.
 *
 * This does the opposite. The undo is a *compensating action appended to the
 * current head* — one more edit, made now, that removes whatever of the
 * original is still standing. Ten thousand disjoint actions later, undoing the
 * first costs the same as undoing the last, and every later action keeps its
 * text byte for byte.
 *
 * When a later action touched the same block, there is nothing to compensate
 * safely: the application says so and shows the three texts an author needs to
 * decide — what it said before, what the action made it, and what it says now.
 * The manuscript does not move while that judgment is pending.
 */

export interface TextAction {
  readonly id: string;
  readonly changes: readonly TextChange[];
  /** The change that puts each block back the way it was. */
  readonly undoes: readonly TextChange[];
  readonly at: string;
  readonly cause: string;
}

export type UndoResult =
  | { readonly ok: true; readonly head: TextHead; readonly compensation: TextAction }
  | {
      readonly ok: false;
      readonly reason: "later-action-intersects" | "blocks-gone";
      readonly before: string;
      readonly after: string;
      readonly current: string;
    };

const blocksOf = (action: TextAction): Set<string> =>
  new Set(action.changes.flatMap(touchedBlocks));

/**
 * Only the actions that came after need checking, and only for shared blocks —
 * which is what keeps this independent of how long the history is.
 */
const intersectingBlock = (
  action: TextAction,
  later: readonly TextAction[],
): string | undefined => {
  const touched = blocksOf(action);
  for (const laterAction of later)
    for (const change of laterAction.changes)
      for (const id of touchedBlocks(change)) if (touched.has(id)) return id;
  return undefined;
};

export const selectiveUndo = (
  head: TextHead,
  action: TextAction,
  later: readonly TextAction[],
): UndoResult => {
  const conflict = intersectingBlock(action, later);
  const missing = action.undoes.flatMap(touchedBlocks).find((id) => !blockAt(head, id));
  const first = action.changes[0];
  const affected = conflict ?? missing ?? (first && touchedBlocks(first)[0]);
  const before =
    action.undoes.find((change) => touchedBlocks(change).some((id) => id === affected))?.text ?? "";
  const after =
    action.changes.find((change) => touchedBlocks(change).some((id) => id === affected))?.text ??
    "";
  const current = affected === undefined ? "" : (blockAt(head, affected)?.text ?? "");

  if (conflict !== undefined)
    return { ok: false, reason: "later-action-intersects", before, after, current };

  // The blocks may also have been removed outright, which is not a conflict
  // between edits but still leaves nothing to compensate.
  if (missing !== undefined) return { ok: false, reason: "blocks-gone", before, after, current };

  const compensation: TextAction = {
    id: `undo-${action.id}`,
    changes: action.undoes,
    undoes: action.changes,
    at: new Date().toISOString(),
    cause: `selective-undo(${action.id})`,
  };

  return {
    ok: true,
    head: applyTextAction(head, compensation.changes, compensation.cause),
    compensation,
  };
};
