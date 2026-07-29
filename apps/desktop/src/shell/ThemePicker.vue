<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: `pick` is used in the template.
// The theme picker (SPEC 9.8 + D12): the list is generated, the write goes to
// the single Config, and the choice projects immediately. No preview games:
// the author sees the real theme the moment they pick it.
import { onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import { commands, type ThemeInfoDto } from "../generated/bindings.gen";

const emit = defineEmits<{
  picked: [slug: string];
}>();

const themes = ref<ThemeInfoDto[]>([]);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    themes.value = await commands.listThemes();
  } catch (cause) {
    error.value = describe(cause);
  }
});

const pick = async (slug: string): Promise<void> => {
  try {
    await unwrap(commands.updatePreferences({ kind: "setTheme", value: slug }));
    emit("picked", slug);
  } catch (cause) {
    error.value = describe(cause);
  }
};
</script>

<template>
  <div class="theme-picker" aria-label="主题">
    <button
      v-for="theme in themes"
      :key="theme.slug"
      type="button"
      :data-theme-slug="theme.slug"
      :title="theme.slug"
      @click="pick(theme.slug)"
    >
      {{ theme.cn }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style>
.theme-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 16px;
  padding: 8px;
  border-top: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}

.theme-picker button {
  all: unset;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 13px;
}

.theme-picker button:hover {
  background: color-mix(in oklab, currentColor 10%, transparent);
}

.theme-picker .error {
  width: 100%;
  font-size: 12px;
  color: #8a4b00;
}
</style>
