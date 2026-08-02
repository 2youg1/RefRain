// The only module that mounts packages/editor (SPEC 9.10). It translates the
// adapter's changes into bridge DTOs and the domain's confirmations back into
// projection updates. It holds no state machine; the queue it keeps is the
// bounded pending-action queue of SPEC 7.2-5.

import {
  type BlockPrefix,
  type CodeTheme,
  type EditorAction,
  type EditorAnnotationProjection,
  type EditorContext,
  type EditorDocument,
  type EditorFormat,
  type EditorHandle,
  mountEditor,
  type ProposalMark,
  type PunctuationFinding,
  type SelectionMeasure,
} from "@refrain/editor";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { describe, unwrap } from "../bridge";
import { EditorActionQueue } from "../editor-host/editor-action-queue";
import { cancelScheduledFrame, scheduleFrame } from "../frame-scheduler";
import {
  commands,
  type EditorChangeDto,
  type OpenDocumentDto_Serialize,
  type SessionDocumentDto,
  type TextTransitionDto,
} from "../generated/bindings.gen";
import { useKara } from "../shell/kara-state";

/**
 * What the shell may ask of the open editor.
 *
 * The old shell exposed these to any parent, which let it reach in by
 * name. Naming the surface as a type makes the seam checkable: the shell can
 * only call what appears here.
 */
export interface EditorHostHandle {
  focus(): void;
  /**
   * Put the caret in a named block — how a search hit becomes a place.
   *
   * The shell knows which block matched, not where it sits on screen. Without
   * this the author lands at the top of the document and searches again by eye,
   * which is the reading the hit list was meant to spare him.
   */
  focusBlock(blockId: string, offset: number): void;
  isComposing(): boolean;
  caret(): { blockId: string; offset: number } | null;
  formatSelection(kind: EditorFormat): boolean;
  deleteEmptyBlock(): boolean;
  applyPunctuation(finding: PunctuationFinding): boolean;
  /** Toggle a block-level Markdown prefix on the block holding the caret. */
  applyBlockPrefix(prefix: BlockPrefix): boolean;
  /** Resolve once no composition is in flight — an event, never a timer. */
  whenSettled(): Promise<void>;
  /** Resolve after the pending-action queue fully drains. */
  settled(): Promise<void>;
  /** Observe how much text is selected, for the status line's readout. */
  onSelectionMeasured(listener: (measure: SelectionMeasure | null) => void): () => void;
  /** A block's screen rect, for pinning the bento next to its anchor. */
  blockRect(blockId: string): DOMRect | null;
  /**
   * 全文标点一键切换：内核把所有块收进一个 EditorAction 提交，
   * 所以壳层的一次撤销（Ctrl+Z）就能把整份稿子还原。
   */
  convertPunctuationEverywhere(): number;
  /**
   * 采纳一次壳层得来的转移（撤销）。不走 `apply`——那一条会先向桥上
   * 提交行动，而撤销是桥上已经完成的动作，这里只差回读与换稿。
   */
  acceptTransition(transition: TextTransitionDto): Promise<void>;
}

export interface EditorHostProps {
  readonly rootId: string;
  readonly path: string;
  readonly document: OpenDocumentDto_Serialize;
  readonly annotations: readonly EditorAnnotationProjection[];
  /** 段落右缘的提案印点；点开一枚就是一次饭盒裁决。 */
  readonly proposalMarks?: readonly ProposalMark[] | undefined;
  readonly onProposalMark?: ((id: string) => void) | undefined;
  /** The code palette in force; the shell projects it from Config. */
  readonly codeTheme?: CodeTheme | undefined;
  readonly onConfirmed: (revision: string) => void;
  readonly onRejected: (reason: string) => void;
  readonly onContext: (context: EditorContext, pointerX: number, pointerY: number) => void;
  /** Receives the handle on mount and null on teardown. */
  readonly onReady: (handle: EditorHostHandle | null) => void;
}

const toDto = (action: EditorAction): EditorChangeDto[] =>
  action.changes.map((change) =>
    change.kind === "replace"
      ? { kind: "replace", value: { blocks: [...change.blocks], text: change.text } }
      : { kind: "insert", value: { before: change.before, texts: [...change.texts] } },
  );

