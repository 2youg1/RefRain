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
// Structural changes are unconfirmed until the domain answers; settles during
// that window are refused by id, so none are offered (SPEC 7.2-5).
let structuralPending = false;

const toDto = (action: EditorAction): EditorChangeDto[] =>
  action.changes.map((change) =>
    change.kind === "replace"
      ? { kind: "replace", value: { blocks: [...change.blocks], text: change.text } }
      : {
          kind: "insert",
          value: { before: change.before, texts: [...change.texts] },
        },
  );

const submit = (action: EditorAction): void => {
  if (structuralPending) return;
  const structural = action.changes.some(
    (change) =>
      (change.kind === "replace" && (change.text === null || change.blocks.length > 1)) ||
      change.kind === "insert",
  );
  if (structural) structuralPending = true;
  void (async () => {
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
      structuralPending = false;
    }
  })();
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
  isComposing: () => editor?.isComposing() ?? false,
  caret: () => editor?.caret() ?? null,
});
</script>

<template>
  <div ref="host" class="editor-host" data-testid="editor-host" />
</template>

<style>
.editor-host {
  max-width: 680px;
  margin: 0 auto;
  padding: 48px 24px;
  line-height: 1.75;
  font-size: 17px;
}

.editor-host p[data-block-id] {
  cursor: text;
  caret-color: var(--ink);
}
</style>
