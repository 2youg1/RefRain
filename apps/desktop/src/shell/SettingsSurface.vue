<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// The Settings surface (SPEC 9.8): appearance choices are not writing tools,
// so they live off the rail — 外观 (theme / paper / icon), 排版 (type), and
// 快捷键 (the chords the shell answers), all writing the one Config.
import { ref } from "vue";
import IconPicker from "./IconPicker.vue";
import ShortcutsPanel from "./ShortcutsPanel.vue";
import ThemePicker from "./ThemePicker.vue";
import TypographyPanel from "./TypographyPanel.vue";

const emit = defineEmits<{
  closed: [];
  themePicked: [slug: string];
}>();

type Tab = "外观" | "排版" | "快捷键";
const TABS: Tab[] = ["外观", "排版", "快捷键"];
const tab = ref<Tab>("外观");
</script>

<template>
  <section class="settings" aria-label="设置">
    <h2 class="settings-title">设置</h2>
    <div class="settings-body">
      <nav class="settings-tabs" aria-label="设置分类">
        <button
          v-for="entry in TABS"
          :key="entry"
          type="button"
          :class="{ current: tab === entry }"
          @click="tab = entry"
        >
          {{ entry }}
        </button>
      </nav>
      <div class="settings-content">
        <template v-if="tab === '外观'">
          <ThemePicker @picked="(slug: string) => emit('themePicked', slug)" />
          <div class="setting">
            <span class="setting-name">图标</span>
            <IconPicker />
          </div>
        </template>
        <TypographyPanel v-else-if="tab === '排版'" />
        <ShortcutsPanel v-else />
        <button type="button" class="settings-close" @click="emit('closed')">收起</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings {
  border-left: 1px solid var(--rule);
  background: var(--paper-raised);
  padding: 20px 24px;
  font-size: 13px;
  width: 480px;
  max-width: 56vw;
  overflow-y: auto;
}

.settings-title {
  font-size: 18px;
  font-weight: 400;
  letter-spacing: 0.3em;
  margin: 0 0 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.settings-body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.settings-tabs {
  display: flex;
  flex-direction: column;
  flex: none;
}

.settings-tabs button {
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0;
  text-align: left;
  padding: 6px 12px 6px 10px;
  color: var(--ink-faint);
}

.settings-tabs button.current {
  color: var(--ink);
  border-left-color: var(--seal);
}

.settings-content {
  flex: 1;
  min-width: 0;
  border-left: 1px solid var(--rule);
  padding-left: 20px;
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
  margin-top: 16px;
  color: var(--ink-faint);
}
</style>
