/**
 * The direct DOM adapter (M7).
 *
 * Framework-free: no Vue, no generated Tauri binding (SPEC 6.2). It is the only
 * module that touches manuscript DOM, and the only path from settled editor
 * input to the domain is an EditorAction (SPEC 7.2). Block boundaries arrive
 * from the byte-authoritative `SourceLayout` through the host; this package
 * never re-parses Markdown (C1).
 *
 * IME discipline (INV-7): during a composition the adapter reads nothing,
 * submits nothing, and replaces no node. A save requested mid-composition is
 * deferred to `compositionend` by the host, not by reaching into the DOM.
 */

/** A block as the domain hands it over: an opaque id and its text. */
export interface Block {
  readonly id: string;
  readonly text: string;
}

/** The document the adapter projects: a revision and its blocks. */
export interface EditorDocument {
  readonly revision: string;
  readonly blocks: readonly Block[];
}

/**
 * One independently locatable change (SPEC 7.2). The id survives a replacement
 * (SPEC 7.3); minting a new one here detaches every queued Proposal,
 * compensating undo, and decoration anchor at once.
 */
export type EditorChange =
  | { readonly kind: "replace"; readonly blocks: readonly string[]; readonly text: string | null }
  | { readonly kind: "insert"; readonly before: string | null; readonly texts: readonly string[] };

/** The sole text path from the editor to the domain. */
export interface EditorAction {
  readonly baseRevision: string;
  readonly changes: readonly EditorChange[];
}

/** The injected cross-layer callback: the only way text leaves the editor. */
export interface EditorPort {
  /** Called with every settled action. The host confirms asynchronously. */
  readonly submit: (action: EditorAction) => void;
}

export interface EditorHandle {
  /** Move the base the adapter diffs against (after the domain confirms). */
  setRevision(revision: string): void;
  /** Project a different document, e.g. after a switch or an external change. */
  replace(document: EditorDocument): void;
  /** Put the caret in a block, at an optional character offset. */
  focus(blockId?: string, offset?: number): void;
  /** Where the caret is: block id and character offset, or null outside. */
  caret(): { blockId: string; offset: number } | null;
  /** INV-7: while a composition is open its text is not text — the host
   * defers saves and never asks for a read in this state. */
  isComposing(): boolean;
  destroy(): void;
}

const BLOCK_TAG = "p";

// The adapter owns this projection array for its whole lifetime. Index it by
// identity so ordinary settled input never scans or copies a 100,000-block
// document. Structural edits repair only the suffix whose positions moved.
const projectionIndexes = new WeakMap<Block[], Map<string, number>>();
const projectionPlaceholders = new WeakMap<Block[], number>();

function projectionIndex(blocks: Block[]): Map<string, number> {
  const current = projectionIndexes.get(blocks);
  if (current !== undefined) return current;
  const built = new Map(blocks.map((block, index) => [block.id, index]));
  projectionIndexes.set(blocks, built);
  return built;
}

function reindexProjection(blocks: Block[], from: number): void {
  const at = projectionIndex(blocks);
  for (let index = from; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block !== undefined) at.set(block.id, index);
  }
}

function nextPlaceholder(blocks: Block[]): string {
  const next = (projectionPlaceholders.get(blocks) ?? 0) + 1;
  projectionPlaceholders.set(blocks, next);
  return `pending-${next}`;
}

/**
 * The caret's character offset inside a block element, or null when the
 * selection is elsewhere. Measured through a Range so markup the browser
 * added (a <br>, a pasted <div>) does not skew the count.
 */
function caretWithin(block: HTMLElement): number | null {
  const selection = block.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer)) return null;
  const probe = range.cloneRange();
  probe.selectNodeContents(block);
  probe.setEnd(range.startContainer, range.startOffset);
  return probe.toString().length;
}

