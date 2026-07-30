import { BlockHeightIndex } from "./block-height-index";
import type { Block, EditorChange } from "./model";
import { applyLocally, projectionIndex } from "./projection";

const BLOCK_TAG = "p";
const VIRTUALIZE_AFTER = 400;
const WINDOW_BLOCKS = 200;
const INITIAL_BLOCK_HEIGHT = 40;
const MIN_ESTIMATE_SAMPLES = 20;

type InteractionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "composing";
      readonly blockId: string;
      readonly deferredCenter: number | null;
      readonly refreshLayout: boolean;
    };

interface FrameHandles {
  render: number | null;
  measurement: number | null;
  layout: number | null;
}

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
 * Own the complete browser projection of a manuscript.
 *
 * The interface exposes editor intents. The implementation owns every ordering
 * rule for the virtual window, measured heights, scroll anchor, focus and IME
 * pins, observers, and animation-frame cleanup. No caller coordinates those
 * facts or reads the manuscript DOM directly.
 */
export class VirtualManuscriptView {
  readonly #element: HTMLElement;
  readonly #scrollHost: HTMLElement;
  readonly #view: Window;
  readonly #submitChanges: (changes: readonly EditorChange[]) => void;
  readonly #byId = new Map<string, HTMLElement>();
  readonly #measuredHeights = new Map<string, number>();
  readonly #frames: FrameHandles = { render: null, measurement: null, layout: null };

  #blocks: Block[];
  #heightIndex: BlockHeightIndex;
  #interaction: InteractionState = { kind: "idle" };
  #bottomPinned = false;
  #destroyed = false;
  #pendingLayoutForce = false;
  #renderedSignature = "";
  #layoutKey = "";
  #measuredWidth: number;
  #resizeObserver: ResizeObserver | null = null;
  #rootObserver: MutationObserver | null = null;

