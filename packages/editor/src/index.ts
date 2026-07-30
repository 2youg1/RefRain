/**
 * Framework-free direct DOM adapter.
 *
 * Rust owns canonical manuscript bytes. This package owns one browser
 * projection and sends settled edits back only as `EditorAction`. Markdown is
 * never reparsed here. `VirtualManuscriptView` hides virtualization, selection,
 * IME, measurement, scroll anchoring, and frame lifecycle from callers.
 */

import type { Block, EditorChange, EditorDocument, EditorHandle, EditorPort } from "./model";
import { VirtualManuscriptView } from "./virtual-manuscript-view";

export type {
  Block,
  EditorAction,
  EditorChange,
  EditorDocument,
  EditorHandle,
  EditorPort,
} from "./model";
export { applyLocally } from "./projection";

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
    isComposing() {
      return view.isComposing();
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
