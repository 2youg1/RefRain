import type { DiffPresentation } from "@refrain/typeset";
import { BlockHeightIndex } from "./block-height-index";
import { applyBlockPrefix, type BlockPrefix } from "./block-prefix";
import { ADDED_HIGHLIGHT, ChangeHighlights } from "./change-highlights";
import {
  type CodeTheme,
  documentLanguage,
  fenceLanguage,
  forgetHighlights,
  tokenizeCode,
} from "./code-highlight";
import { declaredFenceLanguage } from "./code-highlight.ts";
import { isDiagramLanguage, renderDiagram } from "./diagram-render.ts";
import { applyInlineMark } from "./inline-mark";
import { inlineSpans } from "./inline-render.ts";
import { paintSpacedText } from "./inter-script-spacing";
import type {
  Block,
  DocumentFormat,
  EditorAnnotationProjection,
  EditorChange,
  EditorContext,
  EditorFormat,
  ProposalMark,
  PunctuationFinding,
  SelectionMeasure,
} from "./model";
import { applyLocally, PENDING_ID_PREFIX, projectionIndex } from "./projection";
import {
  applyPunctuationFinding,
  convertPunctuation,
  findingsWithin,
  findPunctuation,
} from "./punctuation";
import { paintTableText, tableLayout } from "./table-render.ts";

const BLOCK_TAG = "p";

/**
 * 多行文本切成块。Markdown 按空行分段、去掉每段首尾空白——段落之间
 * 的缩进不是内容。纯文本按行切，缩进与空行都是内容，一个字符不动；
 * 只有行尾的 `\r` 不是行内容——与扫描器同一条规则。
 *
 * 模块级而不是方法：这条规则是粘贴路径唯一会把作者的代码吃掉的地方，
 * 它必须能脱离 DOM 被测试钉住。
 */
export function splitPastedText(text: string, format: DocumentFormat): string[] {
  if (format === "markdown") {
    return text
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }
  return text.split("\n").map((part) => (part.endsWith("\r") ? part.slice(0, -1) : part));
}

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
 * 整稿字符数超过这个量时，视口带之外的块先挂占位、延后排版。
 *
 * 阈值来自实测：180KB 的稿子同步挂载约 60–190ms，800KB 的 HTML 导入材料约
 * 0.6–1.2s——排版（断行 + 间距元素）随字节数线性增长，越过这个量级「打开」
 * 就从一次停顿变成一次冻结。带内的块照常同步排版；带外的块文本原样进 DOM
 * （`textContent` 逐字节完整），占位高度取自高度索引，真正的排版由升级队列
 * 在后续帧里逐块补上。虚拟化的稿子（> VIRTUALIZE_AFTER）不走这条路：窗口
 * 本来就只挂一屏的块。
 */
