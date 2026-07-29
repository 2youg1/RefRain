<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// The theme picker (SPEC 9.8 + D12): the list is generated, the write goes to
// the single Config, and the choice projects immediately. The paper row is the
// manuscript sheet's three edges: none / hairline / paper.
import { onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import { commands, type PaperMode, type ThemeInfoDto } from "../generated/bindings.gen";

const emit = defineEmits<{
  picked: [slug: string];
}>();

const themes = ref<ThemeInfoDto[]>([]);
const activeTheme = ref<string | null>(null);
const paper = ref<PaperMode>("hairline");
const error = ref<string | null>(null);

const PAPERS: { value: PaperMode; label: string; title: string }[] = [
  { value: "none", label: "无", title: "纸面：无边缘" },
  { value: "hairline", label: "细", title: "纸面：细边" },
  { value: "paper", label: "纸", title: "纸面：纸张" },
];

onMounted(async () => {
  try {
    themes.value = await commands.listThemes();
    const snapshot = await unwrap(commands.readConfig());
    activeTheme.value = snapshot.config.appearance.theme;
    paper.value = snapshot.config.appearance.paper;
  } catch (cause) {
    error.value = describe(cause);
  }
});

const pick = async (slug: string): Promise<void> => {
  try {
    await unwrap(commands.updatePreferences({ kind: "setTheme", value: slug }));
    activeTheme.value = slug;
    emit("picked", slug);
  } catch (cause) {
    error.value = describe(cause);
  }
};

const pickPaper = async (mode: PaperMode): Promise<void> => {
  try {
    await unwrap(commands.updatePreferences({ kind: "setPaper", value: mode }));
    paper.value = mode;
  } catch (cause) {
    error.value = describe(cause);
  }
};
</script>

<template>
  <div class="theme-picker" aria-label="主题">
    <div class="picker-block">
      <span class="picker-name">主题</span>
      <div class="picker-row">
        <button
          v-for="theme in themes"
          :key="theme.slug"
          type="button"
          :class="{ current: theme.slug === activeTheme }"
          :data-theme-slug="theme.slug"
          :title="theme.slug"
          @click="pick(theme.slug)"
        >
          {{ theme.cn }}
        </button>
      </div>
    </div>
    <div class="picker-block">
      <span class="picker-name">纸面</span>
      <div class="picker-row" aria-label="纸面">
        <button
          v-for="mode in PAPERS"
          :key="mode.value"
          type="button"
          :class="{ current: mode.value === paper }"
          :data-paper-mode="mode.value"
          :title="mode.title"
          @click="pickPaper(mode.value)"
        >
          {{ mode.label }}
        </button>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style>
.theme-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}

.theme-picker .picker-block {
  display: flex;
  align-items: center;
  gap: 10px;
}

.theme-picker .picker-name {
  color: var(--ink-faint);
  flex: none;
  font-size: 13px;
}

.theme-picker .picker-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.theme-picker button.current {
  border-color: var(--seal);
  color: var(--seal);
}

.theme-picker .error {
  margin: 0;
  font-size: 12px;
  color: var(--pending);
}
</style>
