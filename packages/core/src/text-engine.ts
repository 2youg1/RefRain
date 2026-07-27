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
  const ranges = changes.filter((change) => change.kind !== "insert");
  const replaced = new Map(ranges.map((change) => [change.blockIds[0], change] as const));
  const consumed = new Set(ranges.flatMap((change) => change.blockIds));
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

  // Scanning the surviving blocks for each insertion — once for the duplicate
  // check, once for the boundary — is linear inside a loop over changes, and
  // the manuscript this has to hold is 10⁵ blocks. Both questions are answered
  // from one index built here, and the insertions are grouped by the block they
  // land before so the result is assembled in a single pass instead of by
  // repeated splicing, which is itself linear per call.
  const inserts = changes.filter((change) => change.kind === "insert");
  if (inserts.length === 0) return { id: nextHeadId(), blocks, cause };

  const present = new Map(blocks.map((block, index) => [block.id, index] as const));
  const byId = new Map(inserts.map((change) => [change.blockId, change] as const));
  if (byId.size !== inserts.length || inserts.some((change) => present.has(change.blockId))) {
    const duplicate =
      inserts.find((change) => present.has(change.blockId)) ??
      inserts.find(
        (change, index) => inserts.findIndex((c) => c.blockId === change.blockId) < index,
      );
    throw new Error(`cannot insert duplicate block ${duplicate?.blockId}`);
  }

  /**
   * Which surviving block does this insertion ultimately land before?
   *
   * An insertion may name another insertion from the same action as its
   * boundary — that is how a run of new paragraphs keeps its order — so the
   * chain is followed until it reaches a block that already exists or runs off
   * the end. Following it rather than requiring declaration order is what the
   * old repeated-splice loop achieved implicitly, at the cost of a linear scan
   * for every change.
   */
  const anchorOf = new Map<string, number>();
  const anchorFor = (change: TextChange & { kind: "insert" }): number => {
    const seen: string[] = [];
    let at: TextChange & { kind: "insert" } = change;
    for (;;) {
      const cached = anchorOf.get(at.blockId);
      if (cached !== undefined) break;
      seen.push(at.blockId);
      if (at.beforeBlockId === undefined) {
        anchorOf.set(at.blockId, blocks.length);
        break;
      }
      const existing = present.get(at.beforeBlockId);
      if (existing !== undefined) {
        anchorOf.set(at.blockId, existing);
        break;
      }
      const next = byId.get(at.beforeBlockId);
      if (next === undefined)
        throw new Error(`cannot insert before missing block ${at.beforeBlockId}`);
      if (seen.includes(next.blockId))
        throw new Error(`cannot insert block ${next.blockId} before itself`);
      at = next;
    }
    const resolved = anchorOf.get(at.blockId) as number;
    for (const id of seen) anchorOf.set(id, resolved);
    return resolved;
  };

  const pendingAt = new Map<number, Block[]>();
  for (const change of inserts) {
    const index = anchorFor(change);
    const slot = pendingAt.get(index);
    const block = { id: change.blockId, text: change.text };
    if (slot === undefined) pendingAt.set(index, [block]);
    else slot.push(block);
  }

  const out: Block[] = [];
  for (const [index, block] of blocks.entries()) {
    const ahead = pendingAt.get(index);
    if (ahead !== undefined) out.push(...ahead);
    out.push(block);
  }
  const tail = pendingAt.get(blocks.length);
  if (tail !== undefined) out.push(...tail);

  return { id: nextHeadId(), blocks: out, cause };
};
