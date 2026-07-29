<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// The shortcut table (SPEC 9.9 投影): display-only — every chord the shell
// currently answers, grouped by where it works. Remapping is not a v0.2
// feature; this page exists so the chords are discoverable, not configurable.
const GROUPS: { name: string; rows: [string, string][] }[] = [
  {
    name: "写作",
    rows: [
      ["Ctrl+S", "保存"],
      ["Ctrl+Enter", "进出 KARA"],
    ],
  },
  {
    name: "裁决（Review 内）",
    rows: [
      ["Alt+J / Alt+K", "下一条 / 上一条"],
      ["Alt+A", "采用"],
      ["Alt+X", "拒绝"],
      ["Alt+E", "改后接受"],
      ["Alt+R", "理由"],
      ["Alt+S", "入批 / 出批"],
      ["Alt+P", "换看竞争稿"],
      ["Alt+Enter", "合并入批"],
    ],
  },
];
</script>

<template>
  <div class="shortcuts">
    <div v-for="group in GROUPS" :key="group.name" class="group">
      <span class="group-name">{{ group.name }}</span>
      <div v-for="row in group.rows" :key="row[0]" class="row">
        <span class="action">{{ row[1] }}</span>
        <kbd>{{ row[0] }}</kbd>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcuts {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 0;
}

.group-name {
  display: block;
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--ink-faint);
  padding-bottom: 4px;
}

.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
}

kbd {
  font-family: var(--mono);
  font-size: 11px;
  border: 1px solid var(--rule);
  border-radius: 3px;
  padding: 2px 8px;
  color: var(--ink-soft);
}
</style>
