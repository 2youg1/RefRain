import type { Block, EditorChange } from "./model";

// The editor owns one mutable projection array for its lifetime. Index it by
// identity so an ordinary one-block replacement neither scans nor copies a
// 100,000-block manuscript. Structural edits repair only the moved suffix.
const indexes = new WeakMap<Block[], Map<string, number>>();
const placeholders = new WeakMap<Block[], number>();

export function projectionIndex(blocks: Block[]): Map<string, number> {
  const current = indexes.get(blocks);
  if (current !== undefined) return current;
  const built = new Map(blocks.map((block, index) => [block.id, index]));
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

function nextPlaceholder(blocks: Block[]): string {
  const next = (placeholders.get(blocks) ?? 0) + 1;
  placeholders.set(blocks, next);
  return `pending-${next}`;
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
        blocks[start] = { id: first, text: change.text };
        continue;
      }
      for (const id of change.blocks) at.delete(id);
      const replacement = change.text === null ? [] : [{ id: first, text: change.text }];
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
