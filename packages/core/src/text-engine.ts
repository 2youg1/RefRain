import { randomUUID } from "node:crypto";
import type { Block, BlockId, TextChange, TextHead } from "./domain.ts";
import { splitBlocks } from "./roundtrip.ts";
import { newTextHeadId } from "./text-head-id.ts";

/** Blocks are separated by a blank line, which is also Markdown's paragraph break. */
const SEPARATOR = "\n\n";

export const currentText = (head: TextHead): string =>
  head.blocks.map((b) => b.text).join(SEPARATOR);

export const blockAt = (head: TextHead, id: BlockId): Block | undefined =>
  head.blocks.find((b) => b.id === id);

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

  // Registering only each range's first block let two overlapping changes pass
  // whenever the shared block was not first in both scopes. The later loop then
  // emitted that block twice, which is the same hidden ordering F-8 forbids.
  const replaced = new Map<BlockId, TextChange>();
  const addressed = new Map<BlockId, TextChange>();
  for (const change of ranges) {
    for (const id of change.blockIds) {
      const earlier = addressed.get(id);
      if (earlier !== undefined)
        throw new Error(
          `two changes address block ${id}: ${JSON.stringify(earlier.text)} and ` +
            `${JSON.stringify(change.text)} — resolve them into one before applying`,
        );
      addressed.set(id, change);
    }
    const key = change.blockIds[0];
    if (key !== undefined) replaced.set(key, change);
  }
  const consumed = new Set(ranges.flatMap((change) => change.blockIds));
  const blocks: Block[] = [];

  for (const block of head.blocks) {
    const change = replaced.get(block.id);
    if (change) {
      // A replacement may span paragraphs. Keeping its separators inside one
      // block made the in-memory head disagree with the same text after reload.
      // Existing identifiers stay positional inside the scope so queued
      // Proposals remain anchored; only paragraphs beyond that scope are new.
      if (change.text !== null)
        blocks.push(
          ...splitBlocks(change.text).map((text, index) => ({
            id: change.blockIds[index] ?? `b-${randomUUID()}`,
            text,
          })),
        );
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
  if (inserts.length === 0) return { id: newTextHeadId(), blocks, cause };

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
  interface Landing {
    /** Index in the surviving blocks this insertion goes before. */
    readonly slot: number;
    /** Links between this insertion and the block that terminates its chain. */
    readonly depth: number;
  }

  const landing = new Map<string, Landing>();
  const landingFor = (change: TextChange & { kind: "insert" }): Landing => {
    // A Set, not an array: `includes` down a chain of n insertions is n² work
    // on the path a run of new paragraphs actually takes.
    const seen = new Set<string>();
    const walked: string[] = [];
    let at: TextChange & { kind: "insert" } = change;
    let known: Landing | undefined;

    for (;;) {
      known = landing.get(at.blockId);
      if (known !== undefined) break;
      seen.add(at.blockId);
      walked.push(at.blockId);

      if (at.beforeBlockId === undefined) {
        known = { slot: blocks.length, depth: 0 };
        break;
      }
      const existing = present.get(at.beforeBlockId);
      if (existing !== undefined) {
        known = { slot: existing, depth: 0 };
        break;
      }
      const next = byId.get(at.beforeBlockId);
      if (next === undefined)
        throw new Error(`cannot insert before missing block ${at.beforeBlockId}`);
      if (seen.has(next.blockId))
        throw new Error(`cannot insert block ${next.blockId} before itself`);
      at = next;
    }

    // The last identifier walked sits one link above whatever terminated the
    // chain, and each earlier one is a link further out.
    for (const [back, id] of [...walked].reverse().entries())
      landing.set(id, { slot: known.slot, depth: known.depth + back + 1 });

    return landing.get(change.blockId) ?? known;
  };

  const pendingAt = new Map<number, { block: Block; depth: number }[]>();
  for (const change of inserts) {
    const { slot, depth } = landingFor(change);
    const entry = { block: { id: change.blockId, text: change.text }, depth };
    const group = pendingAt.get(slot);
    if (group === undefined) pendingAt.set(slot, [entry]);
    else group.push(entry);
  }

  // Deeper means further from the block that ends the chain, so it comes first.
  // Declaration order decides nothing here; it only decides which of two
  // insertions at the same depth — independent of each other — leads.
  const ordered = (slot: number): Block[] =>
    (pendingAt.get(slot) ?? [])
      .map((entry, index) => ({ ...entry, index }))
      .sort((left, right) => right.depth - left.depth || left.index - right.index)
      .map((entry) => entry.block);

  const out: Block[] = [];
  for (const [index, block] of blocks.entries()) {
    out.push(...ordered(index));
    out.push(block);
  }
  out.push(...ordered(blocks.length));

  return { id: newTextHeadId(), blocks: out, cause };
};