  constructor(
    element: HTMLElement,
    blocks: readonly Block[],
    submitChanges: (changes: readonly EditorChange[]) => void,
  ) {
    const view = element.ownerDocument.defaultView;
    if (view === null) throw new Error("editor document has no window");
    this.#element = element;
    this.#scrollHost = element.parentElement ?? element;
    this.#view = view;
    this.#submitChanges = submitChanges;
    this.#blocks = [...blocks];
    this.#heightIndex = BlockHeightIndex.uniform(this.#blocks.length, INITIAL_BLOCK_HEIGHT);
    this.#measuredWidth = element.clientWidth;

    const ResizeObserverConstructor = view.ResizeObserver;
    if (typeof ResizeObserverConstructor === "function") {
      this.#resizeObserver = new ResizeObserverConstructor(this.#onResize);
    }
    const MutationObserverConstructor = view.MutationObserver;
    if (typeof MutationObserverConstructor === "function") {
      this.#rootObserver = new MutationObserverConstructor(this.#onRootMutation);
      this.#rootObserver.observe(element.ownerDocument.documentElement, {
        attributes: true,
        attributeFilter: ["style", "data-baseline-grid", "data-paper"],
      });
    }

    element.ownerDocument.fonts?.addEventListener("loadingdone", this.#onFontsLoaded);
    element.addEventListener("beforeinput", this.#onBeforeInput);
    element.addEventListener("input", this.#onInput);
    element.addEventListener("paste", this.#onPaste);
    element.addEventListener("compositionstart", this.#onCompositionStart);
    element.addEventListener("compositionend", this.#onCompositionEnd);
    this.#scrollHost.addEventListener("scroll", this.#onScroll, { passive: true });

    this.#render();
    this.#layoutKey = this.#currentLayoutKey();
    this.#measuredWidth = element.clientWidth;
  }

  replace(blocks: readonly Block[]): void {
    const previousBlocks = this.#blocks;
    const previousPositions = projectionIndex(previousBlocks);
    for (const block of blocks) {
      const previousIndex = previousPositions.get(block.id);
      const previous = previousIndex === undefined ? undefined : previousBlocks[previousIndex];
      if (previous?.text !== block.text) this.#measuredHeights.delete(block.id);
    }
    this.#blocks = [...blocks];
    this.#rebuildHeightIndex();
    if (this.#interaction.kind === "idle") {
      this.#renderedSignature = "";
      this.#render();
    }
  }

  focus(blockId?: string, offset?: number): void {
    this.#bottomPinned = false;
    const id = blockId ?? this.#blocks[0]?.id ?? "";
    let target = this.#byId.get(id) ?? null;
    if (target === null && blockId !== undefined) {
      const index = this.#indexOf(blockId);
      if (index >= 0) {
        this.#scrollHost.scrollTop = Math.max(
          0,
          this.#heightIndex.prefix(index) - Math.floor(this.#scrollHost.clientHeight / 3),
        );
        this.#renderedSignature = "";
        this.#render(index);
        target = this.#byId.get(blockId) ?? null;
      }
    }
    if (target === null) return;
    target.focus();
    placeCaret(target, offset ?? (target.textContent ?? "").length);
  }

  caret(): { blockId: string; offset: number } | null {
    const active = this.#element.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !this.#element.contains(active)) return null;
    const id = active.dataset.blockId;
    if (id === undefined) return null;
    const offset = caretWithin(active);
    return offset === null ? null : { blockId: id, offset };
  }

  isComposing(): boolean {
    return this.#interaction.kind === "composing";
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#element.removeEventListener("beforeinput", this.#onBeforeInput);
    this.#element.removeEventListener("input", this.#onInput);
    this.#element.removeEventListener("paste", this.#onPaste);
    this.#element.removeEventListener("compositionstart", this.#onCompositionStart);
    this.#element.removeEventListener("compositionend", this.#onCompositionEnd);
    this.#scrollHost.removeEventListener("scroll", this.#onScroll);
    this.#element.ownerDocument.fonts?.removeEventListener("loadingdone", this.#onFontsLoaded);
    this.#resizeObserver?.disconnect();
    this.#rootObserver?.disconnect();
    for (const frame of Object.values(this.#frames)) {
      if (frame !== null) this.#view.cancelAnimationFrame(frame);
    }
    this.#element.textContent = "";
    this.#byId.clear();
    this.#measuredHeights.clear();
  }

  #paragraphFor(block: Block): HTMLElement {
    const existing = this.#byId.get(block.id);
    if (existing !== undefined) return existing;
    const paragraph = this.#element.ownerDocument.createElement(BLOCK_TAG);
    paragraph.dataset.blockId = block.id;
    paragraph.contentEditable = "true";
    paragraph.textContent = block.text;
    paragraph.style.minHeight = "1em";
    paragraph.style.whiteSpace = "pre-wrap";
    paragraph.style.outline = "none";
    return paragraph;
  }

  #paragraphFrom(target: EventTarget | null): HTMLElement | null {
    return (target as HTMLElement | null)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
  }

  #indexOf(id: string): number {
    return projectionIndex(this.#blocks).get(id) ?? -1;
  }

  #known(id: string): Block | undefined {
    const index = this.#indexOf(id);
    return index === -1 ? undefined : this.#blocks[index];
  }

  #isBottomAnchored(): boolean {
    return (
      this.#scrollHost.scrollHeight - this.#scrollHost.clientHeight - this.#scrollHost.scrollTop <=
      2
    );
  }

  #readOuterHeight(paragraph: HTMLElement): number {
    const boxHeight = paragraph.offsetHeight;
    if (boxHeight <= 0) return 0;
    const style = this.#view.getComputedStyle(paragraph);
    const marginTop = Number.parseFloat(style.marginTop) || 0;
    const marginBottom = Number.parseFloat(style.marginBottom) || 0;
    return Math.ceil(Math.max(1, boxHeight + marginTop + marginBottom));
  }

  #currentLayoutKey(): string {
    const style = this.#view.getComputedStyle(this.#element);
    const paragraph = this.#byId.values().next().value;
    const paragraphStyle = paragraph === undefined ? style : this.#view.getComputedStyle(paragraph);
    return [
      Math.round(this.#element.clientWidth),
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.lineHeight,
      style.letterSpacing,
      style.wordSpacing,
      style.textAlign,
      paragraphStyle.marginTop,
      paragraphStyle.marginBottom,
      paragraphStyle.paddingBottom,
      paragraphStyle.borderBottomWidth,
    ].join("\u0000");
  }

  #currentBlockEstimate(): number {
    const style = this.#view.getComputedStyle(this.#element);
    const paragraph = this.#byId.values().next().value;
    const paragraphStyle = paragraph === undefined ? style : this.#view.getComputedStyle(paragraph);
    const fontSize = Number.parseFloat(style.fontSize) || 17;
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.6;
    const marginTop = Number.parseFloat(paragraphStyle.marginTop) || 0;
    const marginBottom = Number.parseFloat(paragraphStyle.marginBottom) || 0;
    return Math.ceil(Math.max(1, lineHeight + marginTop + marginBottom));
  }

  #rebuildHeightIndex(): void {
    const rebuilt = BlockHeightIndex.uniform(this.#blocks.length, this.#heightIndex.estimate);
    const positions = projectionIndex(this.#blocks);
    for (const [id, height] of this.#measuredHeights) {
      const index = positions.get(id);
      if (index === undefined) this.#measuredHeights.delete(id);
      else rebuilt.update(index, height);
    }
    this.#heightIndex = rebuilt;
  }

  #observeLiveParagraphs(): void {
    if (this.#resizeObserver === null) return;
    this.#resizeObserver.disconnect();
    this.#resizeObserver.observe(this.#element);
    for (const paragraph of this.#byId.values()) this.#resizeObserver.observe(paragraph);
  }

  #scheduleRender(): void {
    if (this.#destroyed || this.#frames.render !== null) return;
    this.#frames.render = this.#view.requestAnimationFrame(() => {
      this.#frames.render = null;
      if (!this.#destroyed && this.#interaction.kind === "idle") this.#render();
    });
  }

  #scheduleMeasurement(): void {
    if (
      this.#destroyed ||
      this.#interaction.kind === "composing" ||
      this.#frames.measurement !== null
    ) {
      return;
    }
    this.#frames.measurement = this.#view.requestAnimationFrame(() => {
      this.#frames.measurement = null;
      this.#measureLiveParagraphs();
    });
  }

  #render(center?: number): void {
    const active = this.#element.ownerDocument.activeElement;
    const activeParagraph =
      active instanceof HTMLElement && this.#element.contains(active) ? active : null;
    const activeOffset = activeParagraph === null ? null : caretWithin(activeParagraph);
    const composingId = this.#interaction.kind === "composing" ? this.#interaction.blockId : null;
    const pinnedId = composingId ?? activeParagraph?.dataset.blockId ?? null;
    const virtual = this.#blocks.length > VIRTUALIZE_AFTER;
    const scrollIndex = this.#heightIndex.atOffset(this.#scrollHost.scrollTop);
    const focusIndex = center ?? Math.max(0, scrollIndex);
    const visibleStart = virtual
      ? Math.max(
          0,
          Math.min(this.#blocks.length - WINDOW_BLOCKS, focusIndex - Math.floor(WINDOW_BLOCKS / 4)),
        )
      : 0;
    const visibleEnd = virtual
      ? Math.min(this.#blocks.length, visibleStart + WINDOW_BLOCKS)
      : this.#blocks.length;
    const activeIndex = pinnedId === null ? -1 : this.#indexOf(pinnedId);
    const pinnedIndex =
      activeIndex >= 0 && (activeIndex < visibleStart || activeIndex >= visibleEnd)
        ? activeIndex
        : -1;
    const shown = new Set<number>();
    for (let index = visibleStart; index < visibleEnd; index += 1) shown.add(index);
    if (pinnedIndex >= 0) shown.add(pinnedIndex);
    const indices = [...shown].sort((left, right) => left - right);
    const signature = `${this.#blocks.length}:${visibleStart}:${visibleEnd}:${pinnedIndex}`;
    if (signature === this.#renderedSignature) return;
    this.#renderedSignature = signature;

    const previous = new Map(this.#byId);
    this.#byId.clear();
    const fragment = this.#element.ownerDocument.createDocumentFragment();
    const appendSpacer = (start: number, end: number): void => {
      if (end <= start) return;
      const spacer = this.#element.ownerDocument.createElement("div");
      spacer.dataset.editorSpacer = "";
      spacer.style.height = `${this.#heightIndex.span(start, end)}px`;
      spacer.style.pointerEvents = "none";
      spacer.setAttribute("aria-hidden", "true");
      fragment.append(spacer);
    };

    if (this.#blocks.length === 0) {
      const seed = previous.get("") ?? this.#paragraphFor({ id: "", text: "" });
      this.#byId.set("", seed);
      fragment.append(seed);
    } else {
      let cursor = 0;
      for (const index of indices) {
        appendSpacer(cursor, index);
        const block = this.#blocks[index];
        if (block === undefined) continue;
        const paragraph = previous.get(block.id) ?? this.#paragraphFor(block);
        if (paragraph !== active && paragraph.textContent !== block.text) {
          paragraph.textContent = block.text;
        }
        this.#byId.set(block.id, paragraph);
        fragment.append(paragraph);
        cursor = index + 1;
      }
      appendSpacer(cursor, this.#blocks.length);
    }
    this.#element.replaceChildren(fragment);
    if (pinnedId !== null && activeOffset !== null) {
      const restored = this.#byId.get(pinnedId);
      if (restored !== undefined) {
        restored.focus({ preventScroll: true });
        placeCaret(restored, activeOffset);
      }
    }
    this.#observeLiveParagraphs();
    this.#scheduleMeasurement();
  }

  #resetLayout(force: boolean): void {
    if (this.#interaction.kind === "composing") {
      this.#interaction = {
        ...this.#interaction,
        refreshLayout: this.#interaction.refreshLayout || force,
      };
      return;
    }
    const nextKey = this.#currentLayoutKey();
    if (!force && nextKey === this.#layoutKey) return;
    const pinnedToBottom = this.#bottomPinned || this.#isBottomAnchored();
    const anchor = this.#heightIndex.atOffset(this.#scrollHost.scrollTop);
    const withinAnchor =
      anchor < 0 ? 0 : Math.max(0, this.#scrollHost.scrollTop - this.#heightIndex.prefix(anchor));
    this.#layoutKey = nextKey;
    this.#measuredHeights.clear();
    this.#heightIndex = BlockHeightIndex.uniform(this.#blocks.length, this.#currentBlockEstimate());
    if (pinnedToBottom) {
      this.#bottomPinned = true;
      this.#scrollHost.scrollTop = this.#heightIndex.total;
    } else if (anchor >= 0) {
      this.#scrollHost.scrollTop =
        this.#heightIndex.prefix(anchor) + Math.min(withinAnchor, this.#heightIndex.estimate - 1);
    }
    this.#renderedSignature = "";
    this.#render(
      pinnedToBottom && this.#blocks.length > 0
        ? this.#blocks.length - 1
        : anchor < 0
          ? undefined
          : anchor,
    );
  }

  #scheduleLayoutRefresh(force = false): void {
    if (this.#destroyed) return;
    this.#pendingLayoutForce ||= force;
    if (this.#frames.layout !== null) return;
    this.#frames.layout = this.#view.requestAnimationFrame(() => {
      this.#frames.layout = null;
      const forced = this.#pendingLayoutForce;
      this.#pendingLayoutForce = false;
      this.#resetLayout(forced);
    });
  }

  #measureLiveParagraphs(): void {
    if (this.#destroyed || this.#interaction.kind === "composing") return;
    const pinnedToBottom = this.#bottomPinned || this.#isBottomAnchored();
    const anchor = this.#heightIndex.atOffset(this.#scrollHost.scrollTop);
    const withinAnchor =
      anchor < 0 ? 0 : Math.max(0, this.#scrollHost.scrollTop - this.#heightIndex.prefix(anchor));
    let changed = false;
    for (const [id, paragraph] of this.#byId) {
      const index = this.#indexOf(id);
      const height = this.#readOuterHeight(paragraph);
      const previous = this.#measuredHeights.get(id);
      if (
        index < 0 ||
        height <= 0 ||
        (previous !== undefined && Math.abs(previous - height) <= 1)
      ) {
        continue;
      }
      this.#measuredHeights.set(id, height);
      this.#heightIndex.update(index, height);
      changed = true;
    }
    if (!changed) return;
    const average = this.#heightIndex.measuredAverage;
    if (this.#measuredHeights.size >= MIN_ESTIMATE_SAMPLES && average !== null) {
      this.#heightIndex.setEstimate(Math.max(8, Math.min(4096, average)));
    }
    const renderCenter =
      pinnedToBottom && this.#blocks.length > 0 ? this.#blocks.length - 1 : undefined;
    if (pinnedToBottom) {
      this.#scrollHost.scrollTop = this.#heightIndex.total;
    } else if (anchor >= 0) {
      this.#scrollHost.scrollTop =
        this.#heightIndex.prefix(anchor) + Math.min(withinAnchor, this.#heightIndex.estimate - 1);
    }
    this.#renderedSignature = "";
    this.#render(renderCenter);
  }

  #submit(changes: readonly EditorChange[]): void {
    if (this.#destroyed || changes.length === 0) return;
    this.#submitChanges(changes);
    let structural = false;
    for (const change of changes) {
      if (change.kind === "insert") {
        structural = true;
        continue;
      }
      if (change.text === null || change.blocks.length > 1) structural = true;
      for (const id of change.blocks) {
        const index = this.#indexOf(id);
        this.#measuredHeights.delete(id);
        this.#heightIndex.invalidate(index);
      }
    }
    this.#blocks = applyLocally(this.#blocks, changes);
    if (structural) this.#rebuildHeightIndex();
  }

  #settleBlock(id: string): void {
    const paragraph = this.#byId.get(id);
    if (paragraph === undefined) return;
    if (id === "") {
      const seed = paragraph.textContent ?? "";
      if (seed === "") return;
      this.#submit([{ kind: "insert", before: null, texts: [seed] }]);
      const minted = this.#blocks.at(-1);
      if (minted !== undefined) {
        paragraph.dataset.blockId = minted.id;
        this.#byId.delete("");
        this.#byId.set(minted.id, paragraph);
      }
      return;
    }
    const block = this.#known(id);
    if (block === undefined) return;
    const current = paragraph.textContent ?? "";
    if (current === block.text) return;
    this.#submit([{ kind: "replace", blocks: [id], text: current === "" ? null : current }]);
  }

  #splitAtCaret(paragraph: HTMLElement, id: string): void {
    const offset = caretWithin(paragraph);
    if (offset === null) return;
    const text = paragraph.textContent ?? "";
    const head = text.slice(0, offset);
    const tail = text.slice(offset);
    const index = this.#indexOf(id);
    const after = this.#blocks[index + 1]?.id ?? null;
    this.#submit([
      { kind: "replace", blocks: [id], text: head === "" ? null : head },
      { kind: "insert", before: after, texts: [tail === "" ? " " : tail] },
    ]);
  }

  #mergeWithPrevious(paragraph: HTMLElement, id: string): void {
    const offset = caretWithin(paragraph);
    if (offset !== 0) return;
    const index = this.#indexOf(id);
    const previous = this.#blocks[index - 1];
    if (previous === undefined) return;
    const text = paragraph.textContent ?? "";
    this.#submit([
      { kind: "replace", blocks: [previous.id], text: previous.text + text },
      { kind: "replace", blocks: [id], text: null },
    ]);
  }

  readonly #onBeforeInput = (event: InputEvent): void => {
    if (this.#interaction.kind === "composing") return;
    const paragraph = this.#paragraphFrom(event.target);
    if (paragraph === null) return;
    const id = paragraph.dataset.blockId ?? "";
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      this.#splitAtCaret(paragraph, id);
    } else if (event.inputType === "deleteContentBackward" && caretWithin(paragraph) === 0) {
      event.preventDefault();
      this.#mergeWithPrevious(paragraph, id);
    }
  };

  readonly #onPaste = (event: ClipboardEvent): void => {
    const paragraph = this.#paragraphFrom(event.target);
    if (paragraph === null || this.#interaction.kind === "composing") return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!/\n\s*\n/.test(text)) return;
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
    const index = this.#indexOf(id);
    const after = this.#blocks[index + 1]?.id ?? null;
    const headBlock = headText + first;
    const texts = tailText === "" ? rest : [...rest, tailText];
    const changes: EditorChange[] = [
      { kind: "replace", blocks: [id], text: headBlock === "" ? null : headBlock },
    ];
    if (texts.length > 0) changes.push({ kind: "insert", before: after, texts });
    this.#submit(changes);
  };

  readonly #onInput = (event: Event): void => {
    if (this.#interaction.kind === "composing") return;
    const paragraph = this.#paragraphFrom(event.target);
    if (paragraph !== null) this.#settleBlock(paragraph.dataset.blockId ?? "");
  };

  readonly #onCompositionStart = (event: CompositionEvent): void => {
    const paragraph = this.#paragraphFrom(event.target);
    this.#interaction = {
      kind: "composing",
      blockId: paragraph?.dataset.blockId ?? "",
      deferredCenter: null,
      refreshLayout: false,
    };
  };

  readonly #onCompositionEnd = (event: CompositionEvent): void => {
    const paragraph = this.#paragraphFrom(event.target);
    const id = paragraph?.dataset.blockId ?? null;
    const completed = this.#interaction;
    this.#interaction = { kind: "idle" };
    if (id !== null) this.#settleBlock(id);
    const deferredCenter = completed.kind === "composing" ? completed.deferredCenter : null;
    this.#bottomPinned =
      this.#blocks.length > 0 &&
      (this.#bottomPinned ||
        this.#isBottomAnchored() ||
        deferredCenter === this.#blocks.length - 1);
    this.#renderedSignature = "";
    this.#render(this.#bottomPinned ? this.#blocks.length - 1 : (deferredCenter ?? undefined));
    if (completed.kind === "composing" && completed.refreshLayout) {
      this.#scheduleLayoutRefresh(true);
    }
  };

  readonly #onScroll = (): void => {
    if (this.#destroyed || this.#blocks.length <= VIRTUALIZE_AFTER) return;
    this.#bottomPinned = this.#isBottomAnchored();
    if (this.#interaction.kind === "composing") {
      this.#interaction = {
        ...this.#interaction,
        deferredCenter: this.#bottomPinned
          ? this.#blocks.length - 1
          : Math.max(0, this.#heightIndex.atOffset(this.#scrollHost.scrollTop)),
      };
      return;
    }
    this.#scheduleRender();
  };

  readonly #onResize = (entries: ResizeObserverEntry[]): void => {
    let widthChanged = false;
    let paragraphChanged = false;
    for (const entry of entries) {
      if (entry.target === this.#element) {
        const width = entry.contentRect.width;
        if (this.#measuredWidth > 0 && Math.abs(width - this.#measuredWidth) > 1) {
          widthChanged = true;
        }
        this.#measuredWidth = width;
      } else {
        paragraphChanged = true;
      }
    }
    if (widthChanged) this.#scheduleLayoutRefresh();
    else if (paragraphChanged) this.#scheduleMeasurement();
  };

  readonly #onFontsLoaded = (): void => this.#scheduleLayoutRefresh(true);
  readonly #onRootMutation = (): void => this.#scheduleLayoutRefresh();
}
