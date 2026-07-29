<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// The Settings surface (SPEC 9.8): appearance choices are not writing tools,
// so they live off the rail — theme, the sheet's three edges, and the
// Universal Button icon, all writing the one Config.
import IconPicker from "./IconPicker.vue";
import ThemePicker from "./ThemePicker.vue";

const emit = defineEmits<{
  closed: [];
  themePicked: [slug: string];
}>();
</script>

<template>
  <section class="settings" aria-label="设置">
    <div class="blocks-head"><span>设置</span></div>
    <ThemePicker @picked="(slug: string) => emit('themePicked', slug)" />
    <div class="setting">
      <span class="setting-name">图标</span>
      <IconPicker />
    </div>
    <button type="button" class="settings-close" @click="emit('closed')">收起</button>
  </section>
</template>

<style scoped>
.settings {
  border-left: 1px solid var(--rule);
  background: var(--paper-raised);
  padding: 12px 16px;
  font-size: 13px;
  max-width: 520px;
  min-width: 360px;
  overflow-y: auto;
}

.blocks-head {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  color: var(--ink-faint);
}

.setting {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--rule);
}

.setting-name {
  color: var(--ink-faint);
  flex: none;
}

.settings-close {
  margin-top: 12px;
  color: var(--ink-faint);
}
</style>
