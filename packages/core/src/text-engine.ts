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

  // Building the map straight from the list let a later change overwrite an
  // earlier one silently. Two accepted verdicts landing on the same paragraph
  // — routine, once a run returns several slices for one Edit Scope — merged
  // as one, and the manuscript lost a judgment the reader had signed.
  const replaced = new Map<BlockId, TextChange>();
  for (const change of ranges) {
    const key = change.blockIds[0];
    if (key === undefined) continue;
    const earlier = replaced.get(key);
    if (earlier !== undefined)
      throw new Error(
        `two changes address block ${key}: ${JSON.stringify(earlier.text)} and ` +
          `${JSON.stringify(change.text)} — resolve them into one before applying`,
      );
    replaced.set(key, change);
  }
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

  return { id: nextHeadId(), blocks: out, cause };
};
