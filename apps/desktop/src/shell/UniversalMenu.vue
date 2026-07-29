<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue templates use these bindings.
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  filterCommands,
  type WorkbenchCommand,
  type WorkbenchCommandGroup,
  type WorkbenchCommandId,
} from "./workbench-commands";

const props = defineProps<{ entries: readonly WorkbenchCommand[] }>();
const emit = defineEmits<{ choose: [id: WorkbenchCommandId]; close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const query = ref("");
const cursor = ref(0);
const visible = computed(() => filterCommands(props.entries, query.value));
const GROUP_NAME: Record<WorkbenchCommandGroup, string> = {
  continue: "继续当前工作",
  project: "项目",
  work: "工作",
  reference: "资料与连接",
  agents: "Agents",
  appearance: "外观",
  application: "应用",
};
const groups = computed(() => {
  const rows = new Map<WorkbenchCommandGroup, WorkbenchCommand[]>();
  for (const entry of visible.value) {
    const current = rows.get(entry.group) ?? [];
    current.push(entry);
    rows.set(entry.group, current);
  }
  return [...rows.entries()].map(([id, entries]) => ({ id, label: GROUP_NAME[id], entries }));
});

const choose = (entry: WorkbenchCommand): void => {
  if (!entry.available) return;
  emit("choose", entry.id);
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Tab") {
    const focusable = [
      ...(dialog.value?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []),
    ];
    if (focusable.length === 0) return;
    event.preventDefault();
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const delta = event.shiftKey ? -1 : 1;
    focusable[(current + delta + focusable.length) % focusable.length]?.focus();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    cursor.value =
      visible.value.length === 0
        ? 0
        : (cursor.value + delta + visible.value.length) % visible.value.length;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const entry = visible.value[cursor.value];
    if (entry) choose(entry);
  }
};

watch(visible, () => {
  cursor.value = 0;
});

onMounted(() => void nextTick(() => input.value?.focus()));
</script>

<template>
  <div class="command-backdrop" @pointerdown.self="emit('close')">
    <section
      ref="dialog"
      class="command-menu"
      role="dialog"
      aria-modal="true"
      aria-labelledby="command-title"
      @keydown.stop="onKeydown"
    >
      <h2 id="command-title">现在要做什么？</h2>
      <div class="command-search">
        <span aria-hidden="true">⌘</span>
        <input
          ref="input"
          v-model="query"
          type="search"
          autocomplete="off"
          placeholder="输入动作、对象或命令名"
          aria-label="搜索命令"
        />
        <kbd>Esc</kbd>
      </div>
      <div class="command-results" role="listbox" aria-label="命令">
        <template v-for="group in groups" :key="group.id">
          <h3>{{ group.label }}</h3>
          <button
            v-for="entry in group.entries"
            :key="entry.id"
            type="button"
            role="option"
            :aria-selected="visible[cursor]?.id === entry.id"
            :class="{ current: visible[cursor]?.id === entry.id }"
            :disabled="!entry.available"
            @pointerenter="cursor = visible.findIndex((candidate) => candidate.id === entry.id)"
            @click="choose(entry)"
          >
            <span>{{ entry.label }}</span>
            <small v-if="entry.nextStep">{{ entry.nextStep }}</small>
          </button>
        </template>
        <p v-if="visible.length === 0" class="command-empty">没有匹配动作。换一个对象或动词。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.command-backdrop {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: grid;
  align-items: start;
  justify-items: center;
  padding: 12vh 24px 24px;
  background: color-mix(in oklab, var(--ink) 16%, transparent);
}

.command-menu {
  width: min(520px, calc(100vw - 48px));
  max-height: 62vh;
  overflow: hidden;
  border: 1px solid var(--rule-strong);
  border-radius: 10px;
  color: var(--ink);
  background: var(--paper-raised);
  box-shadow: 0 30px 90px color-mix(in oklab, var(--ink) 24%, transparent);
  animation: command-in 140ms var(--ease);
}

.command-menu h2 {
  margin: 0;
  padding: 18px 20px 0;
  font-family: var(--display);
  font-size: 18px;
  font-weight: 500;
  letter-spacing: 0.05em;
}

.command-search {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  margin: 12px 14px 8px;
  border: 1px solid var(--rule-strong);
  border-radius: 7px;
  padding: 0 11px;
  background: var(--paper);
}

.command-search input {
  height: 40px;
  border: 0;
  padding: 0;
  background: transparent;
  outline: 0;
}

.command-search kbd {
  color: var(--ink-faint);
  font-family: var(--ui-font);
  font-size: 10px;
}

.command-results {
  max-height: calc(62vh - 104px);
  overflow-y: auto;
  padding: 6px 10px 12px;
}

.command-results h3 {
  margin: 7px 9px 2px;
  color: var(--ink-faint);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.16em;
  line-height: 1;
  text-transform: uppercase;
}

.command-results button {
  display: flex;
  width: 100%;
  min-height: 31px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  border: 0;
  padding: 5px 10px;
  text-align: left;
}

.command-results button.current:not(:disabled) {
  color: var(--seal);
  background: var(--seal-wash);
}

.command-results button:disabled {
  opacity: 1;
  color: var(--ink-faint);
}

.command-results small {
  color: var(--ink-faint);
  font-size: 10px;
  white-space: nowrap;
}

.command-empty {
  margin: 26px 10px;
  color: var(--ink-faint);
  font-size: 12px;
}

@keyframes command-in {
  from {
    transform: translateY(-4px);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .command-menu {
    animation-duration: 90ms;
  }
}

@media (max-height: 760px) {
  .command-menu h2 {
    padding-top: 13px;
    font-size: 16px;
  }

  .command-search {
    margin-top: 8px;
  }

  .command-search input {
    height: 36px;
  }

  .command-results {
    max-height: calc(62vh - 88px);
  }

  .command-results h3 {
    margin: 3px 9px 1px;
    font-size: 8px;
  }
}
</style>
