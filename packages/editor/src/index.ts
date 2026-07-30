/**
 * Framework-free direct DOM adapter.
 *
 * Rust owns canonical manuscript bytes. This package owns one browser
 * projection and sends settled edits back only as `EditorAction`. Markdown is
 * never reparsed here. `VirtualManuscriptView` hides virtualization, selection,
 * IME, measurement, scroll anchoring, and frame lifecycle from callers.
 */

import type {
  Block,
  BlockPrefix,
  EditorAnnotationProjection,
  EditorChange,
  EditorDocument,
  EditorFormat,
  EditorHandle,
  EditorPort,
  PunctuationFinding,
  SelectionMeasure,
} from "./model";
import { VirtualManuscriptView } from "./virtual-manuscript-view";

export type {
  Block,
  BlockPrefix,
  EditorAction,
  EditorAnnotationProjection,
  EditorChange,
  EditorContext,
  EditorDocument,
  EditorFormat,
  EditorHandle,
  EditorPort,
  PunctuationFinding,
  SelectionMeasure,
} from "./model";
export { applyLocally } from "./projection";
export { findPunctuation } from "./punctuation";

/** Mount one editor projection. The returned handle is its complete interface. */
export function mountEditor(
  element: HTMLElement,
  document: EditorDocument,
  port: EditorPort,
): EditorHandle {
  let revision = document.revision;
  const view = new VirtualManuscriptView(element, document.blocks, (changes) => {
    port.submit({ baseRevision: revision, changes });
  });

  return {
    setRevision(next) {
      revision = next;
    },
    replace(next) {
      revision = next.revision;
      view.replace(next.blocks);
    },
    focus(blockId, offset) {
      view.focus(blockId, offset);
    },
    caret() {
      return view.caret();
    },
    context(target) {
      return view.context(target);
    },
    formatSelection(kind: EditorFormat) {
      return view.formatSelection(kind);
    },
    deleteEmptyBlock() {
      return view.deleteEmptyBlock();
    },
    applyPunctuation(finding: PunctuationFinding) {
      return view.applyPunctuation(finding);
    },
    onSelectionMeasured(listener: (measure: SelectionMeasure | null) => void) {
      return view.onSelectionMeasured(listener);
    },
    applyBlockPrefix(prefix: BlockPrefix) {
      return view.applyBlockPrefix(prefix);
    },
    setAnnotations(annotations: readonly EditorAnnotationProjection[]) {
      view.setAnnotations(annotations);
    },
    isComposing() {
      return view.isComposing();
    },
    whenSettled() {
      return view.whenSettled();
    },
    destroy() {
      view.destroy();
    },
  };
}

/** Preserve block identity across a replacement. */
export function replaceText(block: Block, text: string): EditorChange {
  return { kind: "replace", blocks: [block.id], text };
}
