import { BlockHeightIndex } from "./block-height-index";
import { applyInlineMark } from "./inline-mark";
import type {
  Block,
  EditorAnnotationProjection,
  EditorChange,
  EditorContext,
  EditorFormat,
  PunctuationFinding,
} from "./model";
import { applyLocally, projectionIndex } from "./projection";
import { applyPunctuationFinding, findPunctuation } from "./punctuation";

const BLOCK_TAG = "p";

/** 一个只占高度、不接事件、读屏器看不见的填充块。 */
const makeSpacer = (document_: Document): HTMLElement => {
  const spacer = document_.createElement("div");
  spacer.dataset.editorSpacer = "";
  spacer.style.pointerEvents = "none";
  spacer.setAttribute("aria-hidden", "true");
  return spacer;
};
const VIRTUALIZE_AFTER = 400;
/**
 * 窗口覆盖几屏。
 *
 * 一屏之外前后各留一屏：作者往任一方向滚一整屏之内，要读的块都已经在 DOM 里。
 * 更大的倍数只是提前做了迟早要做的工作，而每一帧都要为它付出代价。
 */
const WINDOW_SCREENS = 3;
/**
 * 窗口的块数下限与上限。
 *
 * 下限挡住「容器还没量出高度」那一帧（clientHeight 为 0 时窗口会算成空，作者看到
 * 一片空白）；上限挡住极端小字号下窗口膨胀到几百块，那时每帧的渲染成本会盖过
 * 虚拟化本身省下的。实测一屏的块数在 14（40px 字）到 62（9px 字）之间，
 * 乘三屏即 42 到 186——两端都在这个区间里。
 */
const MIN_WINDOW_BLOCKS = 60;
const MAX_WINDOW_BLOCKS = 400;
/**
 * 判断「已经在结尾」时允许的估算误差，按块数计。
 *
 * 它描述的是高度索引的误差，不是窗口大小——两者曾经共用一个常数，于是窗口改成
 * 自适应之后容差跟着缩到不足三分之一，滚到底会停在半途（实测 10 万块时停在
 * 3,594,067 / 7,168,082）。误差本身与窗口多大无关：未测量的块各贡献一个估计值，
 * 浏览器按近似的 scrollHeight 夹住滚动位置，下一次测量再把总高修正回来。
 * 10 万块时实测的落差是 4,138px，200 块的估算量足以覆盖它。
 */
const BOTTOM_DEADBAND_BLOCKS = 200;
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

interface ContextSelection {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly sourceText: string;
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

function selectionWithin(block: HTMLElement): {
  readonly start: number;
  readonly end: number;
  readonly anchor: EditorContext["anchor"];
} | null {
  const selection = block.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer) || !block.contains(range.endContainer)) return null;
  const beforeStart = range.cloneRange();
  beforeStart.selectNodeContents(block);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = range.cloneRange();
  beforeEnd.selectNodeContents(block);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const start = beforeStart.toString().length;
  const end = beforeEnd.toString().length;
  if (start >= end) return null;
  const rectangle = range.getBoundingClientRect();
  return {
    start,
    end,
    anchor: {
      left: rectangle.left,
      top: rectangle.top,
      right: rectangle.right,
      bottom: rectangle.bottom,
    },
  };
}