function placeCaret(block: HTMLElement, offset: number): void {
  const selection = block.ownerDocument.getSelection();
  if (!selection) return;
  const range = block.ownerDocument.createRange();
  // The text may be split across child nodes; walk to the right one.
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  let last: Node | null = null;
  while (node) {
    const length = (node.textContent ?? "").length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    last = node;
    node = walker.nextNode();
  }
  range.selectNodeContents(block);
  range.collapse(false);
  if (last === null) range.setStart(block, 0);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Mount the adapter. The element becomes one editable paragraph per block;
 * every settled change leaves through `port.submit` as one EditorAction.
 */
export function mountEditor(
  element: HTMLElement,
  document: EditorDocument,
  port: EditorPort,
): EditorHandle {
  let revision = document.revision;
  let blocks: Block[] = [...document.blocks];
  let composing: string | null = null;
  let destroyed = false;

  const byId = new Map<string, HTMLElement>();

  const render = (next: readonly Block[]): void => {
    element.textContent = "";
    byId.clear();
    // An empty document still needs somewhere to put the caret: one seed
    // paragraph whose first settled text becomes an insert action.
    const shown = next.length === 0 ? [{ id: "", text: "" }] : next;
    for (const block of shown) {
      const paragraph = element.ownerDocument.createElement(BLOCK_TAG);
      paragraph.dataset.blockId = block.id;
      paragraph.contentEditable = "true";
      paragraph.textContent = block.text;
      // A block that renders empty collapses to zero height; the author must
      // still be able to click into it.
      paragraph.style.minHeight = "1em";
      paragraph.style.whiteSpace = "pre-wrap";
      paragraph.style.outline = "none";
      element.append(paragraph);
      byId.set(block.id, paragraph);
    }
  };

  const indexOf = (id: string): number => projectionIndex(blocks).get(id) ?? -1;
  const known = (id: string): Block | undefined => {
    const index = indexOf(id);
    return index === -1 ? undefined : blocks[index];
  };

  const submit = (changes: readonly EditorChange[]): void => {
    if (destroyed || changes.length === 0) return;
    port.submit({ baseRevision: revision, changes });
    // The projection updates immediately — the adapter owns the live DOM — but
    // `revision` only moves when the host confirms (SPEC 7.2-4).
    blocks = applyLocally(blocks, changes);
  };

  const settleBlock = (id: string): void => {
    const paragraph = byId.get(id);
    if (!paragraph) return;
    if (id === "") {
      // The seed paragraph of an empty document: its text is an insertion,
      // not a replacement — there is no block to replace yet.
      const seed = paragraph.textContent ?? "";
      if (seed === "") return;
      submit([{ kind: "insert", before: null, texts: [seed] }]);
      const minted = blocks.at(-1);
      if (minted !== undefined) {
        paragraph.dataset.blockId = minted.id;
        byId.delete("");
        byId.set(minted.id, paragraph);
      }
      return;
    }
    const block = known(id);
    if (!block) return;
    const current = paragraph.textContent ?? "";
    if (current === block.text) return;
    submit([{ kind: "replace", blocks: [id], text: current === "" ? null : current }]);
  };

  const splitAtCaret = (paragraph: HTMLElement, id: string): void => {
    const offset = caretWithin(paragraph);
    if (offset === null) return;
    const text = paragraph.textContent ?? "";
    const head = text.slice(0, offset);
    const tail = text.slice(offset);
    const index = indexOf(id);
    const after = blocks[index + 1]?.id ?? null;
    // Structural changes re-render from the confirmed document (the domain
    // mints the new block's id); the host restores the caret from there.
    submit([
      { kind: "replace", blocks: [id], text: head === "" ? null : head },
      { kind: "insert", before: after, texts: [tail === "" ? " " : tail] },
    ]);
  };

  const mergeWithPrevious = (paragraph: HTMLElement, id: string): void => {
    const offset = caretWithin(paragraph);
    if (offset !== 0) return;
    const index = indexOf(id);
    const previous = blocks[index - 1];
    if (!previous) return;
    const text = paragraph.textContent ?? "";
    submit([
      { kind: "replace", blocks: [previous.id], text: previous.text + text },
      { kind: "replace", blocks: [id], text: null },
    ]);
  };

  const onBeforeInput = (event: InputEvent): void => {
    if (composing !== null) return;
    const paragraph = (event.target as HTMLElement)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
    if (!paragraph) return;
    const id = paragraph.dataset.blockId ?? "";
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      splitAtCaret(paragraph, id);
    } else if (event.inputType === "deleteContentBackward") {
      const offset = caretWithin(paragraph);
      if (offset === 0) {
        event.preventDefault();
        mergeWithPrevious(paragraph, id);
      }
    }
  };

  const onPaste = (event: ClipboardEvent): void => {
    const paragraph = (event.target as HTMLElement)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
    if (!paragraph || composing !== null) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!/\n\s*\n/.test(text)) return; // Single-block paste: native path, settle on input.
    event.preventDefault();
    const id = paragraph.dataset.blockId ?? "";
    const offset = caretWithin(paragraph) ?? (paragraph.textContent ?? "").length;
    const current = paragraph.textContent ?? "";
    const headText = current.slice(0, offset);
    const tailText = current.slice(offset);
    const pasted = text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (pasted.length === 0) return;
    const [first, ...rest] = pasted as [string, ...string[]];
    const index = indexOf(id);
    const after = blocks[index + 1]?.id ?? null;
    const headBlock = headText + first;
    const texts = tailText === "" ? rest : [...rest, tailText];
    const changes: EditorChange[] = [
      { kind: "replace", blocks: [id], text: headBlock === "" ? null : headBlock },
    ];
    if (texts.length > 0) changes.push({ kind: "insert", before: after, texts });
    submit(changes);
  };

  const onInput = (event: Event): void => {
    if (composing !== null) return;
    const paragraph = (event.target as HTMLElement)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
    if (!paragraph) return;
    settleBlock(paragraph.dataset.blockId ?? "");
  };

  const onCompositionStart = (event: CompositionEvent): void => {
    const paragraph = (event.target as HTMLElement)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
    composing = paragraph?.dataset.blockId ?? "";
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    const paragraph = (event.target as HTMLElement)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
    const id = paragraph?.dataset.blockId ?? null;
    composing = null;
    // The candidate became text exactly now (INV-7): this is the first moment
    // reading it is allowed, and it is the moment the settle happens.
    if (id !== null) settleBlock(id);
  };

  element.addEventListener("beforeinput", onBeforeInput);
  element.addEventListener("input", onInput);
  element.addEventListener("paste", onPaste);
  element.addEventListener("compositionstart", onCompositionStart);
  element.addEventListener("compositionend", onCompositionEnd);

  render(blocks);

  const handle: EditorHandle = {
    setRevision(next) {
      revision = next;
    },
    replace(document) {
      revision = document.revision;
      blocks = [...document.blocks];
      // Never rebuild a node mid-composition (INV-7); an external replace
      // while composing waits for the composition to end.
      if (composing === null) render(blocks);
    },
    focus(blockId, offset) {
      const target =
        (blockId !== undefined ? byId.get(blockId) : byId.get(blocks[0]?.id ?? "")) ?? null;
      if (!target) return;
      target.focus();
      placeCaret(target, offset ?? (target.textContent ?? "").length);
    },
    isComposing() {
      return composing !== null;
    },
    caret() {
      for (const [id, paragraph] of byId) {
        const offset = caretWithin(paragraph);
        if (offset !== null) return { blockId: id, offset };
      }
      return null;
    },
    destroy() {
      destroyed = true;
      element.removeEventListener("beforeinput", onBeforeInput);
      element.removeEventListener("input", onInput);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("compositionstart", onCompositionStart);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.textContent = "";
      byId.clear();
    },
  };
  return handle;
}

/** Mirror the changes onto the local projection (ids for insertions are
 * placeholders until the domain's confirmed document arrives). */
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
      reindexProjection(blocks, start);
    } else {
      const index = change.before === null ? blocks.length : (at.get(change.before) ?? -1);
      const insertAt = index === -1 ? blocks.length : index;
      const inserted = change.texts.map((text) => ({
        id: nextPlaceholder(blocks),
        text,
      }));
      blocks.splice(insertAt, 0, ...inserted);
      reindexProjection(blocks, insertAt);
    }
  }
  return blocks;
}

/** Preserves block identity across a replacement (SPEC 7.3). */
export function replaceText(block: Block, text: string): EditorChange {
  return { kind: "replace", blocks: [block.id], text };
}
