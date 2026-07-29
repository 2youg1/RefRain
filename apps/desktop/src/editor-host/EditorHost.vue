<script setup lang="ts">
// The only module that mounts packages/editor (SPEC 9.10). It translates the
// adapter's changes into bridge DTOs and the domain's confirmations back into
// projection updates. It holds no state machine; the queue it keeps is the
// bounded pending-action queue of SPEC 7.2-5.

import {
  type EditorAction,
  type EditorDocument,
  type EditorHandle,
  mountEditor,
} from "@refrain/editor";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  commands,
  type EditorChangeDto,
  type OpenDocumentDto_Serialize,
} from "../generated/bindings.gen";

const props = defineProps<{
  rootId: string;
  path: string;
  document: OpenDocumentDto_Serialize;
}>();

const emit = defineEmits<{
  confirmed: [revision: string];
  rejected: [reason: string];
}>();

const host = ref<HTMLElement | null>(null);
let editor: EditorHandle | null = null;
// Confirmed-domain base for the next action: actions chain base → revision.
let confirmedRevision = props.document.revision;
// The bounded pending-action queue (SPEC 7.2-5): settles land here, one apply
// crosses the bridge at a time, and a save waits for the queue to drain.
// Without it two rapid settles race on the same base and all but the first
// are refused as stale — which is how typed characters once vanished.
let inFlight = false;
const queue: EditorAction[] = [];
const settled: { resolve: (() => void)[] } = { resolve: [] };

const toDto = (action: EditorAction): EditorChangeDto[] =>
  action.changes.map((change) =>
    change.kind === "replace"
      ? { kind: "replace", value: { blocks: [...change.blocks], text: change.text } }
      : {
          kind: "insert",
          value: { before: change.before, texts: [...change.texts] },
        },
  );

/** A typing burst on one block coalesces into one action. */
const tryMerge = (action: EditorAction): boolean => {
  const last = queue.at(-1);
  const only = action.changes.length === 1 ? action.changes[0] : undefined;
  const prev = last?.changes.length === 1 ? last.changes[0] : undefined;
  if (
    last === undefined ||
    only?.kind !== "replace" ||
    prev?.kind !== "replace" ||
    only.text === null ||
    prev.text === null ||
    only.blocks.length !== 1 ||
    prev.blocks.length !== 1 ||
    only.blocks[0] !== prev.blocks[0]
  ) {
    return false;
  }
  queue[queue.length - 1] = {
    baseRevision: last.baseRevision,
    changes: [{ kind: "replace", blocks: prev.blocks, text: only.text }],
  };
  return true;
};

const drain = async (): Promise<void> => {
  if (inFlight) return;
  const action = queue.shift();
  if (action === undefined) {
    for (const resolve of settled.resolve.splice(0)) resolve();
    return;
  }
  inFlight = true;
  const structural = action.changes.some(
    (change) =>
      (change.kind === "replace" && (change.text === null || change.blocks.length > 1)) ||
      change.kind === "insert",
  );
  try {
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
    emit("confirmed", transition.revision);
  } catch (error) {
    emit("rejected", describe(error));
  } finally {
    inFlight = false;
    void drain();
  }
};

const submit = (action: EditorAction): void => {
  if (!tryMerge(action)) queue.push(action);
  void drain();
};

onMounted(() => {
  if (!host.value) return;
  const document: EditorDocument = {
    revision: props.document.revision,
    blocks: props.document.blocks,
  };
  editor = mountEditor(host.value, document, { submit });
  editor.focus();
});

onBeforeUnmount(() => {
  editor?.destroy();
  editor = null;
});

defineExpose({
  focus: (): void => editor?.focus(),
  isComposing: () => editor?.isComposing() ?? false,
  caret: () => editor?.caret() ?? null,
  /** Resolves when the pending-action queue has fully drained (SPEC 7.2-5). */
  settled: (): Promise<void> =>
    queue.length === 0 && !inFlight
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          settled.resolve.push(resolve);
        }),
});
</script>

