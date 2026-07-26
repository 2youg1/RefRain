import type { Block, BlockId, TextChange, TextHead } from "./domain.ts";

/** Blocks are separated by a blank line, which is also Markdown's paragraph break. */
const SEPARATOR = "\n\n";

export const currentText = (head: TextHead): string =>
  head.blocks.map((b) => b.text).join(SEPARATOR);

export const blockAt = (head: TextHead, id: BlockId): Block | undefined =>
  head.blocks.find((b) => b.id === id);

let sequence = 0;
const nextHeadId = (): string => `h${++sequence}`;

/**
 * The only function that advances the manuscript (SPEC 3.1). Agent output never
 * reaches here directly: it arrives as a Proposal that a human has committed.
 */
export const applyTextAction = (
  head: TextHead,
  changes: readonly TextChange[],
  cause: string,
): TextHead => {
  const replaced = new Map(changes.map((c) => [c.blockIds[0], c] as const));
  const consumed = new Set(changes.flatMap((c) => c.blockIds));
  const blocks: Block[] = [];

  for (const block of head.blocks) {
    const change = replaced.get(block.id);
    if (change) {
      // The identifier survives a replacement: the words changed, the paragraph
      // did not. Minting a new id here made every later reference — a queued
      // proposal, a compensating undo — unable to find the block it names.
      if (change.text !== null) blocks.push({ id: block.id, text: change.text });
      continue;
    }
    if (!consumed.has(block.id)) blocks.push(block);
  }

  return { id: nextHeadId(), blocks, cause };
};
