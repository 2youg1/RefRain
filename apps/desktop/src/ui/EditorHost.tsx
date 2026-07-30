// The only module that mounts packages/editor (SPEC 9.10). It translates the
// adapter's changes into bridge DTOs and the domain's confirmations back into
// projection updates. It holds no state machine; the queue it keeps is the
// bounded pending-action queue of SPEC 7.2-5.

import {
  type EditorAction,
  type EditorAnnotationProjection,
  type EditorContext,
  type EditorDocument,
  type EditorFormat,
  type EditorHandle,
  mountEditor,
  type PunctuationFinding,
} from "@refrain/editor";
import { createEffect, onCleanup, onMount } from "solid-js";
import { describe, unwrap } from "../bridge";
import { EditorActionQueue } from "../editor-host/editor-action-queue";
import { cancelScheduledFrame, scheduleFrame } from "../frame-scheduler";
import {
  commands,
  type EditorChangeDto,
  type OpenDocumentDto_Serialize,
} from "../generated/bindings.gen";

/**
 * What the shell may ask of the open editor.
 *
 * Vue exposed these through `defineExpose`, which let any parent reach in by
 * name. Naming the surface as a type makes the seam checkable: the shell can
 * only call what appears here.
 */
export interface EditorHostHandle {
  focus(): void;
  isComposing(): boolean;
  caret(): { blockId: string; offset: number } | null;
  formatSelection(kind: EditorFormat): boolean;
  deleteEmptyBlock(): boolean;
  applyPunctuation(finding: PunctuationFinding): boolean;
  /** Resolve once no composition is in flight — an event, never a timer. */
  whenSettled(): Promise<void>;
  /** Resolve after the pending-action queue fully drains. */
  settled(): Promise<void>;
}

export interface EditorHostProps {
  readonly rootId: string;
  readonly path: string;
  readonly document: OpenDocumentDto_Serialize;
  readonly annotations: readonly EditorAnnotationProjection[];
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

export function EditorHost(props: EditorHostProps) {
  let host: HTMLDivElement | undefined;
  let editor: EditorHandle | null = null;
  let confirmedRevision = props.document.revision;
  const confirmationFrame = `editor-confirm:${props.rootId}:${props.path}`;

  const apply = async (action: EditorAction): Promise<void> => {
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
    confirmedRevision = transition.revision;
    editor?.setRevision(transition.revision);
    if (structural) {
      const confirmed = await unwrap(commands.currentDocument(props.rootId, props.path));
      editor?.replace({ revision: confirmed.revision, blocks: confirmed.blocks });
      editor?.focus();
    }
    props.onConfirmed(transition.revision);
  };

  const actions = new EditorActionQueue(
    apply,
    (task) => scheduleFrame(confirmationFrame, task),
    (error) => props.onRejected(describe(error)),
  );

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

  onMount(() => {
    if (host === undefined) return;
    const document: EditorDocument = {
      revision: props.document.revision,
      blocks: props.document.blocks,
    };
    editor = mountEditor(host, document, { submit: (action) => actions.submit(action) });
    editor.setAnnotations(props.annotations);
    editor.focus();
    props.onReady({
      focus: () => editor?.focus(),
      isComposing: () => editor?.isComposing() ?? false,
      caret: () => editor?.caret() ?? null,
      formatSelection: (kind) => editor?.formatSelection(kind) ?? false,
      deleteEmptyBlock: () => editor?.deleteEmptyBlock() ?? false,
      applyPunctuation: (finding) => editor?.applyPunctuation(finding) ?? false,
      whenSettled: async () => {
        await editor?.whenSettled();
      },
      settled: async () => {
        await editor?.whenSettled();
        await actions.settled();
      },
    });
  });

  createEffect(() => {
    editor?.setAnnotations(props.annotations);
  });

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