function anchorOf(element: HTMLElement): EditorContext["anchor"] {
  const rectangle = element.getBoundingClientRect();
  return {
    left: rectangle.left,
    top: rectangle.top,
    right: rectangle.right,
    bottom: rectangle.bottom,
  };
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
  /**
   * 撑起未渲染区域的填充块，按需复用。
   *
   * 绝大多数帧只需要两个（窗口前、窗口后）；作者正在输入的块滚出窗口时需要第三个。
   * 池只增不减：数量上限就是这几个，留着比每帧新建便宜。
   */
  readonly #spacers: HTMLElement[] = [];
  readonly #view: Window;
  readonly #submitChanges: (changes: readonly EditorChange[]) => void;
  readonly #byId = new Map<string, HTMLElement>();
  readonly #measuredHeights = new Map<string, number>();
  readonly #frames: FrameHandles = { render: null, measurement: null, layout: null };

  #annotations: readonly EditorAnnotationProjection[] = [];
  #blocks: Block[];
  #heightIndex: BlockHeightIndex;
  #contextBlock: { readonly blockId: string; readonly sourceText: string } | null = null;
  #settledWaiters: (() => void)[] = [];
  #contextSelection: ContextSelection | null = null;
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
    // One editing host for the whole manuscript (see #paragraphFor).
    element.contentEditable = "true";
    element.style.outline = "none";
    element.spellcheck = false;

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
    this.#contextBlock = null;
    this.#contextSelection = null;
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
    // The host takes focus; the caret says which paragraph. Focusing must not
    // scroll: the host spans the whole manuscript, so letting the browser bring
    // it into view would undo the scroll position just computed above.
    this.#element.focus({ preventScroll: true });
    placeCaret(target, offset ?? (target.textContent ?? "").length);
  }

  caret(): { blockId: string; offset: number } | null {
    const active = this.#element.ownerDocument.activeElement;
    // The host is what holds focus now, so the caret — not activeElement —
    // is what identifies the block.
    if (active !== this.#element && !this.#element.contains(active)) return null;
    const paragraph = this.#paragraphAtCaret();
    const id = paragraph?.dataset.blockId;
    if (id === undefined) return null;
    const offset = caretWithin(paragraph as HTMLElement);
    return offset === null ? null : { blockId: id, offset };
  }

  context(target: EventTarget | null): EditorContext | null {
    const paragraph = this.#paragraphFrom(target);
    if (paragraph === null) return null;
    const blockId = paragraph.dataset.blockId;
    if (blockId === undefined) return null;
    const block = this.#known(blockId);
    if (block === undefined) return null;
    this.#contextBlock = { blockId, sourceText: block.text };
    this.#contextSelection = null;
    const canDeleteEmpty = this.#blocks.length > 1 && block.text.trim() === "";
    const punctuation = findPunctuation(blockId, block.text);
    if (this.#interaction.kind === "composing") {
      return {
        blockId,
        canFormat: false,
        canDeleteEmpty: false,
        selection: null,
        punctuation: [],
        anchor: anchorOf(paragraph),
      };
    }
    const selected = selectionWithin(paragraph);
    if (selected === null || selected.end > block.text.length) {
      return {
        blockId,
        canFormat: false,
        canDeleteEmpty,
        selection: null,
        punctuation,
        anchor: anchorOf(paragraph),
      };
    }
    this.#contextSelection = {
      blockId,
      start: selected.start,
      end: selected.end,
      sourceText: block.text,
    };
    return {
      blockId,
      canFormat: true,
      canDeleteEmpty,
      selection: {
        start: selected.start,
        end: selected.end,
        quote: block.text.slice(selected.start, selected.end),
      },
      punctuation,
      anchor: selected.anchor,
    };
  }

  formatSelection(kind: EditorFormat): boolean {
    const selection = this.#contextSelection;
    if (selection === null || this.#interaction.kind === "composing") return false;
    const block = this.#known(selection.blockId);
    if (block === undefined || block.text !== selection.sourceText) return false;
    const edit = applyInlineMark(block.text, selection.start, selection.end, kind);
    if (edit === null) return false;
    this.#contextBlock = null;
    this.#contextSelection = null;
    this.#submit([{ kind: "replace", blocks: [block.id], text: edit.text }]);
    const paragraph = this.#byId.get(block.id);
    if (paragraph !== undefined) {
      paragraph.textContent = edit.text;
      paragraph.focus({ preventScroll: true });
      placeCaret(paragraph, edit.end);
    }
    return true;
  }

  deleteEmptyBlock(): boolean {
    const captured = this.#contextBlock;
    if (captured === null || this.#interaction.kind === "composing" || this.#blocks.length <= 1) {
      return false;
    }
    const block = this.#known(captured.blockId);
    if (block === undefined || block.text !== captured.sourceText || block.text.trim() !== "") {
      return false;
    }
    this.#contextBlock = null;
    this.#contextSelection = null;
    this.#submit([{ kind: "replace", blocks: [block.id], text: null }]);
    return true;
  }

  applyPunctuation(finding: PunctuationFinding): boolean {
    const captured = this.#contextBlock;
    if (
      captured === null ||
      this.#interaction.kind === "composing" ||
      captured.blockId !== finding.blockId
    ) {
      return false;
    }
    const block = this.#known(finding.blockId);
    if (block === undefined || block.text !== captured.sourceText) return false;
    let text: string;
    try {
      text = applyPunctuationFinding(block.text, finding);
    } catch {
      return false;
    }
    this.#contextBlock = { blockId: block.id, sourceText: text };
    this.#contextSelection = null;
    this.#submit([{ kind: "replace", blocks: [block.id], text }]);
    const paragraph = this.#byId.get(block.id);
    if (paragraph !== undefined) paragraph.textContent = text;
    return true;
  }

  setAnnotations(annotations: readonly EditorAnnotationProjection[]): void {
    this.#annotations = [...annotations];
    this.#projectAnnotations();
  }

  isComposing(): boolean {
    return this.#interaction.kind === "composing";
  }

  /** Resolve now when idle, or on the next `compositionend`. No timers. */
  whenSettled(): Promise<void> {
    if (this.#interaction.kind !== "composing") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#settledWaiters.push(resolve);
    });
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
    this.#clearAnnotations();
    // Never leave a save awaiting a composition that can no longer end.
    const waiting = this.#settledWaiters;
    this.#settledWaiters = [];
    for (const resolve of waiting) resolve();
    this.#element.textContent = "";
    this.#byId.clear();
    this.#measuredHeights.clear();
    this.#contextBlock = null;
    this.#contextSelection = null;
  }

  #paragraphFor(block: Block): HTMLElement {
    const existing = this.#byId.get(block.id);
    if (existing !== undefined) return existing;
    const paragraph = this.#element.ownerDocument.createElement(BLOCK_TAG);
    paragraph.dataset.blockId = block.id;
    // Not editable individually: the manuscript is one editing host, so a
    // selection can cross paragraph boundaries. Per-paragraph contentEditable
    // makes each one its own host and the browser collapses any drag that
    // leaves it — the author watches the selection stop at the block edge.
    paragraph.textContent = block.text;
    paragraph.style.minHeight = "1em";
    paragraph.style.whiteSpace = "pre-wrap";
    paragraph.style.outline = "none";
    return paragraph;
  }

  /**
   * The paragraph an event concerns.
   *
   * The whole manuscript is one editing host, so a browser-generated event
   * targets the container rather than a paragraph — the caret is what says
   * which block the author is in. Pointer events still carry a paragraph, and
   * that answer is preferred because a right-click does not move the caret.
   */
  /**
   * The paragraph a pointer landed on. Nothing else counts: a right-click does
   * not move the caret, so falling back to the selection here would answer for
   * a target the author never pointed at.
   */
  #paragraphFrom(target: EventTarget | null): HTMLElement | null {
    return (target as HTMLElement | null)?.closest?.(
      `${BLOCK_TAG}[data-block-id]`,
    ) as HTMLElement | null;
  }

  /**
   * The paragraph the caret is in.
   *
   * The whole manuscript is one editing host, so a browser-generated editing
   * event targets the container rather than a paragraph — only the caret says
   * which block the author is editing.
   */
  #paragraphAtCaret(): HTMLElement | null {
    const selection = this.#element.ownerDocument.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (anchor === null || !this.#element.contains(anchor)) return null;
    const node = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    return (node?.closest(`${BLOCK_TAG}[data-block-id]`) ?? null) as HTMLElement | null;
  }

  #indexOf(id: string): number {
    return projectionIndex(this.#blocks).get(id) ?? -1;
  }

  #known(id: string): Block | undefined {
    const index = this.#indexOf(id);
    return index === -1 ? undefined : this.#blocks[index];
  }

  #clearAnnotations(): void {
    const css = (this.#view as unknown as { CSS?: unknown }).CSS as
      | { highlights?: { delete(name: string): void } }
      | undefined;
    css?.highlights?.delete("refrain-highlight");
    css?.highlights?.delete("refrain-comment");
    for (const paragraph of this.#byId.values()) delete paragraph.dataset.annotation;
  }

  #projectAnnotations(): void {
    this.#clearAnnotations();
    const highlightRanges: Range[] = [];
    const commentRanges: Range[] = [];
    for (const annotation of this.#annotations) {
      if (annotation.anchorState !== "anchored") continue;
      const paragraph = this.#byId.get(annotation.blockId);
      const text = paragraph?.firstChild;
      if (paragraph === undefined || text === null || text === undefined) continue;
      const length = text.textContent?.length ?? 0;
      if (annotation.start >= annotation.end || annotation.end > length) continue;
      const range = this.#element.ownerDocument.createRange();
      range.setStart(text, annotation.start);
      range.setEnd(text, annotation.end);
      (annotation.kind === "highlight" ? highlightRanges : commentRanges).push(range);
      paragraph.dataset.annotation = annotation.kind;
    }
    const HighlightConstructor = (
      this.#view as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const css = (this.#view as unknown as { CSS?: unknown }).CSS as
      | { highlights?: { set(name: string, highlight: unknown): void } }
      | undefined;
    if (HighlightConstructor === undefined || css?.highlights === undefined) return;
    if (highlightRanges.length > 0) {
      css.highlights.set("refrain-highlight", new HighlightConstructor(...highlightRanges));
    }
    if (commentRanges.length > 0) {
      css.highlights.set("refrain-comment", new HighlightConstructor(...commentRanges));
    }
  }

  /**
   * Is the viewport resting at the end of the manuscript?
   *
   * The deadband must absorb estimation error, not just sub-pixel rounding.
   * Unmeasured blocks contribute an estimated height, so the browser clamps a
   * scroll-to-end against an approximate `scrollHeight`; the very next
   * measurement pass corrects that total and leaves the viewport thousands of
   * pixels short. A 2px deadband reads that as "the author scrolled to the
   * middle" and abandons the end of the document — at 100,000 blocks the
   * observed shortfall was 4,138px.
   *
   * One estimated window is the largest correction a single measurement pass
   * can introduce, so it is the honest tolerance: anything closer to the end
   * than that is the author asking for the end.
   */
  #isBottomAnchored(): boolean {
    const residual =
      this.#scrollHost.scrollHeight - this.#scrollHost.clientHeight - this.#scrollHost.scrollTop;
    if (residual <= 2) return true;
    if (this.#blocks.length <= VIRTUALIZE_AFTER) return false;
    return residual <= this.#heightIndex.estimate * BOTTOM_DEADBAND_BLOCKS;
  }

  /**
   * 这一刻该挂多少块在 DOM 里。
   *
   * 按可见像素高度算，不按固定块数：作者把字号从 9px 调到 40px，一屏的块数会从
   * 62 掉到 14（实测，见 e2e/probe-viewport.ts），固定 200 块在前一种情况下只多
   * 载了三倍多、在后一种下多载了十四倍，两头都不合适。
   *
   * 用 heightIndex 的估计值而不是重新测量：它本来就在维护这个数，且随作者滚动
   * 越来越准；这里再量一次只会在每帧的路径上加一次强制布局。
   */
  #windowBlocks(): number {
    const visible = this.#scrollHost.clientHeight;
    const perBlock = this.#heightIndex.estimate;
    if (visible <= 0 || perBlock <= 0) return MIN_WINDOW_BLOCKS;
    const wanted = Math.ceil((visible / perBlock) * WINDOW_SCREENS);
    return Math.min(MAX_WINDOW_BLOCKS, Math.max(MIN_WINDOW_BLOCKS, wanted));
  }

  /**
   * 把一个 spacer 撑成 [start, end) 那段未渲染区域的高度。
   *
   * 高度为零时留在 DOM 里而不是摘掉：它只是一个零高度的空 div，留着可以省掉
   * 每帧判断「这个 spacer 现在该不该存在」，也让子节点顺序恒定为
   * 头 spacer → 段落 → 尾 spacer。
   */
  /** 取第 `slot` 个填充块并撑成 [start, end) 那段的高度。不够就新建一个。 */
  #spacerAt(slot: number, start: number, end: number): HTMLElement {
    let spacer = this.#spacers[slot];
    if (spacer === undefined) {
      spacer = makeSpacer(this.#element.ownerDocument);
      this.#spacers[slot] = spacer;
    }
    const next = `${this.#heightIndex.span(start, end)}px`;
    // 只在值真的变了时才写：写同样的值也会让浏览器把布局标脏。
    if (spacer.style.height !== next) spacer.style.height = next;
    return spacer;
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
    // Where the author is editing is the caret, not the focused element: the
    // manuscript is one editing host, so focus always sits on the container.
    // Windowing must keep that paragraph mounted, or scrolling past it destroys
    // the selection along with the node.
    const activeParagraph = this.#paragraphAtCaret();
    const activeOffset = activeParagraph === null ? null : caretWithin(activeParagraph);
    const composingId = this.#interaction.kind === "composing" ? this.#interaction.blockId : null;
    const pinnedId = composingId ?? activeParagraph?.dataset.blockId ?? null;
    const virtual = this.#blocks.length > VIRTUALIZE_AFTER;
    const scrollIndex = this.#heightIndex.atOffset(this.#scrollHost.scrollTop);
    const focusIndex = center ?? Math.max(0, scrollIndex);
    const windowBlocks = this.#windowBlocks();
    // 焦点前留四分之一窗：作者多半往下读，把余量放在前进方向上。
    const visibleStart = virtual
      ? Math.max(
          0,
          Math.min(this.#blocks.length - windowBlocks, focusIndex - Math.floor(windowBlocks / 4)),
        )
      : 0;
    const visibleEnd = virtual
      ? Math.min(this.#blocks.length, visibleStart + windowBlocks)
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

    // 只动差集，不整窗替换。
    //
    // 段落元素本来就是复用的（previous 那张表），但 replaceChildren 会把整窗的
    // 节点从 DOM 摘下再插回，浏览器要重算整棵子树；而滚动一格实际只有几个块
    // 进出。实测（10 万块、窗口 200、连续滚 120 次，e2e/probe-window-diff.ts）：
    // 整窗替换 p50 1.90ms / p95 2.20ms，只动差集 p50 0.20ms / p95 0.30ms。
    //
    // spacer 从「每段之间按需插入」改成头尾各一个固定元素并复用：窗口是一段
    // 连续区间，中间不需要 spacer；被钉住的那个块（正在输入、不在窗口里）单独
    // 处理，它是唯一的例外。
    const previous = new Map(this.#byId);
    this.#byId.clear();

    if (this.#blocks.length === 0) {
      const seed = previous.get("") ?? this.#paragraphFor({ id: "", text: "" });
      this.#byId.set("", seed);
      for (const [id, node] of previous) if (id !== "") node.remove();
      for (const spacer of this.#spacers) spacer.remove();
      this.#element.replaceChildren(seed);
    } else {
      // 先把离开窗口的摘掉，再插进新来的。次序无关紧要，但先摘后插让 DOM 里
      // 同时存在的节点数不会超过一窗。
      const wanted = new Set<string>();
      for (const index of indices) {
        const block = this.#blocks[index];
        if (block !== undefined) wanted.add(block.id);
      }
      for (const [id, node] of previous) {
        if (!wanted.has(id)) node.remove();
      }

      // spacer 按 indices 的间隙逐段给，而不是只在首尾各给一个。
      //
      // 「窗口是一段连续区间」这个想法漏掉了被钉住的块：作者正在输入的那一段
      // 即使滚出窗口也必须留在 DOM 里，于是 indices 会长成 [50000, 99939…99999]，
      // 只按首尾放 spacer 会把中间四万多块的高度整个丢掉（实测贴底那一帧文档
      // 高度从 674 万掉到 337 万，下一帧弹回，滚动位置随之失守）。
      //
      // 逐段给不需要为钉住的块开特例：它自然就是 indices 里的一个孤立项。
      const ordered: HTMLElement[] = [];
      let nextIndex = 0;
      let spacerSlot = 0;
      for (const index of indices) {
        if (index > nextIndex) {
          ordered.push(this.#spacerAt(spacerSlot, nextIndex, index));
          spacerSlot += 1;
        }
        const block = this.#blocks[index];
        if (block === undefined) continue;
        const paragraph = previous.get(block.id) ?? this.#paragraphFor(block);
        // Never overwrite the paragraph holding the caret: its DOM text is the
        // author's in-flight edit, ahead of the projection.
        if (paragraph !== activeParagraph && paragraph.textContent !== block.text) {
          paragraph.textContent = block.text;
        }
        this.#byId.set(block.id, paragraph);
        ordered.push(paragraph);
        nextIndex = index + 1;
      }
      if (nextIndex < this.#blocks.length) {
        ordered.push(this.#spacerAt(spacerSlot, nextIndex, this.#blocks.length));
      }

      // 走一遍，把不在位的节点搬到位。绝大多数帧里只有两三个节点需要动，
      // 其余的 insertBefore 判断为「已经在这里」而直接跳过。
      let cursor: ChildNode | null = this.#element.firstChild;
      for (const node of ordered) {
        if (cursor === node) {
          cursor = node.nextSibling;
          continue;
        }
        this.#element.insertBefore(node, cursor);
      }
      // 剩下的都是这一帧不该出现的（例如上一帧被钉住、这一帧回到窗口里的那个）。
      while (cursor !== null) {
        const next: ChildNode | null = cursor.nextSibling;
        cursor.remove();
        cursor = next;
      }
    }
    this.#projectAnnotations();
    if (pinnedId !== null && activeOffset !== null) {
      const restored = this.#byId.get(pinnedId);
      if (restored !== undefined) {
        this.#element.focus({ preventScroll: true });
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
    this.#contextBlock = null;
    this.#contextSelection = null;
    const paragraph = this.#paragraphAtCaret();
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
    const paragraph = this.#paragraphAtCaret();
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
    this.#contextBlock = null;
    this.#contextSelection = null;
    const paragraph = this.#paragraphAtCaret();
    if (paragraph !== null) this.#settleBlock(paragraph.dataset.blockId ?? "");
  };

  readonly #onCompositionStart = (_event: CompositionEvent): void => {
    this.#contextBlock = null;
    this.#contextSelection = null;
    const paragraph = this.#paragraphAtCaret();
    this.#interaction = {
      kind: "composing",
      blockId: paragraph?.dataset.blockId ?? "",
      deferredCenter: null,
      refreshLayout: false,
    };
  };

  readonly #onCompositionEnd = (_event: CompositionEvent): void => {
    const paragraph = this.#paragraphAtCaret();
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
    const waiting = this.#settledWaiters;
    this.#settledWaiters = [];
    for (const resolve of waiting) resolve();
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
