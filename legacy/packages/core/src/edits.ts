import { randomUUID } from "node:crypto";
import { commonTable, segment } from "./align.ts";
import type { Block, TextChange, TextHead } from "./domain.ts";
import { splitBlocks } from "./roundtrip.ts";
import { applyTextAction } from "./text-engine.ts";
import { cdata, xmlText } from "./xml.ts";

/**
 * The record of what the author changed.
 *
 * A manuscript that only shows its current state cannot answer the two
 * questions a writer actually asks — "what did I do to this paragraph" and
 * "put that one back" — and cannot tell an agent what moved since it last read
 * the text. Each edit is addressable, revertible on its own, and serialisable.
 */

export type EditKind = "replace" | "insert" | "remove";

export interface Edit {
  readonly id: string;
  readonly kind: EditKind;
  readonly blockId: string;
  /** Absent for an insertion. */
  readonly before?: string;
  /** Absent for a removal. */
  readonly after?: string;
  /** The original successor of a removed block, so undo restores its position. */
  readonly nextBlockId?: string;
  /** The original predecessor, used when the removal had no surviving successor. */
  readonly previousBlockId?: string;
  readonly at: string;
  /** The author's own account of why. Travels to the agent with the edit. */
  readonly note?: string;
}

const key = (block: Block): string => block.text;

/**
 * Alignment inside one region, or nothing when the region is too large.
 *
 * `undefined` is not an error: a region past the table budget is aligned as a
 * wholesale replacement, which is true and costs nothing. The previous code
 * allocated whatever the document asked for and took the application down with
 * it — a 40,000-block manuscript threw `RangeError: Out of memory` on a save,
 * however little the author had changed, because the table is built before
 * anything is compared.
 */
const commonLength = commonTable;

/**
 * Longest common subsequence over block text. Comparing by identifier would
 * report a rewritten paragraph as a removal plus an insertion, which is true of
 * the data and useless to a reader.
 */
const align = (before: readonly Block[], after: readonly Block[]): Edit[] => {
  const edits: Edit[] = [];
  const stamp = new Date().toISOString();
  const emit = (edit: Omit<Edit, "id" | "at">): void => {
    edits.push({ ...edit, id: `e${edits.length}-${edit.blockId}`, at: stamp });
  };

  // Segment first. One table over the whole manuscript is what made a long
  // book impossible to save; the diff of the whole equals the diffs of the
  // regions that differ, joined by the runs that do not.
  for (const region of segment(before, after, key)) {
    if (region.anchor) continue;
    alignRegion(region.before, region.after, emit);
  }
  return edits;
};

/**
 * Align one region, reporting each difference as an addressable edit.
 *
 * When the region is too large to table, every block in it is reported as
 * changed rather than aligned. That is a coarser answer, not a wrong one, and
 * it is reachable only on a region tens of thousands of blocks long with no
 * eight-block agreement anywhere inside it — a manuscript that was replaced,
 * not edited.
 */