const DEFER_TYPESET_TOTAL = 200_000;
/** 延后排版的升级队列每帧的预算。 */
const TYPESET_UPGRADE_BUDGET_MS = 8;
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
  typeset: number | null;
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
  readonly #frames: FrameHandles = { render: null, measurement: null, layout: null, typeset: null };
  /**
   * 等升级后排版的块：视口带之外、只挂了占位的块 id，按文档顺序。
   *
   * 队列只在非虚拟稿上产生（见 DEFER_TYPESET_TOTAL）；虚拟稿的窗口机制
   * 已经回答了「哪些块此刻值得排版」。
   */
  readonly #deferredTypeset: string[] = [];

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
  /**
   * What this document's bytes are. Decided at mount and constant for the
   * document's lifetime — a format change is a different document, and a
   * different document is a remount.
   *
   * Everything the format decides keys off this one field: Markdown
   * affordances (inline marks, tables, diagrams, punctuation), the CJK
   * typesetting prose gets, and the one grammar a plain-text document
   * highlights with.
   */
  readonly #format: DocumentFormat;
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
    format: DocumentFormat = "markdown",
  ) {
    const view = element.ownerDocument.defaultView;
    if (view === null) throw new Error("editor document has no window");
    this.#element = element;
    this.#scrollHost = element.parentElement ?? element;
    this.#format = format;
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
    // 落光标之前必须先撤掉占位：占位块是 content-visibility: hidden，光标
    // 落进去没有几何，作者会看到一个不闪烁、不响应的插入点。
    if (target.dataset.deferredTypeset !== undefined) {
      const block = this.#known(target.dataset.blockId ?? "");
      if (block !== undefined && target.textContent === block.text) {
        this.#paintText(target, block.text, block.isFence === true);
        this.#clearDeferred(target);
        const queued = this.#deferredTypeset.indexOf(block.id);
        if (queued >= 0) this.#deferredTypeset.splice(queued, 1);
        this.#measuredHeights.delete(block.id);
        this.#scheduleMeasurement();
      }
    }
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
    // 块前缀（`#`、`>`）是 Markdown 语法，写在代码行首就是注入字符。
    if (this.#format !== "markdown") return false;
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
    // 纯文本：没有行内标记、没有表格、没有 CJK 排版（间距、挤压、悬挂、
    // 自研断行都没有）。文本逐字节进 DOM，浏览器按 pre-wrap 自己折行——
    // 那是代码编辑器本来的折行，而光标偏移是文本节点长度之和，与折行无关。
    if (this.#format !== "markdown") {
      paragraph.textContent = text;
      paragraph.dataset.measureEm = String(measureEm);
      return;
    }
    // 围栏代码块不做行内解析：整块交给 `#highlightFence`，而在代码里 `*` 就是
    // 乘号，把它当强调会让一段 C 指针声明半截变粗。围栏最终会被高亮覆盖，但
    // 在那之前 `#paintText` 已经画过一遍——不挡住这里，作者会看到代码先变粗
    // 再被改回来。
    //
    // 判据取自块自己的 `isFence`（`BlockShape` 在 Rust 侧判的），不是从 DOM
    // 读的属性：段落在 `#paragraphFor` 里造出来时还没有任何 dataset。
    // 表格自己管对齐：单元格按列共用宽度，而折行会把一行单元格拆到两行上、
    // 列当场散架。所以表格不进断行那条路，`measureEm` 传 0 关掉断行。
    const table = fence ? null : tableLayout(text);
    if (table) {
      paintTableText(paragraph, text, table, this.#declaredLanguage(paragraph));
      paragraph.dataset.measureEm = String(measureEm);
      return;
    }
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
    // 标点转换是散文的功能：代码里的全角标点（注释、字符串）不是待修的
    // 标点，纯文本文档一个 finding 也不给。
    const punctuation = this.#format === "markdown" ? findPunctuation(blockId, block.text) : [];
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
      // 加粗、强调是往选区两侧写 Markdown 标记符——在代码里那是两个星号
      // 插进源码，不是格式。纯文本没有可提供的行内格式。
      canFormat: this.#format === "markdown",
      canDeleteEmpty,
      selection: {
        start: selected.start,
        end: selected.end,
        quote: block.text.slice(selected.start, selected.end),
      },
      // 有选区时菜单只提选区内的转换：判定仍看着整块（邻居规则要读选区外的
      // 字符），但把选区外的 finding 摆进菜单，等于替作者决定了他没框选的字。
      punctuation: findingsWithin(punctuation, selected.start, selected.end),
      anchor: selected.anchor,
    };
  }

  formatSelection(kind: EditorFormat): boolean {
    // 行内标记是 Markdown 语法，纯文本文档没有可应用的格式。
    if (this.#format !== "markdown") return false;
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
    // 标点转换只属于散文；纯文本的 context() 本来也不产出 finding。
    if (this.#format !== "markdown") return false;
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
    // 全半角切换重写字面量：在代码里换 `、` 为 `,` 是改源码，不是排版。
    if (this.#format !== "markdown") return 0;
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
    this.#deferredTypeset.length = 0;
    this.#contextBlock = null;
    this.#contextSelection = null;
  }

  #paragraphFor(block: Block, typesetNow = true, placeholderHeight = 0): HTMLElement {
    const existing = this.#byId.get(block.id);
    if (existing !== undefined) return existing;
    const paragraph = this.#element.ownerDocument.createElement(BLOCK_TAG);
    paragraph.dataset.blockId = block.id;
    // Not editable individually: the manuscript is one editing host, so a
    // selection can cross paragraph boundaries. Per-paragraph contentEditable
    // makes each one its own host and the browser collapses any drag that
    // leaves it — the author watches the selection stop at the block edge.
    if (typesetNow) {
      this.#paintText(paragraph, block.text, block.isFence === true);
      paragraph.style.minHeight = "1em";
    } else {
      this.#paintDeferred(paragraph, block, placeholderHeight);
    }
    // `pre` 而不是 `pre-wrap`：折行由 `optimizedLineStarts` 决定，画成断行
    // 元素（见 inter-script-spacing.ts）。留着 `pre-wrap` 浏览器会在我们的
    // 断点之外**再**折一次，两套断点叠加，屏幕上只表现为「行短了一点」，
    // 而没有任何东西会报错。`verify:linebreak-takeover` 守住这个配对。
    //
    // 纯文本反过来：没有自研断行（`#paintText` 直接写 textContent），折行
    // 整个交给浏览器，所以是 `pre-wrap`。
    paragraph.style.whiteSpace = this.#format === "markdown" ? "pre" : "pre-wrap";
    paragraph.style.outline = "none";
    return paragraph;
  }

  /**
   * 视口带之外的块的占位画法。
   *
   * 文本原样进 DOM——`textContent` 逐字节等于块文本，光标定位、选区、复制、
   * 保存从头到尾可用；占位的只是「画」：`content-visibility: hidden` 让浏览器
   * 跳过这一块内容的布局（这是省下的那笔钱），高度索引给的占位高度撑住滚动条。
   * 真正的排版由 `#upgradeDeferredTypeset` 在后续帧里补。
   */
  #paintDeferred(paragraph: HTMLElement, block: Block, placeholderHeight: number): void {
    paragraph.textContent = block.text;
    paragraph.style.minHeight = `${Math.max(1, Math.round(placeholderHeight))}px`;
    paragraph.style.contentVisibility = "hidden";
    // 重画判据读 measureEm：占位也是按当前版心占的，版心变了要重新决策
    // （那时可能落进带内而立即排版）。
    paragraph.dataset.measureEm = String(this.#measureEm());
    if (paragraph.dataset.deferredTypeset === undefined) {
      paragraph.dataset.deferredTypeset = "";
      this.#deferredTypeset.push(block.id);
    }
    this.#scheduleTypesetUpgrade();
  }

  /** 撤掉占位，恢复成普通段落。幂等：没挂占位的段落什么都不做。 */
  #clearDeferred(paragraph: HTMLElement): void {
    if (paragraph.dataset.deferredTypeset === undefined) return;
    delete paragraph.dataset.deferredTypeset;
    paragraph.style.contentVisibility = "";
    paragraph.style.minHeight = "1em";
  }

  /**
   * 视口带：当前视口向上下各扩一屏，与 WINDOW_SCREENS 的余量同一个想法。
   *
   * 容器还没量出高度时返回 null——那一帧里一切按「在带内」处理，不做延后，
   * 否则整稿会先空白一帧。
   */
  #viewportBand(): { readonly start: number; readonly end: number } | null {
    const height = this.#scrollHost.clientHeight;
    if (height <= 0) return null;
    const top = this.#scrollHost.scrollTop;
    return { start: top - height, end: top + height * 2 };
  }

  /** 这块的估计位置与视口带有没有交集。高度索引本来就在维护这些估计值。 */
  #inViewportBand(index: number, band: { readonly start: number; readonly end: number }): boolean {
    const offset = this.#heightIndex.prefix(index);
    const extent = this.#heightIndex.span(index, index + 1);
    return offset + extent >= band.start && offset <= band.end;
  }

  /** 整稿字符数——延后排版的开关。只在非虚拟稿上被问，至多四百块。 */
  #documentTextLength(): number {
    let total = 0;
    for (const block of this.#blocks) total += block.text.length;
    return total;
  }

  #scheduleTypesetUpgrade(): void {
    if (this.#destroyed || this.#frames.typeset !== null) return;
    this.#frames.typeset = this.#view.requestAnimationFrame(() => {
      this.#frames.typeset = null;
      this.#upgradeDeferredTypeset();
    });
  }

  /**
   * 把占位块逐块补成真正的排版，每帧一个时间预算，带内的块优先。
   *
   * 三条不动的守卫，与围栏着色同一组理由：组合输入期间整批停手（动 DOM 会
   * 丢掉 IME 的预编辑串，`compositionend` 会重新武装队列）；光标所在的段落
   * 不碰（活动光标下的 span 重排会让编辑器跟作者打架，它回到队尾等下一轮）；
   * 文本漂了的条目直接丢弃（重画判据会走正常路径处理）。
   */
  #upgradeDeferredTypeset(): void {
    if (this.#destroyed || this.#interaction.kind === "composing") return;
    const band = this.#viewportBand();
    const started = this.#view.performance.now();
    let painted = false;
    // 整整一圈只有「光标占用」这一种跳过时停手，等 selectionchange 重新武装。
    let stalls = this.#deferredTypeset.length;
    while (
      this.#deferredTypeset.length > 0 &&
      stalls > 0 &&
      this.#view.performance.now() - started < TYPESET_UPGRADE_BUDGET_MS
    ) {
      let queueIndex = 0;
      if (band !== null) {
        const inBand = this.#deferredTypeset.findIndex((id) => {
          const index = this.#indexOf(id);
          return index >= 0 && this.#inViewportBand(index, band);
        });
        if (inBand >= 0) queueIndex = inBand;
      }
      const id = this.#deferredTypeset.splice(queueIndex, 1)[0];
      if (id === undefined) break;
      const paragraph = this.#byId.get(id);
      const block = this.#known(id);
      if (
        paragraph === undefined ||
        block === undefined ||
        paragraph.dataset.deferredTypeset === undefined ||
        paragraph.textContent !== block.text
      ) {
        continue;
      }
      if (paragraph === this.#paragraphAtCaret()) {
        this.#deferredTypeset.push(id);
        stalls -= 1;
        continue;
      }
      stalls = this.#deferredTypeset.length;
      this.#paintText(paragraph, block.text, block.isFence === true);
      this.#clearDeferred(paragraph);
      // 着色在渲染循环里是单独一步（异步分词），升级路径照做一遍。
      if (this.#isHighlightable(block) && paragraph.dataset.highlighted !== block.text) {
        void this.#highlightBlock(paragraph, block);
      }
      this.#measuredHeights.delete(id);
      painted = true;
    }
    if (painted) {
      // 排版替换了段落子树：投影（批注、印点、改动着色）按渲染循环的尾巴补一遍。
      this.#projectAnnotations();
      this.#syncProposalMarks();
      this.#projectChangeHighlights();
      this.#scheduleMeasurement();
    }
    if (this.#deferredTypeset.length > 0 && stalls > 0) this.#scheduleTypesetUpgrade();
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
   * Whether this block takes grammar highlighting at all. Markdown colours
   * its fences only; a plain-text document colours every block with the
   * document's one grammar.
   */
  #isHighlightable(block: Block): boolean {
    if (this.#format === "markdown") return block.isFence === true;
    return documentLanguage(this.#format) !== null;
  }

  /**
   * Colour a block by the document's format: Markdown routes its fence
   * (diagrams included), plain text routes the whole document's grammar.
   */
  async #highlightBlock(paragraph: HTMLElement, block: Block): Promise<void> {
    if (this.#format === "markdown") {
      await this.#highlightFence(paragraph, block);
      return;
    }
    const language = documentLanguage(this.#format);
    if (language === null) return;
    await this.#highlightTokens(paragraph, block, block.text, language);
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
    // 图表判据必须在 `#fenceLanguage` **之前**：那个函数带着 `isHighlightable`
    // 过滤，而高亮器根本没注册 mermaid/nomnoml，图表围栏在它眼里是 null。
    const declared = block.isFence === true ? declaredFenceLanguage(block.text) : null;
    if (declared !== null && isDiagramLanguage(declared)) {
      this.#renderDiagram(paragraph, block, declared);
      return;
    }

    const language = this.#fenceLanguage(block);
    if (language === null) return;
    await this.#highlightTokens(paragraph, block, block.text, language);
  }

  /**
   * The shared tail of fence and plain-document highlighting: tokenise
   * `code` with `language`, then swap the paragraph's text for one span per
   * token — only while the author is not inside the paragraph, no
   * composition is in flight, and the text the tokens came from still
   * stands.
   */
  async #highlightTokens(
    paragraph: HTMLElement,
    block: Block,
    code: string,
    language: string,
  ): Promise<void> {
    const before = block.text;
    const lines = await tokenizeCode(code, language, this.#codeTheme);
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
   * 图表围栏画成 SVG。
   *
   * # SVG 是旁挂的，源文本一个字节都不动
   *
   * 代码高亮把段落内容整个换成染色的 span——那对代码是对的（染色不改字节）。
   * 图表不行：一张图和它的源码是两种东西，把源码换成图就等于让作者失去了
   * 编辑它的入口，光标也无处可落。
   *
   * 所以 SVG 挂在段落**内部末尾**（一个 `contentEditable=false` 的子元素），
   * 源文本仍在段落里原样待着。代价是屏幕上源码与图同时出现；收益是光标、
   * 选区、改动着色、断行四处一个字都不用改——与表格选等宽对齐同一个理由。
   *
   * 曾经把它挂成段落的**兄弟**，图当场消失且一点痕迹都不留（实测：SVG 生成
   * 成功 2408 字节、`after()` 也调了，门禁仍报「零张图」）。原因在渲染循环
   * 末尾那个清扫：不在 `ordered` 里的子节点一律 `remove()`，而 `ordered` 只
   * 收段落与占位。子元素则安全——渲染循环不进段落内部。
   *
   * # 画不出来时保留原文
   *
   * 语法错、图种不支持、库抛异常，三种情况都退回「只显示源码」。图表画不出
   * 不该让作者的文字消失。
   */
  #renderDiagram(paragraph: HTMLElement, block: Block, language: string): void {
    // 与 `#highlightFence` 同一组守卫：作者正在这一段里打字时不要动 DOM。
    if (this.#interaction.kind === "composing") return;
    if (paragraph === this.#paragraphAtCaret()) return;

    const source = this.#fenceBody(block);
    const document_ = paragraph.ownerDocument;
    const existing = paragraph.nextElementSibling;
    const mounted =
      existing instanceof HTMLElement && existing.dataset.diagramFor === block.id ? existing : null;
    // 源码没变就不重画。重画会让图闪一下，而作者可能只是改了别的段落。
    if (mounted?.dataset.diagramSource === source) return;

    const rendered = renderDiagram(source, language, this.#diagramColours());
    if (rendered.kind === "unsupported") {
      // 画不出来就把已有的图撤掉——留着一张过期的图比没有图更误导。
      mounted?.remove();
      paragraph.dataset.diagramFallback = rendered.reason;
      return;
    }
    delete paragraph.dataset.diagramFallback;

    const host = mounted ?? document_.createElement("div");
    host.className = "md-diagram";
    host.dataset.diagramFor = block.id;
    host.dataset.diagramSource = source;
    // 图不进编辑坐标系：光标不该能落进 SVG 里。
    host.contentEditable = "false";
    // 不走 `innerHTML`：`verify:no-html-sink` 守着「手稿是用户输入，HTML 字符串
    // 进 DOM 就是一条执行路径」。这里的 SVG 虽然由 nomnoml 生成而非作者直接
    // 写的，但作者的文字**在里面**（节点标签），而且给这条规则开一个例外等于
    // 让后来者以为它可以有例外。
    //
    // `DOMParser` 解析成 SVG 文档再 `importNode` 搬过来：解析出的文档是惰性的
    // ——脚本不执行、外部资源不加载。
    const parsed = new DOMParser().parseFromString(rendered.svg, "image/svg+xml");
    const root = parsed.documentElement;
    // 解析失败时 documentElement 是 `<parsererror>`，把它搬进来会在版面上留下
    // 一段红色报错文字。
    if (root.nodeName === "parsererror" || root.nodeName.toLowerCase() !== "svg") {
      mounted?.remove();
      paragraph.dataset.diagramFallback = "图表 SVG 解析失败";
      return;
    }
    host.replaceChildren(document_.importNode(root, true));
    if (mounted === null) paragraph.after(host);
  }

  /**
   * 围栏里的正文——去掉 ``` 那两行。
   *
   * 图表库要的是图的源码，把 ``` 一起喂进去它会当成语法错。
   */
  #fenceBody(block: Block): string {
    const lines = block.text.split("\n");
    const start = lines[0]?.startsWith("```") === true ? 1 : 0;
    const end =
      lines.length > start && lines[lines.length - 1]?.trim() === "```"
        ? lines.length - 1
        : lines.length;
    return lines.slice(start, end).join("\n");
  }

  /**
   * 图表配色：从当前主题的 CSS 自定义属性解析出实际色值。
   *
   * 不写死颜色——写死会让图在夜间主题里刺眼，而且那是第二个配色权威。七套
   * 主题各自的四锚点已经定义了纸墨印，图跟着它们走。
   */
  #diagramColours(): { fill: string; stroke: string; text: string; font: string } {
    const styles = getComputedStyle(this.#element);
    const read = (name: string, fallback: string): string => {
      const value = styles.getPropertyValue(name).trim();
      return value === "" ? fallback : value;
    };
    return {
      fill: read("--paper-raised", "#f9f3e7"),
      stroke: read("--ink-soft", "#405d89"),
      text: read("--ink", "#19345c"),
      font: read("--font-sans", "sans-serif"),
    };
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
    if (this.#destroyed) return;
    // 升级队列可能正停在光标占用的那块上——光标动了就再试一次。
    if (this.#deferredTypeset.length > 0) this.#scheduleTypesetUpgrade();
    if (this.#selectionListeners.length === 0) return;
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

    // 视口带之外的延后排版。只在非虚拟稿上启用：虚拟稿的窗口本来就只挂一屏
    // 的块。整稿字符数越过 DEFER_TYPESET_TOTAL 时，挂载不再同步排完整稿——
    // 带内的块照常排版，带外的块挂占位，由升级队列在后续帧里补。
    const band = virtual ? null : this.#viewportBand();
    const deferOffBand =
      band !== null && !virtual && this.#documentTextLength() > DEFER_TYPESET_TOTAL;

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
        const near = !deferOffBand || (band !== null && this.#inViewportBand(index, band));
        let paragraph = previous.get(block.id);
        if (paragraph === undefined) {
          paragraph = this.#paragraphFor(block, near, this.#heightIndex.span(index, index + 1));
        }
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
          if (near) {
            this.#paintText(paragraph, block.text, block.isFence === true);
            this.#clearDeferred(paragraph);
          } else {
            this.#paintDeferred(paragraph, block, this.#heightIndex.span(index, index + 1));
          }
          delete paragraph.dataset.highlighted;
        }
        // A block the author is not inside gets coloured. The caret's own
        // paragraph stays plain text: spans under an active caret are what
        // makes an editor fight its author.
        if (paragraph === activeParagraph) {
          if (paragraph.dataset.highlighted !== undefined) {
            paragraph.textContent = block.text;
            delete paragraph.dataset.highlighted;
          }
        } else if (
          this.#isHighlightable(block) &&
          paragraph.dataset.deferredTypeset === undefined &&
          paragraph.dataset.highlighted !== block.text
        ) {
          // 占位中的块不排队分词：升级时自会走这一步（见升级队列）。否则
          // 挂载会为看不见的块付全部分词的钱，延后排版就白做了。
          void this.#highlightBlock(paragraph, block);
        }
        this.#byId.set(block.id, paragraph);
        ordered.push(paragraph);
        // 图表 SVG 是段落的兄弟节点，必须一并列进 `ordered`——末尾那个清扫
        // 循环会把不在列表里的子节点全部 `remove()`。曾经漏了这一步，现象是
        // 图生成成功（实测 2408 字节）、`after()` 也调了，屏幕上却什么都没有，
        // 而且不留任何痕迹。
        //
        // 图必须是兄弟而不是段落的子元素：十几处代码把 `paragraph.textContent`
        // 当作块文本读（第 1442 行的重画判据、光标偏移、改动着色区间）。SVG 的
        // 文字混进去会让那个判据恒真，段落每帧重画、图每帧被删再重建。
        const diagram = paragraph.nextElementSibling;
        if (diagram instanceof HTMLElement && diagram.dataset.diagramFor === block.id) {
          ordered.push(diagram);
        }
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
      // 占位块的高度是估计值撑出来的 min-height，不是量出来的——把它记进
      // measuredHeights 会让估计穿上「实测」的外衣，升级之后反而没人纠正。
      if (paragraph.dataset.deferredTypeset !== undefined) continue;
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
    // Markdown 不能落一个空块（扫描器给不出块的文本会被拒），所以行首
    // 按 Enter 是删掉本块、行尾按 Enter 时插一个带空格的占位块。纯文本里
    // 空行本来就是合法的块：行首的 Enter 留一个空行在上，行尾的 Enter
    // 留一个空行在下。
    const splitHead = this.#format === "markdown" && head === "" ? null : head;
    const splitTail = this.#format === "markdown" && tail === "" ? " " : tail;
    this.#submit([
      { kind: "replace", blocks: [id], text: splitHead },
      { kind: "insert", before: after, texts: [splitTail] },
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
      // 与 `#onPaste` 同一条多块判据：Markdown 看空行，纯文本看换行。
      const multiBlock = this.#format === "markdown" ? /\n\s*\n/.test(text) : text.includes("\n");
      if (span !== null || multiBlock) {
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

  /**
   * 多行文本切成块。规则收在模块级的 `splitPastedText`：Markdown 按空行
   * 分段，纯文本按行切、缩进与空行不动。
   */
  #pastedParts(text: string): string[] {
    return splitPastedText(text, this.#format);
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
    const parts = this.#pastedParts(text);
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
    // Markdown 的多块意味着空行；纯文本的多块就是多行。
    const multiBlock = this.#format === "markdown" ? /\n\s*\n/.test(text) : text.includes("\n");
    if (!multiBlock) return;
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
    const pasted = this.#pastedParts(text);
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
    if (this.#deferredTypeset.length > 0) this.#scheduleTypesetUpgrade();
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
    if (this.#destroyed) return;
    if (this.#blocks.length <= VIRTUALIZE_AFTER) {
      // 非虚拟稿的窗口不随滚动重建，但延后排版的队列要按新的视口带优先补
      // 眼前的块。
      if (this.#deferredTypeset.length > 0) this.#scheduleTypesetUpgrade();
      return;
    }
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
