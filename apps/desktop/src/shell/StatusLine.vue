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
    <span class="state" :data-kind="state.kind">
      <span class="dot" aria-hidden="true"></span>{{ text }}
    </span>
    <span class="path">{{ path ?? "" }}</span>
  </footer>
</template>

<style>
.status-line {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  height: var(--status-height, 26px);
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  color: var(--ink-faint);
  background: var(--paper);
  border-top: 1px solid var(--rule);
  z-index: 70;
  visibility: visible;
  transition:
    opacity 240ms var(--ease),
    visibility 0s;
}

.status-line.dimmed {
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition:
    opacity 240ms var(--ease),
    visibility 0s 240ms;
}

.status-line .state {
  display: flex;
  align-items: center;
  gap: 7px;
}

.status-line .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ink-ghost);
}

.status-line .state[data-kind="dirty"] .dot,
.status-line .state[data-kind="saving"] .dot {
  background: var(--pending);
}

.status-line .state[data-kind="failed"] {
  color: var(--refused);
}

.status-line .state[data-kind="failed"] .dot {
  background: var(--refused);
}

.status-line .path {
  font-family: var(--mono);
  font-size: 11px;
}
</style>
