<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue templates use these bindings.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type AppearanceConfig,
  commands,
  type PreferencesChangeDto,
} from "../generated/bindings.gen";
import IconPicker from "./IconPicker.vue";
import ShortcutsPanel from "./ShortcutsPanel.vue";
import ThemePicker from "./ThemePicker.vue";
import TypographyPanel from "./TypographyPanel.vue";

const props = withDefaults(
  defineProps<{
    returnLabel?: string;
  }>(),
  { returnLabel: "工作台" },
);

const emit = defineEmits<{
  closed: [];
  themePicked: [slug: string];
}>();

const SECTIONS = [
  { id: "appearance", label: "外观", detail: "主题、纸面与入口图标" },
  { id: "typography", label: "排版", detail: "字体、字号与行距" },
  { id: "shortcuts", label: "快捷键", detail: "当前可用的键盘操作" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

const section = ref<Section>("appearance");
const entered = ref<AppearanceConfig | null>(null);
const changed = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const status = ref("更改会立即保存");
const contentRevision = ref(0);
let stopConfig: UnlistenFn | null = null;

const current = computed(() => SECTIONS.find((entry) => entry.id === section.value) ?? SECTIONS[0]);
const canReset = computed(() => section.value !== "shortcuts" && !busy.value);

const apply = async (change: PreferencesChangeDto, message: string): Promise<void> => {
  busy.value = true;
  try {
    const snapshot = await unwrap(commands.updatePreferences(change));
    emit("themePicked", snapshot.config.appearance.theme);
    error.value = null;
    status.value = message;
    contentRevision.value += 1;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
};

const resetCurrent = async (): Promise<void> => {
  switch (section.value) {
    case "appearance":
      await apply({ kind: "resetVisual" }, "外观已恢复默认");
      return;
    case "typography":
      await apply({ kind: "resetTypography" }, "排版已恢复默认");
      return;
    case "shortcuts":
      return;
  }
};

const undoSession = async (): Promise<void> => {
  if (!entered.value) return;
  await apply(
    { kind: "restoreAppearance", value: structuredClone(entered.value) },
    "已撤销本次调整",
  );
  changed.value = false;
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  emit("closed");
};

onMounted(async () => {
  try {
    const snapshot = await unwrap(commands.readConfig());
    entered.value = structuredClone(snapshot.config.appearance);
    stopConfig = await listen("config-changed", () => {
      changed.value = true;
      status.value = "已保存";
    });
    window.addEventListener("keydown", onKeydown);
  } catch (cause) {
    error.value = describe(cause);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  stopConfig?.();
});
</script>

<template>
  <section class="settings" aria-labelledby="settings-title">
    <div class="settings-frame">
      <header class="settings-hero">
        <button class="settings-back" type="button" @click="emit('closed')">
          <span aria-hidden="true">←</span>
          返回 {{ props.returnLabel }}
        </button>
        <div class="settings-heading">
          <span class="settings-eyebrow">工作环境</span>
          <h2 id="settings-title">设置</h2>
          <p>调整阅读与写作环境。每项更改会自动保存在这台电脑中。</p>
        </div>
        <div class="settings-actions">
          <span class="settings-status" aria-live="polite">{{ status }}</span>
          <button
            v-if="section !== 'shortcuts'"
            type="button"
            :disabled="!canReset"
            @click="resetCurrent"
          >
            恢复本页默认
          </button>
          <button type="button" :disabled="!changed || busy" @click="undoSession">
            撤销本次调整
          </button>
          <button class="primary" type="button" @click="emit('closed')">完成</button>
        </div>
      </header>

      <nav class="settings-tabs" aria-label="设置分类" role="tablist">
        <button
          v-for="entry in SECTIONS"
          :key="entry.id"
          type="button"
          role="tab"
          :aria-selected="section === entry.id"
          :class="{ current: section === entry.id }"
          @click="section = entry.id"
        >
          <span>{{ entry.label }}</span>
          <small>{{ entry.detail }}</small>
        </button>
      </nav>

      <div class="settings-panel" role="tabpanel" :aria-label="current.label">
        <div v-if="section === 'appearance'" class="settings-grid" :key="`visual-${contentRevision}`">
          <article class="settings-card settings-card-wide">
            <div class="card-heading">
              <span>阅读环境</span>
              <p>选择整套色彩与纸面边界。选择本身就是预览。</p>
            </div>
            <ThemePicker @picked="(slug: string) => emit('themePicked', slug)" />
          </article>
          <article class="settings-card">
            <div class="card-heading">
              <span>写作入口图标</span>
              <p>替换编辑区写作入口的图形。RefRain Logo 不受影响。</p>
            </div>
            <div class="icon-setting">
              <IconPicker />
              <span>PNG 或 SVG</span>
            </div>
          </article>
        </div>

        <article
          v-else-if="section === 'typography'"
          class="settings-card typography-card"
          :key="`type-${contentRevision}`"
        >
          <div class="card-heading">
            <span>手稿排版</span>
            <p>分别指定西文、中文与日文字体，再决定共享汉字优先由哪一槽绘制。</p>
          </div>
          <TypographyPanel />
        </article>

        <article v-else class="settings-card shortcuts-card">
          <div class="card-heading">
            <span>键盘操作</span>
            <p>这里只列出已经生效的操作。当前版本不提供无效的改键开关。</p>
          </div>
          <ShortcutsPanel />
        </article>
      </div>

      <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.settings {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  background:
    linear-gradient(120deg, color-mix(in oklab, var(--seal-wash) 28%, transparent), transparent 42%),
    var(--paper);
  padding: clamp(28px, 5vw, 64px);
}

.settings-frame {
  width: min(1040px, 100%);
  margin: 0 auto;
}

.settings-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px 40px;
  align-items: end;
}

.settings-back {
  grid-column: 1 / -1;
  justify-self: start;
  border: 0;
  padding: 0;
  color: var(--ink-soft);
  background: transparent;
  font-size: 12px;
}

.settings-back:hover:not(:disabled) {
  color: var(--seal);
  background: transparent;
}

.settings-back span {
  margin-right: 8px;
}

.settings-heading {
  min-width: 0;
}

.settings-eyebrow {
  display: block;
  margin-bottom: 8px;
  color: var(--seal);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}

.settings-heading h2 {
  margin: 0;
  font-family: var(--display);
  font-size: clamp(34px, 5vw, 58px);
  font-weight: 400;
  letter-spacing: 0.08em;
  line-height: 1;
}

.settings-heading p {
  margin: 14px 0 0;
  color: var(--ink-soft);
  font-family: var(--serif);
  font-size: 14px;
}

.settings-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  max-width: 520px;
}

.settings-actions button {
  min-height: 34px;
  padding-inline: 13px;
}

.settings-status {
  width: 100%;
  color: var(--ink-faint);
  font-size: 11px;
  text-align: right;
}

.settings-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-top: 42px;
  border-bottom: 1px solid var(--rule-strong);
}

.settings-tabs button {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  border: 0;
  border-radius: 0;
  padding: 14px 4px 16px;
  color: var(--ink-faint);
  background: transparent;
  text-align: left;
}

.settings-tabs button::after {
  position: absolute;
  right: 0;
  bottom: -1px;
  left: 0;
  height: 2px;
  background: transparent;
  content: "";
}

.settings-tabs button.current {
  color: var(--ink);
}

.settings-tabs button.current::after {
  background: var(--seal);
}

.settings-tabs button:hover:not(:disabled) {
  color: var(--ink);
  background: transparent;
}

.settings-tabs button > span {
  font-size: 15px;
  font-weight: 650;
}

.settings-tabs small {
  color: var(--ink-faint);
  font-size: 11px;
}

.settings-panel {
  padding-top: 26px;
}

.settings-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(220px, 0.75fr);
  gap: 18px;
}