const alignRegion = (
  before: readonly Block[],
  after: readonly Block[],
  emit: (edit: Omit<Edit, "id" | "at">) => void,
): void => {
  const at = commonLength(before.map(key), after.map(key));
  if (at === undefined) {
    const shared = Math.min(before.length, after.length);
    for (let k = 0; k < shared; k++) {
      const left = before[k] as Block;
      const right = after[k] as Block;
      if (left.text !== right.text)
        emit({ kind: "replace", blockId: right.id, before: left.text, after: right.text });
    }
    for (let k = shared; k < before.length; k++) {
      const left = before[k] as Block;
      const nextBlockId = before[k + 1]?.id;
      const previousBlockId = before[k - 1]?.id;
      emit({
        kind: "remove",
        blockId: left.id,
        before: left.text,
        ...(nextBlockId === undefined ? {} : { nextBlockId }),
        ...(previousBlockId === undefined ? {} : { previousBlockId }),
      });
    }
    for (let k = shared; k < after.length; k++)
      emit({ kind: "insert", blockId: (after[k] as Block).id, after: (after[k] as Block).text });
    return;
  }

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] as Block;
    const right = after[j] as Block;

    if (key(left) === key(right)) {
      i++;
      j++;
    } else if (at(i + 1, j) === at(i, j + 1)) {
      // Both sides moved: the author rewrote this block rather than adding one.
      emit({ kind: "replace", blockId: right.id, before: left.text, after: right.text });
      i++;
      j++;
    } else if (at(i + 1, j) > at(i, j + 1)) {
      const nextBlockId = before[i + 1]?.id;
      const previousBlockId = before[i - 1]?.id;
      emit({
        kind: "remove",
        blockId: left.id,
        before: left.text,
        ...(nextBlockId === undefined ? {} : { nextBlockId }),
        ...(previousBlockId === undefined ? {} : { previousBlockId }),
      });
      i++;
    } else {
      emit({ kind: "insert", blockId: right.id, after: right.text });
      j++;
    }
  }
  while (i < before.length) {
    const previousBlockId = before[i - 1]?.id;
    const left = before[i++] as Block;
    const nextBlockId = before[i]?.id;
    emit({
      kind: "remove",
      blockId: left.id,
      before: left.text,
      ...(nextBlockId === undefined ? {} : { nextBlockId }),
      ...(previousBlockId === undefined ? {} : { previousBlockId }),
    });
  }
  while (j < after.length) {
    const right = after[j++] as Block;
    emit({ kind: "insert", blockId: right.id, after: right.text });
  }
};

export const editsBetween = (before: TextHead, after: TextHead): Edit[] =>
  align(before.blocks, after.blocks);

/** One authority for where a block begins (`roundtrip.ts`), not a third copy. */
const paragraphs = (text: string): string[] => splitBlocks(text);

const inserted = (text: string): Block => ({ id: `b-${randomUUID()}`, text });

/**
 * Carry unchanged and rewritten block identities across one author action.
 *
 * Segmented for the same reason the edit log is: this ran a table over the
 * whole manuscript before comparing anything, so the cost of saving was set by
 * the length of the book rather than by the size of the change.
 */
const stableBlocks = (before: readonly Block[], text: string): Block[] => {
  const after = paragraphs(text).map((body): Block => ({ id: "", text: body }));
  const blocks: Block[] = [];

  for (const region of segment(before, after, key)) {
    if (region.anchor) {
      for (let k = 0; k < region.before.length; k++) {
        const left = region.before[k] as Block;
        blocks.push({ id: left.id, text: (region.after[k] as Block).text });
      }
      continue;
    }
    stableRegion(region.before, region.after, blocks);
  }
  return blocks;
};

/** Keep the identity of a block the author rewrote; mint one for a block they added. */
const stableRegion = (before: readonly Block[], after: readonly Block[], into: Block[]): void => {
  const at = commonLength(before.map(key), after.map(key));
  if (at === undefined) {
    // Too large to align: keep identity positionally, which is right for the
    // shape that gets here — a region replaced wholesale rather than edited.
    for (let k = 0; k < after.length; k++) {
      const left = before[k];
      const right = after[k] as Block;
      into.push(left === undefined ? inserted(right.text) : { id: left.id, text: right.text });
    }
    return;
  }

  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] as Block;
    const right = after[j] as Block;
    if (left.text === right.text || at(i + 1, j) === at(i, j + 1)) {
      into.push({ id: left.id, text: right.text });
      i++;
      j++;
    } else if (at(i + 1, j) > at(i, j + 1)) {
      i++;
    } else {
      into.push(inserted(right.text));
      j++;
    }
  }
  while (j < after.length) into.push(inserted((after[j++] as Block).text));
};