<template>
  <div class="editor-wrap">
    <div ref="host" class="editor-host" data-testid="editor-host" />
    <div class="hashira" aria-hidden="true">{{ path }}</div>
  </div>
</template>

<style>
.editor-wrap {
  position: relative;
  height: 100%;
  overflow-y: auto;
}

/* 柱（hashira）：和装本的书脊题名，竖写细墨，只在有边缘的纸面档出现。 */
.hashira {
  display: none;
  position: fixed;
  top: 84px;
  right: max(16px, calc((100vw - var(--manuscript-measure, 30em) - 96px) / 2 - 24px));
  writing-mode: vertical-rl;
  font-family: var(--serif);
  font-size: 12px;
  letter-spacing: 0.34em;
  color: var(--ink-ghost);
  user-select: none;
  pointer-events: none;
}

:root[data-paper="hairline"] .hashira,
:root:not([data-paper]) .hashira,
:root[data-paper="paper"] .hashira {
  display: block;
}

@media (max-width: 780px) {
  .hashira {
    display: none;
  }
}

/* 版心三档（SPEC 9.8，data-paper 由 App.vue 从 Config 投影）：
 * 无 —— Web 模式，无边缘，只留文字下的行线；
 * 细边 —— 默认，发丝边界，无影；
 * 纸张 —— 边框加影，给从 Word 来的作者一张看得见的纸。 */
.editor-host {
  width: min(calc(var(--manuscript-measure, 30em) + 96px), calc(100% - 56px));
  max-width: none;
  margin: 0 auto;
  padding: var(--page-top-padding, 3rem) 48px var(--page-bottom-padding, 50vh);
  line-height: var(--manuscript-leading, 1.9);
  font-size: var(--manuscript-size, 17px);
  font-family: var(--manuscript-family, var(--serif));
  font-weight: var(--manuscript-weight, 400);
  letter-spacing: var(--manuscript-tracking, 0.01em);
  word-spacing: var(--manuscript-word-spacing, 0);
  text-align: var(--manuscript-align, left);
  hanging-punctuation: allow-end last;
  text-spacing-trim: trim-start;
  font-feature-settings:
    "halt" 1,
    "vhal" 1;
  font-variant-east-asian: proportional-width;
}

:root[data-paper="none"] .editor-host p[data-block-id] {
  border-bottom: 1px solid color-mix(in oklab, var(--ink) 9%, transparent);
  padding-bottom: 0.4em;
}

:root[data-paper="hairline"] .editor-host,
:root:not([data-paper]) .editor-host {
  background: var(--sheet);
  border-left: 1px solid var(--rule);
  border-right: 1px solid var(--rule);
  margin-top: 28px;
  min-height: calc(100vh - var(--chrome-height) - var(--status-height) - 28px);
}

:root[data-paper="paper"] .editor-host {
  background: var(--sheet);
  border: 1px solid var(--rule);
  border-radius: 2px;
  margin: 28px auto;
  min-height: calc(100vh - var(--chrome-height) - var(--status-height) - 56px);
  box-shadow:
    0 1px 2px color-mix(in oklab, var(--ink) 6%, transparent),
    0 14px 36px color-mix(in oklab, var(--ink) 9%, transparent);
}

.editor-host p[data-block-id] {
  cursor: text;
  caret-color: var(--caret);
  margin: 0 0 var(--paragraph-gap, 1.9em);
  text-indent: var(--manuscript-indent, 0);
}

.editor-host p[data-block-id]:last-child {
  margin-bottom: 0;
}

:root[data-baseline-grid="on"] .editor-host p[data-block-id] {
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(var(--rule-at) - 1px),
    color-mix(in oklab, var(--seal) 22%, transparent) calc(var(--rule-at) - 1px),
    color-mix(in oklab, var(--seal) 22%, transparent) var(--rule-at),
    transparent var(--rule-at),
    transparent var(--grid-period)
  );
}
</style>
