import type { Block, EditorChange } from "./model";

// The editor owns one mutable projection array for its lifetime. Index it by
// identity so an ordinary one-block replacement neither scans nor copies a
// 100,000-block manuscript. Structural edits repair only the moved suffix.
const indexes = new WeakMap<Block[], Map<string, number>>();
const placeholders = new WeakMap<Block[], number>();

export function projectionIndex(blocks: Block[]): Map<string, number> {
  const current = indexes.get(blocks);
  if (current !== undefined) return current;
  const built = new Map<string, number>();
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== undefined) built.set(block.id, index);
  }
  indexes.set(blocks, built);
  return built;
}

function reindex(blocks: Block[], from: number): void {
  const at = projectionIndex(blocks);
  for (let index = from; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== undefined) at.set(block.id, index);
  }
}

/**
 * The prefix of locally minted placeholder ids. Structural edits (split,
 * multi-block paste) create blocks that live under this name until the
 * domain confirms and assigns real ids. Only this module mints or parses
 * the scheme; the view uses the prefix to decide "record this edit locally,
 * submit it once a real name exists" (see #adoptPending in the view).
 */
export const PENDING_ID_PREFIX = "pending-";

function nextPlaceholder(blocks: Block[]): string {
  const next = (placeholders.get(blocks) ?? 0) + 1;
  placeholders.set(blocks, next);
  return `${PENDING_ID_PREFIX}${next}`;
}

/** Mirror settled changes onto the local projection until the domain confirms. */
export function applyLocally(blocks: Block[], changes: readonly EditorChange[]): Block[] {
  const at = projectionIndex(blocks);
  for (const change of changes) {
    if (change.kind === "replace") {
      const first = change.blocks[0];
      if (first === undefined) continue;
      const start = at.get(first) ?? -1;
      if (start === -1) continue;
      const span = change.blocks.length;
      if (span === 1 && change.text !== null) {
        // Keep the block's shape: it is a hint for height prediction, and a
        // replacement that drops it sends the block back to the flat estimate
        // (an edited fence also lost its highlight until confirmation).
        const previous = blocks[start];
        blocks[start] =
          previous === undefined
            ? { id: first, text: change.text }
            : { ...previous, text: change.text };
        continue;
      }
      for (const id of change.blocks) at.delete(id);
      const previous = blocks[start];
      const replacement =
        change.text === null
          ? []
          : [
              previous === undefined
                ? { id: first, text: change.text }
                : { ...previous, text: change.text },
            ];
      blocks.splice(start, span, ...replacement);
      reindex(blocks, start);
      continue;
    }

    const position = change.before === null ? blocks.length : (at.get(change.before) ?? -1);
    const insertAt = position === -1 ? blocks.length : position;
    const inserted = change.texts.map((text) => ({ id: nextPlaceholder(blocks), text }));
    blocks.splice(insertAt, 0, ...inserted);
    reindex(blocks, insertAt);
  }
  return blocks;
}
