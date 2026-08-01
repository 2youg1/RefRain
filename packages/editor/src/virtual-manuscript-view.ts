import type { DiffPresentation } from "@refrain/typeset";
import { BlockHeightIndex } from "./block-height-index";
import { applyBlockPrefix, type BlockPrefix } from "./block-prefix";
import { ADDED_HIGHLIGHT, ChangeHighlights } from "./change-highlights";
import { type CodeTheme, fenceLanguage, forgetHighlights, tokenizeCode } from "./code-highlight";
import { applyInlineMark } from "./inline-mark";
import { inlineSpans } from "./inline-render.ts";
import { paintSpacedText } from "./inter-script-spacing";
import type {
  Block,
  EditorAnnotationProjection,
  EditorChange,
  EditorContext,
  EditorFormat,
  ProposalMark,
  PunctuationFinding,
  SelectionMeasure,
} from "./model";
import { applyLocally, PENDING_ID_PREFIX, projectionIndex } from "./projection";
import { applyPunctuationFinding, convertPunctuation, findPunctuation } from "./punctuation";

const BLOCK_TAG = "p";

/**
 * How many lines a block is predicted to occupy, from its byte shape.
 *
 * Returns 0 when the block carries no shape — it was created locally and the
 * domain has not confirmed it yet — and the index keeps the flat estimate for
 * those. Each hard line wraps on its own: dividing the total width once would
 * undercount, because the slack at the end of one hard line does not carry
 * over to the next.
 */
function predictedLines(block: Block, lineUnits: number): number {
  const width = block.widthUnits;
  if (width === undefined || lineUnits <= 0) return 0;
  const hard = (block.hardLines ?? 0) + 1;
  if (block.isFence === true) return hard;
  const perHard = Math.ceil(width / hard);
  // Averaging undercounts one unusually long line: that line alone wraps onto
  // several rows. Take the larger estimate — a slightly tall spacer costs
  // less than a scrollbar that shrinks once measuring catches up.
  return Math.max(
    hard * Math.max(1, Math.ceil(perHard / lineUnits)),
    Math.ceil((block.maxLineUnits ?? 0) / lineUnits),
  );
}

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
 * 它描述高度索引误差，不描述窗口大小。误差与窗口大小无关：未测量的块各贡献一个估计值，
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

/**
 * 把一个字符偏移落到具体的文本节点上。
 *
 * 段落里不止一个文本节点：混排间距的空元素、代码围栏的着色 span 都会把文本
 * 切成几段，而间距元素本身不含文本节点，于是它对偏移是透明的。遍历只看文本
 * 节点，累加长度——这个坐标系与 `textContent`、与领域给的块文本完全一致。
 *
 * 落在两个节点交界处时归给前一个（`remaining <= length`），因为一个区间的
 * 终点更常是「上一段的末尾」而不是「下一段的开头」，光标定位同理。
 */
