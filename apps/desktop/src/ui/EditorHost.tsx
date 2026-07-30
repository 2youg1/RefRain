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
import { createEffect, on, onCleanup, onMount } from "solid-js";
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
  // One key per mounted host, not per document: the host outlives a document
  // switch, and a stale pending frame must be cancellable after the switch.
  const confirmationFrame = `editor-confirm:${crypto.randomUUID()}`;

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
