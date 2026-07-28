<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: `emit` is used in the template.
// The Safety surface for a changed-underneath conflict (SPEC 9.1: the only
// modal layer). Both versions are shown; the author chooses. Nothing is
// decided for them — silently winning would destroy an edit made elsewhere.
defineProps<{
  mine: string;
  theirs: string;
}>();

const emit = defineEmits<{
  resolve: [choice: "mine" | "theirs"];
}>();
</script>

<template>
  <dialog open class="safety" aria-label="保存冲突">
    <h2>磁盘上的版本已经变了</h2>
    <p>另一个程序（或另一次编辑）改了这个文件。选哪一版留下，由你决定。</p>
    <div class="sides">
      <section>
        <h3>我在这个窗口写的</h3>
        <pre>{{ mine }}</pre>
        <button type="button" @click="emit('resolve', 'mine')">用我的覆盖磁盘</button>
      </section>
      <section>
        <h3>磁盘上现在的</h3>
        <pre>{{ theirs }}</pre>
        <button type="button" @click="emit('resolve', 'theirs')">用磁盘的，丢弃我的</button>
      </section>
    </div>
  </dialog>
</template>

<style>
.safety {
  position: fixed;
  inset: 10vh 10vw;
  max-width: none;
  max-height: none;
  border: 1px solid color-mix(in oklab, currentColor 30%, transparent);
  border-radius: 8px;
  padding: 24px;
  background: var(--paper, #f7f5f0);
  overflow: auto;
}

.safety::backdrop {
  background: rgb(0 0 0 / 30%);
}

.sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.sides pre {
  max-height: 50vh;
  overflow: auto;
  padding: 12px;
  background: color-mix(in oklab, currentColor 5%, transparent);
  white-space: pre-wrap;
  font-size: 13px;
}
</style>