function locateOffset(block: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = (node.textContent ?? "").length;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

function placeCaret(block: HTMLElement, offset: number): void {
  const selection = block.ownerDocument.getSelection();
  if (!selection) return;
  const range = block.ownerDocument.createRange();
  const located = locateOffset(block, offset);
  if (located !== null) {
    range.setStart(located.node, located.offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  range.selectNodeContents(block);
  range.collapse(false);
  if (block.firstChild === null) range.setStart(block, 0);
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
  /**
   * 提案印点：段落右缘的一枚小圆点，点开是饭盒裁决。与批注不同道——批注
   * 画在文字上（CSS Highlight），印点是段落的一个附件，有自己的生命周期。
   */
  #proposalMarks: readonly ProposalMark[] = [];
  #proposalMarkListeners: ((id: string) => void)[] = [];
  /**
   * 外部改动的着色账。作者自己的编辑不进这本账——见 change-highlights.ts
   * 的说明：`#submit` 已把它们落进投影，比对时按构造为零区间。
   */
  readonly #changeHighlights = new ChangeHighlights();
  #blocks: Block[];
  #heightIndex: BlockHeightIndex;
  #contextBlock: { readonly blockId: string; readonly sourceText: string } | null = null;
  #settledWaiters: (() => void)[] = [];
  #selectionListeners: ((measure: SelectionMeasure | null) => void)[] = [];
  #contextSelection: ContextSelection | null = null;
  #interaction: InteractionState = { kind: "idle" };
  /**
   * The intended caret after a structural edit (split, merge, span delete,
   * multi-block paste): when the confirmation comes back, the caret returns
   * to where the author was working instead of the first block.
   */
  #pendingCaret: { readonly blockId: string; readonly offset: number } | null = null;
  /**
   * Birth certificate of a locally minted placeholder block: pending id → the
   * text and position it had when it crossed the bridge. The author keeps
   * typing while the confirmation travels; those characters live on the
   * placeholder, and this record is what reconciles the placeholder id with
   * the domain id so they can be submitted once a real name exists.
   */
  readonly #pendingBirths = new Map<string, { readonly text: string; readonly index: number }>();
  /**
   * The palette fences are coloured with. Set by the shell when the author
   * changes theme; `forgetHighlights` clears the token cache at the same time.
   */
  #codeTheme: CodeTheme = "vitesse-light";
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
    // Width has to be known before shapes can be turned into line counts, so
    // this runs after #measuredWidth is set. One place builds the index.
    this.#rebuildHeightIndex();

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
    element.addEventListener("pointerdown", this.#onProposalMarkPointer, true);
    element.addEventListener("beforeinput", this.#onBeforeInput);
    element.addEventListener("input", this.#onInput);
    element.addEventListener("paste", this.#onPaste);
    element.addEventListener("compositionstart", this.#onCompositionStart);
    element.addEventListener("compositionend", this.#onCompositionEnd);
    this.#scrollHost.addEventListener("scroll", this.#onScroll, { passive: true });
    // selectionchange 只在 document 上派发，不在元素上。
    element.ownerDocument.addEventListener("selectionchange", this.#onSelectionChange);

    this.#render();
    this.#layoutKey = this.#currentLayoutKey();
    this.#measuredWidth = element.clientWidth;
  }

  replace(blocks: readonly Block[]): void {
    this.#contextBlock = null;
    this.#contextSelection = null;
    const previousBlocks = this.#blocks;
    // Capture the caret before the swap: confirmed blocks may carry fresh ids,
    // and the author's typing position must not travel with them.
    const caretParagraph = this.#paragraphAtCaret();
    const caretId = caretParagraph?.dataset.blockId ?? null;
    const caretOffset = caretParagraph === null ? null : caretWithin(caretParagraph);
    const intended = this.#pendingCaret;
    this.#pendingCaret = null;
    const previousPositions = projectionIndex(previousBlocks);
    for (const block of blocks) {
      const previousIndex = previousPositions.get(block.id);
      const previous = previousIndex === undefined ? undefined : previousBlocks[previousIndex];
      if (previous?.text !== block.text) this.#measuredHeights.delete(block.id);
    }
    this.#blocks = [...blocks];
    // 改动着色在这里记账，而不是在 #submit：到这一刻为止，作者自己的编辑
    // 早已通过 applyLocally 进了 previousBlocks，于是只有外部改动比得出差异。
    this.#changeHighlights.observe(previousBlocks, this.#blocks, Date.now());
    const adopted = this.#adoptPending(previousBlocks);
    this.#rebuildHeightIndex();
    if (this.#interaction.kind === "idle") {
      this.#renderedSignature = "";
      this.#render();
    }
    this.#restoreCaret(caretId, caretOffset, intended, adopted);
  }

  /**
   * Map placeholder ids onto the ids the domain just confirmed.
   *
   * Local structural edits (split, multi-block paste) mint pending-* blocks;
   * the domain mints its own ids for the same content. The author kept typing
   * during the round trip, so any placeholder whose text has moved on gets one
   * deferred replace now that a real id exists — this is what makes fast
   * typing right after Enter lose nothing.
   */
  #adoptPending(previousBlocks: readonly Block[]): Map<string, string> {
    const adopted = new Map<string, string>();
    if (this.#pendingBirths.size === 0) return adopted;
    const previousIds = new Set(previousBlocks.map((block) => block.id));
    for (const pending of previousBlocks) {
      const birth = this.#pendingBirths.get(pending.id);
      if (birth === undefined) continue;
      this.#pendingBirths.delete(pending.id);
      // Candidates: ids not seen before whose text matches what the domain
      // received. Ties (identical paragraphs) go to the one nearest the
      // placeholder's birth position.
      let found: { id: string; distance: number } | null = null;
      for (let index = 0; index < this.#blocks.length; index += 1) {
        const candidate = this.#blocks[index];
        if (candidate === undefined || previousIds.has(candidate.id)) continue;
        if (candidate.text !== birth.text) continue;
        const distance = Math.abs(index - birth.index);
        if (found === null || distance < found.distance) found = { id: candidate.id, distance };
      }
      if (found === null) continue; // The insert was refused; the block vanishes on render.
      adopted.set(pending.id, found.id);
      if (pending.text !== birth.text) {
        this.#submit([{ kind: "replace", blocks: [found.id], text: pending.text }]);
      }
    }
    return adopted;
  }

  /**
   * Put the caret back after a confirmed replace. Intended caret first (the
   * structural edit's own target), then the block the caret was in. When
   * neither survives, leave the selection alone — jumping to the first block
   * is the worst answer a confirmation can give.
   */
  #restoreCaret(
    previousId: string | null,
    previousOffset: number | null,
    intended: { readonly blockId: string; readonly offset: number } | null,
    adopted: Map<string, string>,
  ): void {
    if (this.#destroyed) return;
    if (intended !== null) {
      const id = adopted.get(intended.blockId) ?? intended.blockId;
      if (this.#indexOf(id) >= 0) {
        this.focus(id, intended.offset);
        return;
      }
    }
    if (previousId !== null && previousOffset !== null) {
      const id = adopted.get(previousId) ?? previousId;
      const block = this.#known(id);
      if (block !== undefined) {
        this.focus(id, Math.min(previousOffset, block.text.length));
      }
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

  /**
   * Toggle a block-level prefix on the block holding the caret.
   *
   * Unlike `formatSelection` this needs no selection: a heading or a quote is a
   * property of the block, and asking the author to select the line first would
   * be asking them to do the machine's work.
   */
  applyBlockPrefix(prefix: BlockPrefix): boolean {
    if (this.#interaction.kind === "composing") return false;
    const paragraph = this.#paragraphAtCaret() ?? this.#contextParagraph();
    const id = paragraph?.dataset.blockId;
    if (id === undefined) return false;
    const block = this.#known(id);
    if (block === undefined) return false;
    const next = applyBlockPrefix(block.text, prefix);
    if (next === null || next === block.text) return false;
    this.#contextBlock = null;
    this.#contextSelection = null;
    this.#submit([{ kind: "replace", blocks: [block.id], text: next }]);
    const mounted = this.#byId.get(block.id);
    if (mounted !== undefined) {
      this.#paintText(mounted, next, block.isFence === true);
      this.#element.focus({ preventScroll: true });
      placeCaret(mounted, next.length);
    }
    return true;
  }

  /**
   * 把一个块的文本画进它的段落元素。
   *
   * 四个写入点（挂载、行内标记、块前缀、批量替换）此前各自写 `textContent`。
   * 混排间距要在写文本的同时插入间距元素，而分散在四处意味着**将来新增第五
   * 个写入点的人必须记得这件事**——记不住是常态，而漏掉的表现是那一个块的
   * 中西文之间没有间距，不报错、不崩溃，只是和别的段落长得不一样。
   *
   * 所以间距不是「写完文本再做的一步」，它就是写文本这件事本身。
   *
   * 语言取自 DOM 的 `lang`，而不是视图自己存一份。理由有两条：
   *
   * 一是 `lang` 本来就是 HTML 表达语言的机制，浏览器的 `line-break`、
   * `word-break: auto-phrase`、字体回退全都读它——视图另存一份就成了第二个
   * 权威，而两者漂开时没有任何东西会报错。
   *
   * 二是手稿可以中日混排。`closest("[lang]")` 让某个块（或某个区域）能声明
   * 自己是日文，而两种语言的间距值确实不同：CSS Text 4 §8.4.1 的 1/8 ic
   * 对 JIS 的 1/4 em。没有任何 `lang` 时 `presetOf` 落到简中。
   */
  #paintText(paragraph: HTMLElement, text: string, fence = false): void {
    const measureEm = this.#measureEm();
    // 围栏代码块不做行内解析：整块交给 `#highlightFence`，而在代码里 `*` 就是
    // 乘号，把它当强调会让一段 C 指针声明半截变粗。围栏最终会被高亮覆盖，但
    // 在那之前 `#paintText` 已经画过一遍——不挡住这里，作者会看到代码先变粗
    // 再被改回来。
    //
    // 判据取自块自己的 `isFence`（`BlockShape` 在 Rust 侧判的），不是从 DOM
    // 读的属性：段落在 `#paragraphFor` 里造出来时还没有任何 dataset。
    const marks = fence ? [] : inlineSpans(text);
    paintSpacedText(paragraph, text, this.#declaredLanguage(paragraph), measureEm, marks);
    // 记下这一段是按哪个版心断的行。文本没变但版心变了（窗口缩放、字号、
    // 版心设置）时，行必须重断——而只比对文本的重画条件看不见这件事，
    // 表现是换完窗口大小之后行还留在旧断点上，直到作者碰了那一段才更新。
    paragraph.dataset.measureEm = String(measureEm);
  }

  /**
   * 这个段落该按哪种语言排版。
   *
   * 从段落自己往上找 `lang`，找不到就用编辑宿主的，再找不到用文档的。
   *
   * 不能只写 `paragraph.closest("[lang]")`：`#paragraphFor` 造出段落时它还
   * 没有插进 DOM，`closest` 那时返回 null，于是**挂载路径永远拿不到语言**，
   * 而已挂载的块改文本时又拿得到——同一份稿子的新块与旧块用两套间距，且只
   * 在滚动到未渲染区域时才看得出来。所以宿主是兜底的那一层：它始终在 DOM 里。
   */
  #declaredLanguage(paragraph: HTMLElement): string {
    return (
      paragraph.closest<HTMLElement>("[lang]")?.lang ||
      this.#element.closest<HTMLElement>("[lang]")?.lang ||
      paragraph.ownerDocument.documentElement.lang
    );
  }

  /** The block a right-click captured, when the caret is elsewhere. */
  #contextParagraph(): HTMLElement | null {
    const id = this.#contextBlock?.blockId;
    return id === undefined ? null : (this.#byId.get(id) ?? null);
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
      this.#paintText(paragraph, edit.text, block.isFence === true);
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
    if (paragraph !== undefined) this.#paintText(paragraph, text, block.isFence === true);
    return true;
  }

  /**
   * 全稿标点全半角一键切换。返回改动的块数；一处也不该改时返回 0。
   *
   * **一次 EditorAction 覆盖所有块**，这不是为了省事：Plan 3.2-1 的判据是
   * 「一次撤销完全还原」。`EditorChange` 的 `blocks` 本来就是数组，所以把
   * 二百个块的改动拆成二百个 action 才是额外的选择——而那样作者要按二百次
   * 撤销，中途停手就留下半篇转过、半篇没转的稿子。
   *
   * 逐块调 `convertPunctuation`，它内部复用右键菜单那套 finding 规则，所以
   * 例外（代码块、行内代码、`3.14`、`e.g.`、`...`、URL）只有一份定义。
   *
   * 不改的块不进 changes：一个「替换成完全相同的文本」的改动会让账本记下一
   * 笔什么也没发生的事，而作者回头看历史时无从分辨它和真改动。
   */
  convertPunctuationEverywhere(): number {
    if (this.#interaction.kind === "composing") return 0;
    const changes: EditorChange[] = [];
    for (const block of this.#blocks) {
      const converted = convertPunctuation(block.id, block.text);
      if (converted === null) continue;
      changes.push({ kind: "replace", blocks: [block.id], text: converted });
    }
    if (changes.length === 0) return 0;
    this.#submit(changes);
    for (const change of changes) {
      if (change.kind !== "replace" || change.text === null) continue;
      const id = change.blocks[0];
      if (id === undefined) continue;
      const paragraph = this.#byId.get(id);
      const converted = this.#known(id);
      if (paragraph !== undefined) {
        this.#paintText(paragraph, change.text, converted?.isFence === true);
      }
    }
    return changes.length;
  }

  setAnnotations(annotations: readonly EditorAnnotationProjection[]): void {
    this.#annotations = [...annotations];
    this.#projectAnnotations();
  }

  /** 换上整组提案印点。与批注一样：整组替换，不逐枚增量。 */
  setProposalMarks(marks: readonly ProposalMark[]): void {
    this.#proposalMarks = [...marks];
    this.#syncProposalMarks();
  }

  /**
   * 改动着色的呈现模式。
   *
   * 普通模式标出增删；Kara 只画改动后的成品。**两者读的是同一份判定**，
   * 这里换的只是过滤器——各算一次的话，同一处改动可能在两个模式下标出不同的
   * 范围，而那种不一致没有任何东西会报错。
   */
  setDiffPresentation(presentation: DiffPresentation): void {
    if (presentation === this.#changeHighlights.presentation()) return;
    this.#changeHighlights.setPresentation(presentation);
    this.#projectChangeHighlights();
  }

  /** 印点被点开。返回退订。 */
  onProposalMark(listener: (id: string) => void): () => void {
    this.#proposalMarkListeners.push(listener);
    return () => {
      this.#proposalMarkListeners = this.#proposalMarkListeners.filter(
        (candidate) => candidate !== listener,
      );
    };
  }

  /** 一个块此刻在屏幕上的位置——饭盒据此贴到锚点旁边。 */
  blockRect(blockId: string): DOMRect | null {
    return this.#byId.get(blockId)?.getBoundingClientRect() ?? null;
  }

  /** 有没有印点被渲染过：一枚都没有时，每一帧的查询是纯浪费。 */
  #proposalMarksRendered = false;

  /** 印点重挂：渲染会重写段落 textContent，印点每一帧都要确认自己还在。 */
  #syncProposalMarks(): void {
    if (this.#proposalMarks.length === 0 && !this.#proposalMarksRendered) return;
    const wanted = new Set<string>();
    for (const mark of this.#proposalMarks) {
      const paragraph = this.#byId.get(mark.blockId);
      if (paragraph === undefined) continue;
      wanted.add(mark.id);
      let dot = paragraph.querySelector<HTMLElement>(`:scope > .proposal-mark`);
      if (dot === null) {
        dot = paragraph.ownerDocument.createElement("span");
        dot.className = "proposal-mark";
        dot.contentEditable = "false";
        dot.setAttribute("role", "button");
        dot.setAttribute("aria-label", "提案");
        paragraph.append(dot);
      }
      dot.dataset.proposalMark = mark.id;
      this.#proposalMarksRendered = true;
    }
    // 摘掉不再被点名的（判过的、换稿剩下的）。
    let remaining = false;
    for (const dot of this.#element.querySelectorAll<HTMLElement>(".proposal-mark")) {
      if (wanted.has(dot.dataset.proposalMark ?? "")) remaining = true;
      else dot.remove();
    }
    this.#proposalMarksRendered = remaining;
  }

  /**
   * Switch the code palette: clear the token cache, strip the highlight marks,
   * and let the next render colour every fence with the new theme.
   */
  setCodeTheme(theme: CodeTheme): void {
    if (theme === this.#codeTheme) return;
    this.#codeTheme = theme;
    forgetHighlights();
    for (const paragraph of this.#byId.values()) delete paragraph.dataset.highlighted;
    this.#renderedSignature = "";
    if (this.#interaction.kind === "idle") this.#render();
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
    this.#element.removeEventListener("pointerdown", this.#onProposalMarkPointer, true);
    this.#element.removeEventListener("beforeinput", this.#onBeforeInput);
    this.#element.removeEventListener("input", this.#onInput);
    this.#element.removeEventListener("paste", this.#onPaste);
    this.#element.removeEventListener("compositionstart", this.#onCompositionStart);
    this.#element.removeEventListener("compositionend", this.#onCompositionEnd);
    this.#scrollHost.removeEventListener("scroll", this.#onScroll);
    this.#element.ownerDocument.removeEventListener("selectionchange", this.#onSelectionChange);
    this.#selectionListeners = [];
    this.#proposalMarkListeners = [];
    this.#element.ownerDocument.fonts?.removeEventListener("loadingdone", this.#onFontsLoaded);
    this.#resizeObserver?.disconnect();
    this.#rootObserver?.disconnect();
    for (const frame of Object.values(this.#frames)) {
      if (frame !== null) this.#view.cancelAnimationFrame(frame);
    }
    this.#clearAnnotations();
    // 改动着色是全局注册的 Highlight，不随元素销毁而消失：不撤下来，下一份
    // 稿子会带着上一份的颜色开场。
    this.#changeHighlights.clear();
    this.#projectChangeHighlights();
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
    this.#paintText(paragraph, block.text, block.isFence === true);
    paragraph.style.minHeight = "1em";
    // `pre` 而不是 `pre-wrap`：折行由 `optimizedLineStarts` 决定，画成断行
    // 元素（见 inter-script-spacing.ts）。留着 `pre-wrap` 浏览器会在我们的
    // 断点之外**再**折一次，两套断点叠加，屏幕上只表现为「行短了一点」，
    // 而没有任何东西会报错。`verify:linebreak-takeover` 守住这个配对。
    paragraph.style.whiteSpace = "pre";
    paragraph.style.outline = "none";
    return paragraph;
  }

  /**
   * The language a fence declares, or null when it declares none this
   * highlighter knows. `code-highlight.ts` owns the parsing; this is the
   * block-shaped guard around it.
   */
  #fenceLanguage(block: Block): string | null {
    return block.isFence === true ? fenceLanguage(block.text) : null;
  }

  /**
   * Colours a fence in place, replacing its single text node with one span per
   * token.
   *
   * Three conditions guard the write, and each one exists because breaking it
   * is visible to the author:
   *
   * - The caret must not be in this paragraph. Its DOM text is the in-flight
   *   edit, ahead of the projection.
   * - No composition may be in flight, because replacing nodes under an IME
   *   drops the pre-edit string.
   * - The text must not have changed while the highlighter was awaited.
   *   Tokenising is async; the author keeps typing during it.
   *
   * Caret offsets survive the replacement: `placeCaret` walks text nodes and
   * accumulates their lengths, so it never assumed a single node.
   */
  async #highlightFence(paragraph: HTMLElement, block: Block): Promise<void> {
    const language = this.#fenceLanguage(block);
    if (language === null) return;

    const before = block.text;
    const lines = await tokenizeCode(before, language, this.#codeTheme);
    if (lines.length === 0) return;

    if (this.#interaction.kind === "composing") return;
    if (paragraph !== this.#paragraphAtCaret() && paragraph.textContent === before) {
      const document_ = paragraph.ownerDocument;
      const fragment = document_.createDocumentFragment();
      lines.forEach((tokens, index) => {
        if (index > 0) fragment.appendChild(document_.createTextNode("\n"));
        for (const token of tokens) {
          const span = document_.createElement("span");
          span.textContent = token.text;
          if (token.color !== "") span.style.color = token.color;
          if (token.italic) span.style.fontStyle = "italic";
          fragment.appendChild(span);
        }
      });
      paragraph.textContent = "";
      paragraph.appendChild(fragment);
      paragraph.dataset.highlighted = before;
    }
  }

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
   * Observe how much text is selected.
   *
   * The measure is over the whole selection, not the block it started in:
   * selecting a passage that spans paragraphs is an ordinary thing to do, and
   * a count that stopped at the first block would be wrong exactly when the
   * author most wants it.
   */
  onSelectionMeasured(listener: (measure: SelectionMeasure | null) => void): () => void {
    this.#selectionListeners.push(listener);
    listener(this.#measureSelection());
    return () => {
      this.#selectionListeners = this.#selectionListeners.filter((entry) => entry !== listener);
    };
  }

  /** Null when nothing is selected, or when the selection is outside this host. */
  #measureSelection(): SelectionMeasure | null {
    const selection = this.#element.ownerDocument.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.#element.contains(range.commonAncestorContainer)) return null;
    const text = range.toString();
    if (text.length === 0) return null;
    // Count code points, so one CJK glyph is one character rather than the two
    // UTF-16 units a surrogate pair would report.
    const characters = [...text].length;
    const fragment = range.cloneContents();
    const blocks = Math.max(1, fragment.querySelectorAll(`${BLOCK_TAG}[data-block-id]`).length);
    return { characters, blocks };
  }

  readonly #onSelectionChange = (): void => {
    if (this.#destroyed || this.#selectionListeners.length === 0) return;
    const measure = this.#measureSelection();
    for (const listener of this.#selectionListeners) listener(measure);
  };

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
   * 把「刚被外部改过的地方」画出来，并撤下已经消退的。
   *
   * 与批注同走 Highlight API，但账本不同：批注是领域的持久对象，改动着色是
   * 一段会自行消失的短期状态。共用一个注册名会让两者互相覆盖——后写的那次
   * `set` 整个替换前一次的 Range 集合。
   *
   * 零区间时仍要 `delete`：改动消退之后没有任何东西会再来清理它，颜色会一直
   * 留在版面上，而那正是「颜色必须消退」要防的。
   */
  #projectChangeHighlights(): void {
    const css = (this.#view as unknown as { CSS?: unknown }).CSS as
      | {
          highlights?: { set(name: string, highlight: unknown): void; delete(name: string): void };
        }
      | undefined;
    if (css?.highlights === undefined) return;
    const HighlightConstructor = (
      this.#view as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    if (HighlightConstructor === undefined) return;

    css.highlights.delete(ADDED_HIGHLIGHT);
    for (const paragraph of this.#byId.values()) delete paragraph.dataset.changed;
    if (this.#changeHighlights.isEmpty()) return;

    const added: Range[] = [];
    for (const [blockId, spans] of this.#changeHighlights.current(Date.now())) {
      const paragraph = this.#byId.get(blockId);
      if (paragraph === undefined) continue; // 滚出窗口的块没有节点可画。
      let removed = false;
      for (const span of spans) {
        if (span.kind === "removed") {
          // 零宽区间画不出像素（实测见 change-highlights.ts 的常量注释），
          // 所以删除标在段落上，不进 Range 集合。
          removed = true;
          continue;
        }
        const start = locateOffset(paragraph, span.start);
        const end = locateOffset(paragraph, span.end);
        if (start === null || end === null) continue;
        const range = this.#element.ownerDocument.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        added.push(range);
      }
      paragraph.dataset.changed = removed ? "removed" : "added";
    }
    if (added.length > 0) css.highlights.set(ADDED_HIGHLIGHT, new HighlightConstructor(...added));
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
   * Take the spacer at `slot` and stretch it to the height of [start, end).
   *
   * A zero-height spacer stays in the DOM rather than being removed: it costs
   * nothing, and the child order stays head spacer → paragraphs → tail spacer
   * on every frame. Created on demand.
   */
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

  /**
   * Line width in display-width units.
   *
   * A CJK glyph is one em wide and counts two units, so one unit is half an em.
   * Ratios are what matter here: the calibration scalar absorbs whatever this
   * is systematically off by, so an approximation that tracks the real width is
   * worth more than an exact number that has to be recomputed on every render.
   */
  #lineUnits(): number {
    const style = this.#view.getComputedStyle(this.#element);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const width = this.#measuredWidth > 0 ? this.#measuredWidth : this.#element.clientWidth;
    return Math.max(1, Math.floor((width / fontSize) * 2));
  }

  /**
   * 版心宽度，em。断行引擎按 em 算宽，所以这是它要的那个数。
   *
   * 从 `#lineUnits()` 派生而不是另算一遍 `width / fontSize`：一个显示宽度当量
   * 是半个 em（见上），两处各自读 `getComputedStyle` 会在字号变化的那一帧读到
   * 不同的值，于是高度预测与实际断行用两个版心，而版面上看不出是哪一个错了。
   *
   * 宽度尚未测出时返回 0，`paintSpacedText` 据此不断行——那时断行会把每个字
   * 断成一行。
   */
  #measureEm(): number {
    const width = this.#measuredWidth > 0 ? this.#measuredWidth : this.#element.clientWidth;
    return width > 0 ? this.#lineUnits() / 2 : 0;
  }

  #rebuildHeightIndex(): void {
    const rebuilt = BlockHeightIndex.uniform(this.#blocks.length, this.#heightIndex.estimate);
    // Predict from each block's own shape before anything is measured. Blocks
    // without a shape (created locally, ahead of the domain's confirmation)
    // contribute nothing here and keep the flat estimate.
    const lineUnits = this.#lineUnits();
    rebuilt.setPredictedLines(this.#blocks.map((block) => predictedLines(block, lineUnits)));
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
        //
        // 走 `#paintText` 而不是直接写 `textContent`：间距、挤压与断行都在那
        // 一处产生。这里曾经直接赋值，于是滚动进窗口的块拿不到间距，而已在
        // 窗口里改文本的块拿得到——同一份稿子的新旧块两套排版，且只有滚到
        // 未渲染区域才看得出来。
        if (
          paragraph !== activeParagraph &&
          (paragraph.textContent !== block.text ||
            paragraph.dataset.measureEm !== String(this.#measureEm()))
        ) {
          this.#paintText(paragraph, block.text, block.isFence === true);
          delete paragraph.dataset.highlighted;
        }
        // A fence the author is not inside gets coloured. The caret's own
        // paragraph stays plain text: spans under an active caret are what
        // makes an editor fight its author.
        if (paragraph === activeParagraph) {
          if (paragraph.dataset.highlighted !== undefined) {
            paragraph.textContent = block.text;
            delete paragraph.dataset.highlighted;
          }
        } else if (block.isFence === true && paragraph.dataset.highlighted !== block.text) {
          void this.#highlightFence(paragraph, block);
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
    this.#syncProposalMarks();
    this.#projectChangeHighlights();
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
    // Rebuild through the one place that builds an index: a layout change is
    // exactly when line width changed, so the per-block predictions have to be
    // recomputed rather than dropped.
    this.#heightIndex = BlockHeightIndex.uniform(this.#blocks.length, this.#currentBlockEstimate());
    this.#rebuildHeightIndex();
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
    // Register the birth of every placeholder this submit minted: the text it
    // crossed the bridge with, and where it was born. #adoptPending reads it.
    for (let index = 0; index < this.#blocks.length; index += 1) {
      const block = this.#blocks[index];
      if (block === undefined) continue;
      if (!block.id.startsWith(PENDING_ID_PREFIX) || this.#pendingBirths.has(block.id)) continue;
      this.#pendingBirths.set(block.id, { text: block.text, index });
    }
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
    if (id.startsWith(PENDING_ID_PREFIX)) {
      // A placeholder has no name the domain knows yet. Mirror the edit into
      // the local projection only; #adoptPending submits it after the
      // confirmation assigns the real id.
      this.#blocks = applyLocally(this.#blocks, [{ kind: "replace", blocks: [id], text: current }]);
      this.#measuredHeights.delete(id);
      this.#heightIndex.invalidate(this.#indexOf(id));
      return;
    }
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
    // The caret follows the tail into the new block's start. That block still
    // carries a placeholder id; #adoptPending translates it on confirmation.
    const minted = this.#blocks[index + 1];
    if (minted !== undefined) this.#pendingCaret = { blockId: minted.id, offset: 0 };
  }

  #mergeWithPrevious(paragraph: HTMLElement, id: string): void {
    const offset = caretWithin(paragraph);
    if (offset !== 0) return;
    const index = this.#indexOf(id);
    const previous = this.#blocks[index - 1];
    if (previous === undefined) return;
    const text = paragraph.textContent ?? "";
    this.#pendingCaret = { blockId: previous.id, offset: previous.text.length };
    this.#submit([
      { kind: "replace", blocks: [previous.id], text: previous.text + text },
      { kind: "replace", blocks: [id], text: null },
    ]);
  }

  /** Delete at the end of a block mirrors Backspace at its start. */
  #mergeWithNext(paragraph: HTMLElement, id: string): void {
    const index = this.#indexOf(id);
    const next = this.#blocks[index + 1];
    if (index < 0 || next === undefined) return;
    const text = paragraph.textContent ?? "";
    this.#pendingCaret = { blockId: id, offset: text.length };
    this.#submit([{ kind: "replace", blocks: [id, next.id], text: text + next.text }]);
  }

  readonly #onBeforeInput = (event: InputEvent): void => {
    if (this.#interaction.kind === "composing") return;
    this.#contextBlock = null;
    this.#contextSelection = null;
    const type = event.inputType;
    // History belongs to the domain. The browser's own undo stack knows
    // nothing about the structural edits we performed in script, so letting
    // it run resurrects text the author deleted. Until a real undo exists,
    // a clear refusal beats quiet corruption.
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      return;
    }
    const paragraph = this.#paragraphAtCaret();
    if (paragraph === null) return;
    const id = paragraph.dataset.blockId ?? "";
    if (type === "insertParagraph" || type === "insertLineBreak") {
      event.preventDefault();
      this.#splitAtCaret(paragraph, id);
      return;
    }
    if (type === "deleteContentBackward" && caretWithin(paragraph) === 0) {
      event.preventDefault();
      this.#mergeWithPrevious(paragraph, id);
      return;
    }
    if (type === "deleteContentForward") {
      const atEnd = caretWithin(paragraph) === (paragraph.textContent ?? "").length;
      if (atEnd) {
        event.preventDefault();
        this.#mergeWithNext(paragraph, id);
        return;
      }
    }
    if (
      type === "deleteContentBackward" ||
      type === "deleteContentForward" ||
      type === "deleteByCut"
    ) {
      const span = this.#selectionSpan();
      if (span !== null) {
        // A native delete would merge the paragraphs in the DOM while the
        // projection still held them, and the next render would resurrect
        // the removed blocks alongside the merged text.
        event.preventDefault();
        if (type === "deleteByCut") {
          const text = this.#element.ownerDocument.getSelection()?.toString() ?? "";
          void this.#view.navigator.clipboard?.writeText(text).catch(() => undefined);
        }
        this.#deleteSpan(span);
      }
      return;
    }
    if (type === "insertFromDrop") {
      const text = event.dataTransfer?.getData("text/plain") ?? "";
      const span = this.#selectionSpan();
      if (span !== null || /\n\s*\n/.test(text)) {
        event.preventDefault();
        this.#dropText(text, span);
      }
    }
  };

  /** A selection spanning two or more blocks; null when collapsed or inside one. */
  #selectionSpan(): {
    readonly startId: string;
    readonly startOffset: number;
    readonly endId: string;
    readonly endOffset: number;
  } | null {
    const selection = this.#element.ownerDocument.getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const startParagraph = this.#paragraphFrom(range.startContainer);
    const endParagraph = this.#paragraphFrom(range.endContainer);
    if (startParagraph === null || endParagraph === null || startParagraph === endParagraph) {
      return null;
    }
    const startProbe = range.cloneRange();
    startProbe.selectNodeContents(startParagraph);
    startProbe.setEnd(range.startContainer, range.startOffset);
    const endProbe = range.cloneRange();
    endProbe.selectNodeContents(endParagraph);
    endProbe.setEnd(range.endContainer, range.endOffset);
    return {
      startId: startParagraph.dataset.blockId ?? "",
      startOffset: startProbe.toString().length,
      endId: endParagraph.dataset.blockId ?? "",
      endOffset: endProbe.toString().length,
    };
  }

  /** Delete a cross-block selection: keep the two half-blocks, drop the rest. */
  #deleteSpan(span: {
    readonly startId: string;
    readonly startOffset: number;
    readonly endId: string;
    readonly endOffset: number;
  }): void {
    const startIndex = this.#indexOf(span.startId);
    const endIndex = this.#indexOf(span.endId);
    if (startIndex < 0 || endIndex < startIndex) return;
    const head = (this.#blocks[startIndex]?.text ?? "").slice(0, span.startOffset);
    const tail = (this.#blocks[endIndex]?.text ?? "").slice(span.endOffset);
    const ids = this.#blocks.slice(startIndex, endIndex + 1).map((block) => block.id);
    const text = head + tail;
    this.#pendingCaret = { blockId: ids[0] ?? "", offset: span.startOffset };
    this.#submit([{ kind: "replace", blocks: ids, text: text === "" ? null : text }]);
  }

  /** Dropped text: a cross-block selection is consumed first, then paragraphs insert. */
  #dropText(
    text: string,
    span: {
      readonly startId: string;
      readonly startOffset: number;
      readonly endId: string;
      readonly endOffset: number;
    } | null,
  ): void {
    if (text === "") return;
    if (span === null) {
      const paragraph = this.#paragraphAtCaret();
      if (paragraph !== null)
        this.#insertParagraphs(paragraph, paragraph.dataset.blockId ?? "", text);
      return;
    }
    const startIndex = this.#indexOf(span.startId);
    const endIndex = this.#indexOf(span.endId);
    if (startIndex < 0 || endIndex < startIndex) return;
    const head = (this.#blocks[startIndex]?.text ?? "").slice(0, span.startOffset);
    const tail = (this.#blocks[endIndex]?.text ?? "").slice(span.endOffset);
    const ids = this.#blocks.slice(startIndex, endIndex + 1).map((block) => block.id);
    const parts = text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length <= 1) {
      const merged = head + text + tail;
      this.#pendingCaret = { blockId: ids[0] ?? "", offset: (head + text).length };
      this.#submit([{ kind: "replace", blocks: ids, text: merged === "" ? null : merged }]);
      return;
    }
    const [first, ...rest] = parts as [string, ...string[]];
    const after = this.#blocks[endIndex + 1]?.id ?? null;
    const changes: EditorChange[] = [
      { kind: "replace", blocks: ids, text: head + first },
      { kind: "insert", before: after, texts: [...rest, tail] },
    ];
    this.#submit(changes);
    const firstKept = head + first !== "";
    const tailBlock = this.#blocks[startIndex + (firstKept ? 1 : 0) + rest.length];
    if (tailBlock !== undefined) this.#pendingCaret = { blockId: tailBlock.id, offset: 0 };
  }

  readonly #onPaste = (event: ClipboardEvent): void => {
    const paragraph = this.#paragraphAtCaret();
    if (paragraph === null || this.#interaction.kind === "composing") return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!/\n\s*\n/.test(text)) return;
    event.preventDefault();
    this.#insertParagraphs(paragraph, paragraph.dataset.blockId ?? "", text);
  };

  /**
   * Multi-paragraph text arriving at the caret: the first part joins the
   * current block's head, each middle part becomes its own block, and the
   * block's tail becomes the last block.
   */
  #insertParagraphs(paragraph: HTMLElement, id: string, text: string): void {
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
    // The caret lands at the end of what was pasted: the head block when there
    // were no middle parts, the last middle block otherwise — or the start of
    // the surviving tail when one exists.
    const firstKept = headBlock !== "";
    if (tailText !== "") {
      const tail = this.#blocks[index + (firstKept ? 1 : 0) + rest.length];
      if (tail !== undefined) this.#pendingCaret = { blockId: tail.id, offset: 0 };
    } else if (rest.length > 0) {
      const last = this.#blocks[index + (firstKept ? 1 : 0) + rest.length - 1];
      if (last !== undefined) this.#pendingCaret = { blockId: last.id, offset: last.text.length };
    } else {
      this.#pendingCaret = { blockId: id, offset: headBlock.length };
    }
  }

  readonly #onInput = (_event: Event): void => {
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

  readonly #onProposalMarkPointer = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const dot = target.closest(".proposal-mark");
    if (!(dot instanceof HTMLElement)) return;
    const id = dot.dataset.proposalMark;
    if (id === undefined) return;
    // 印点不是文本：这一下不该动光标，也不该进 beforeinput。
    event.preventDefault();
    event.stopPropagation();
    for (const listener of this.#proposalMarkListeners) listener(id);
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
