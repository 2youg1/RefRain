import { randomUUID } from "node:crypto";
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

const commonLength = (before: readonly string[], after: readonly string[]) => {
  const width = after.length + 1;
  const common = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      common[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));

  return at;
};

/**
 * Longest common subsequence over block text. Comparing by identifier would
 * report a rewritten paragraph as a removal plus an insertion, which is true of
 * the data and useless to a reader.
 */
const align = (before: readonly Block[], after: readonly Block[]): Edit[] => {
  const at = commonLength(before.map(key), after.map(key));

  const edits: Edit[] = [];
  const stamp = new Date().toISOString();
  const emit = (edit: Omit<Edit, "id" | "at">): void => {
    edits.push({ ...edit, id: `e${edits.length}-${edit.blockId}`, at: stamp });
  };

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

  return edits;
};

export const editsBetween = (before: TextHead, after: TextHead): Edit[] =>
  align(before.blocks, after.blocks);

/** One authority for where a block begins (`roundtrip.ts`), not a third copy. */
const paragraphs = (text: string): string[] => splitBlocks(text);

/** Carry unchanged and rewritten block identities across one author action. */
const stableBlocks = (before: readonly Block[], text: string): Block[] => {
  const after = paragraphs(text);
  const at = commonLength(before.map(key), after);

  const blocks: Block[] = [];
  const inserted = (text: string): Block => ({ id: `b-${randomUUID()}`, text });
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] as Block;
    const right = after[j] as string;
    if (left.text === right || at(i + 1, j) === at(i, j + 1)) {
      blocks.push({ id: left.id, text: right });
      i++;
      j++;
    } else if (at(i + 1, j) > at(i, j + 1)) {
      i++;
    } else {
      blocks.push(inserted(right));
      j++;
    }
  }
  while (j < after.length) blocks.push(inserted(after[j++] as string));
  return blocks;
};

/** Advance the canonical head and record the author's addressable edits once. */
export const advanceTextHead = (
  before: TextHead,
  text: string,
  cause: string,
): { readonly head: TextHead; readonly edits: readonly Edit[] } => {
  const after: TextHead = { id: "candidate", blocks: stableBlocks(before.blocks, text), cause };
  const edits = editsBetween(before, after);
  const changes: TextChange[] = edits.map((edit) => {
    if (edit.kind === "remove") return { blockIds: [edit.blockId], text: null };
    if (edit.kind === "replace") return { blockIds: [edit.blockId], text: edit.after ?? "" };
    const index = after.blocks.findIndex((block) => block.id === edit.blockId);
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