/**
 * 回读确认头。`apply` 的结构改动分支与壳层发起的撤销走的是同一条回读；
 * 提成模块级函数，组件体里的桥接计数才不用为撤销上调（棘轮见
 * verify:component-depth 的 BRIDGE_DEBT）。
 */
const readConfirmed = (rootId: string, path: string): Promise<SessionDocumentDto> =>
  unwrap(commands.currentDocument(rootId, path));

export function EditorHost(props: EditorHostProps) {
  const kara = useKara();
  let host: HTMLDivElement | undefined;
  let editor: EditorHandle | null = null;
  let confirmedRevision = props.document.revision;
  // One key per mounted host, not per document: the host outlives a document
  // switch, and a stale pending frame must be cancellable after the switch.
  const confirmationFrame = `editor-confirm:${crypto.randomUUID()}`;
  // A remount while a confirmation is in flight must invalidate that
  // confirmation: its revision belongs to the document being closed, and
  // applying it here would mark the new document dirty with foreign state.
  let mountEpoch = 0;

  const apply = async (action: EditorAction): Promise<void> => {
    const epoch = mountEpoch;
    const structural = action.changes.some(
      (change) =>
        (change.kind === "replace" && (change.text === null || change.blocks.length > 1)) ||
        change.kind === "insert",
    );
    const transition = await unwrap(
      commands.applyEditorAction(props.rootId, props.path, {
        base: confirmedRevision,
        changes: toDto(action),
      }),
    );
    if (epoch !== mountEpoch) return;
    confirmedRevision = transition.revision;
    editor?.setRevision(transition.revision);
    if (structural) {
      const confirmed = await unwrap(commands.currentDocument(props.rootId, props.path));
      if (epoch !== mountEpoch) return;
      // The view restores the caret itself: it knows the structural edit's
      // intended target, while a blind focus() lands on the first block.
      editor?.replace({ revision: confirmed.revision, blocks: confirmed.blocks });
    }
    props.onConfirmed(transition.revision);
  };

  // The queue's lifetime is one document's editing session: the actions it
  // holds are based on that document's revision and mean nothing after a
  // switch. It is rebuilt with the editor rather than reset, so there is no
  // "emptied but reusable" state for anyone to reason about.
  let actions = newQueue();

  function newQueue(): EditorActionQueue {
    return new EditorActionQueue(
      apply,
      (task) => scheduleFrame(confirmationFrame, task),
      (error) => props.onRejected(describe(error)),
    );
  }

  const onContextMenu = (event: MouseEvent): void => {
    // Candidate text is not settled manuscript text: refuse rather than act
    // on characters the author has not chosen yet.
    if (editor?.isComposing()) {
      event.preventDefault();
      return;
    }
    const context = editor?.context(event.target);
    if (context === null || context === undefined) return;
    event.preventDefault();
    props.onContext(context, event.clientX, event.clientY);
  };

  /**
   * Mount the editor for whichever document is open now, tearing down the
   * previous one first.
   *
   * A different manuscript is a different editor. Callers place this component
   * under a `<Show>` that stays truthy across a switch, so Solid reuses the
   * instance and `onMount` never runs a second time — the previous manuscript
   * would stay on screen while `rootId`/`path` already point at the new one,
   * and the next keystroke would be submitted against the previous document's
   * revision, into the new document's path. Owning the remount here keeps that
   * invariant true no matter how the caller writes its control flow.
   */
  const remount = (): void => {
    if (host === undefined) return;
    mountEpoch += 1;
    // Drop work owed to the document being closed: its revision is gone.
    actions.destroy();
    cancelScheduledFrame(confirmationFrame);
    editor?.destroy();
    actions = newQueue();
    // The host element is reused: only the editor's internal DOM is rebuilt.
    confirmedRevision = props.document.revision;
    const document: EditorDocument = {
      revision: props.document.revision,
      blocks: props.document.blocks,
      format: props.document.format, // 缺省即 markdown，行为与旧版逐字节一致
    };
    editor = mountEditor(host, document, { submit: (action) => actions.submit(action) });
    editor.setAnnotations(props.annotations);
    editor.setProposalMarks(props.proposalMarks ?? []);
    editor.onProposalMark((id) => props.onProposalMark?.(id));
    if (props.codeTheme !== undefined) editor.setCodeTheme(props.codeTheme);
    editor.setDiffPresentation(kara.engaged.value ? "result" : "marks");
    editor.focus();
    props.onReady({
      focus: () => editor?.focus(),
      focusBlock: (blockId, offset) => editor?.focus(blockId, offset),
      isComposing: () => editor?.isComposing() ?? false,
      caret: () => editor?.caret() ?? null,
      formatSelection: (kind) => editor?.formatSelection(kind) ?? false,
      deleteEmptyBlock: () => editor?.deleteEmptyBlock() ?? false,
      applyPunctuation: (finding) => editor?.applyPunctuation(finding) ?? false,
      applyBlockPrefix: (prefix) => editor?.applyBlockPrefix(prefix) ?? false,
      whenSettled: async () => {
        await editor?.whenSettled();
      },
      settled: async () => {
        await editor?.whenSettled();
        await actions.settled();
      },
      onSelectionMeasured: (listener) => editor?.onSelectionMeasured(listener) ?? (() => {}),
      blockRect: (blockId) => editor?.blockRect(blockId) ?? null,
      convertPunctuationEverywhere: () => editor?.convertPunctuationEverywhere() ?? 0,
      acceptTransition: async (transition) => {
        const epoch = mountEpoch;
        // 撤销回来的文本可能增删块，所以总是整稿回读——与 apply() 的
        // 结构改动分支同一条路，视图 replace 时自己恢复光标。
        const confirmed = await readConfirmed(props.rootId, props.path);
        if (epoch !== mountEpoch) return;
        confirmedRevision = transition.revision;
        editor?.setRevision(transition.revision);
        // 渲染永不覆盖光标所在段（那是给正在输入的作者的保护）。撤销改写的
        // 恰恰是正文而不是输入——先撤掉选区，这次换稿才没有「正在输入」的段。
        host?.ownerDocument.getSelection()?.removeAllRanges();
        editor?.replace({ revision: confirmed.revision, blocks: confirmed.blocks });
        // 光标落到被撤掉的那一步所在的第一段：作者要知道刚才收回的是哪里。
        const touched = transition.touchedBlocks[0];
        if (touched !== undefined) editor?.focus(touched, 0);
        props.onConfirmed(transition.revision);
      },
    });
  };

  onMount(remount);

  // Identity, not the DTO: the same document re-read produces a new object, and
  // rebuilding the editor for that would discard the author's caret mid-save.
  createEffect(
    on(
      () => `${props.rootId}\u0000${props.path}`,
      () => remount(),
      { defer: true },
    ),
  );

  createEffect(() => {
    editor?.setAnnotations(props.annotations);
  });

  createEffect(() => {
    editor?.setProposalMarks(props.proposalMarks ?? []);
  });

  createEffect(() => {
    const theme = props.codeTheme;
    if (theme !== undefined) editor?.setCodeTheme(theme);
  });

  /**
   * Kara 期间改动着色只画成品，不堆叠增删标记（KL9 2026-08-01 裁定）。
   *
   * 直接订阅 `useKara()` 而不是让 Workbench 转发一个 prop：那台状态机是模块级
   * 单例（`kara-state.ts` 明写「第二次调用共享同一台机器」），多一层转发只是
   * 把同一个事实再抄一遍，而抄件与正本漂开时没有任何东西会报错。
   *
   * `packages/editor` 仍然不认识 Kara——它只知道「这份判定画成哪一种」。
   * 认识 Kara 的是外壳，而这个文件属于外壳。
   */
  onCleanup(
    kara.subscribe(() => {
      editor?.setDiffPresentation(kara.engaged.value ? "result" : "marks");
    }),
  );

  onCleanup(() => {
    props.onReady(null);
    actions.destroy();
    cancelScheduledFrame(confirmationFrame);
    editor?.destroy();
    editor = null;
  });

  return (
    <div class="editor-wrap">
      {/* The editor owns focus through its contenteditable paragraph descendants. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: custom editor event boundary */}
      <div ref={host} class="editor-host" data-testid="editor-host" onContextMenu={onContextMenu} />
      <div class="hashira" aria-hidden="true">
        {props.path}
      </div>
    </div>
  );
}