/** Advance the canonical head and record the author's addressable edits once. */
export const advanceTextHead = (
  before: TextHead,
  text: string,
  cause: string,
): { readonly head: TextHead; readonly edits: readonly Edit[] } => {
  const after: TextHead = { id: "candidate", blocks: stableBlocks(before.blocks, text), cause };
  const edits = editsBetween(before, after);

  // Each insertion needs to name the block it goes before, and asking the new
  // head to find it scans the whole manuscript once per insertion. A chapter
  // where the author added many paragraphs then cost quadratic time: measured
  // 1659 ms at 20,000 blocks and 6668 ms at 40,000.
  const positionOf = new Map(after.blocks.map((block, index) => [block.id, index] as const));

  const changes: TextChange[] = edits.map((edit) => {
    if (edit.kind === "remove") return { blockIds: [edit.blockId], text: null };
    if (edit.kind === "replace") return { blockIds: [edit.blockId], text: edit.after ?? "" };
    const index = positionOf.get(edit.blockId) ?? -1;
    const next = after.blocks[index + 1]?.id;
    return {
      kind: "insert",
      blockIds: [],
      blockId: edit.blockId,
      text: edit.after ?? "",
      ...(next === undefined ? {} : { beforeBlockId: next }),
    };
  });
  return { head: applyTextAction(before, changes, cause), edits };
};

/**
 * Undo one edit without disturbing the others.
 *
 * This is a compensating action appended to the current head, not a rewind: the
 * edits that came after it keep their effect, and the revert is itself an edit
 * that can be undone in turn.
 */
export const revertEdit = (head: TextHead, edit: Edit): TextHead => {
  if (edit.kind === "replace" && edit.before !== undefined)
    return applyTextAction(
      head,
      [{ blockIds: [edit.blockId], text: edit.before }],
      `revert(${edit.id})`,
    );

  if (edit.kind === "insert")
    return applyTextAction(head, [{ blockIds: [edit.blockId], text: null }], `revert(${edit.id})`);

  const nextIndex = head.blocks.findIndex((block) => block.id === edit.nextBlockId);
  const previousIndex = head.blocks.findIndex((block) => block.id === edit.previousBlockId);
  if (nextIndex < 0 && previousIndex < 0 && head.blocks.length > 0)
    throw new Error(`cannot restore block ${edit.blockId}: its lineage boundary is gone`);
  const beforeBlockId =
    nextIndex >= 0
      ? head.blocks[nextIndex]?.id
      : previousIndex >= 0
        ? head.blocks[previousIndex + 1]?.id
        : undefined;

  return applyTextAction(
    head,
    [
      {
        kind: "insert",
        blockIds: [],
        blockId: edit.blockId,
        text: edit.before ?? "",
        ...(beforeBlockId === undefined ? {} : { beforeBlockId }),
      },
    ],
    `revert(${edit.id})`,
  );
};

/** Undo a whole session's worth of edits, newest first so indices stay valid. */
export const revertAll = (head: TextHead, edits: readonly Edit[]): TextHead =>
  [...edits].reverse().reduce(revertEdit, head);

/**
 * What the author changed, in the form an agent reads.
 *
 * Sent alongside the next request so the agent works against the current text
 * rather than the version it last saw, and can read the author's reasoning
 * where one was given.
 */
export const describeEditsForAgent = (edits: readonly Edit[]): string => {
  if (edits.length === 0) return "";

  const body = edits.map((edit, index) => {
    const lines = [`<edit n="${index + 1}" kind="${edit.kind}">`];
    if (edit.before !== undefined) lines.push(`  <before>${cdata(edit.before)}</before>`);
    if (edit.after !== undefined) lines.push(`  <after>${cdata(edit.after)}</after>`);
    if (edit.note !== undefined) lines.push(`  <note>${xmlText(edit.note)}</note>`);
    lines.push("</edit>");
    return lines.join("\n");
  });

  return `<edits>\n${body.join("\n")}\n</edits>`;
};
