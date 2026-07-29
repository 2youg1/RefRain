<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: `text` is rendered in the template.
// The 28px status line (SPEC 9.9): save state left, path right. It renders a
// compiled state; it infers nothing.
import { computed } from "vue";

const props = defineProps<{
  state: { kind: "clean" | "dirty" | "saving" | "failed"; reason?: string };
  path: string | null;
}>();

const text = computed(() => {
  switch (props.state.kind) {
    case "clean":
      return "已保存";
    case "dirty":
      return "未保存";
    case "saving":
      return "保存中…";
    case "failed":
      return `保存失败:${props.state.reason ?? "未知原因"}`;
  }
});
</script>

<template>
  <footer class="status-line">
    <span :class="{ failed: state.kind === 'failed' }">{{ text }}</span>
    <span class="path">{{ path ?? "" }}</span>
  </footer>
</template>

<style>
.status-line {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: 26px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  color: var(--ink-faint);
  background: var(--paper);
  border-top: 1px solid var(--rule);
}

.status-line .failed {
  color: var(--refused);
}

.status-line .path {
  font-family: var(--mono);
  font-size: 11px;
}
</style>