.settings-card {
  min-width: 0;
  border: 1px solid var(--rule);
  border-radius: 10px;
  background: color-mix(in oklab, var(--paper-raised) 92%, transparent);
  padding: clamp(20px, 3vw, 30px);
  box-shadow: 0 18px 48px color-mix(in oklab, var(--ink) 5%, transparent);
}

.card-heading {
  margin-bottom: 18px;
  padding-bottom: 15px;
  border-bottom: 1px solid var(--rule);
}

.card-heading > span {
  font-size: 15px;
  font-weight: 650;
}

.card-heading p {
  margin: 6px 0 0;
  color: var(--ink-faint);
  font-size: 12px;
  line-height: 1.55;
}

.icon-setting {
  display: flex;
  align-items: center;
  gap: 12px;
}

.icon-setting > span {
  color: var(--ink-faint);
  font-size: 11px;
}

.typography-card,
.shortcuts-card {
  width: min(760px, 100%);
}

.settings-error {
  margin: 18px 0 0;
  color: var(--refused);
  font-size: 12px;
}

@media (max-width: 920px) {
  .settings {
    padding: 24px;
  }

  .settings-hero {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .settings-actions {
    justify-content: flex-start;
    max-width: none;
  }

  .settings-status {
    text-align: left;
  }

  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
