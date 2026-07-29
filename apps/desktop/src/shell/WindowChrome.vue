<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue templates use these bindings.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { cancelScheduledFrame, scheduleFrame } from "../frame-scheduler";
import { commands, type DisplayProfile } from "../generated/bindings.gen";
import LogoMark from "./LogoMark.vue";

const props = withDefaults(
  defineProps<{
    title?: string;
  }>(),
  { title: "RefRain" },
);

const emit = defineEmits<{
  closeRequested: [];
  error: [message: string];
}>();

const windowHandle = getCurrentWindow();
const maximized = ref(false);
const fullscreen = ref(false);
const unlisten: Array<() => void> = [];

const report = (error: unknown): void => {
  emit("error", error instanceof Error ? error.message : String(error));
};

const publishDisplay = (profile: DisplayProfile): void => {
  scheduleFrame("window.display-profile", () => {
    const root = document.documentElement;
    root.style.setProperty("--display-refresh-hz", String(profile.refreshHz));
    root.style.setProperty("--frame-budget-ms", `${profile.frameBudgetMs}ms`);
    root.style.setProperty("--hairline", `${profile.hairlineCssPx}px`);
    root.dataset.refreshMeasured = String(profile.refreshMeasured);
  });
};

const syncDisplay = async (): Promise<void> => {
  publishDisplay(await commands.displayProfile());
};

const syncWindowState = async (): Promise<void> => {
  [maximized.value, fullscreen.value] = await Promise.all([
    windowHandle.isMaximized(),
    windowHandle.isFullscreen(),
  ]);
};

const sync = async (): Promise<void> => {
  await Promise.all([syncDisplay(), syncWindowState()]);
};

const scheduleDisplaySync = (): void => {
  scheduleFrame("window.display-read", () => void syncDisplay().catch(report));
};

const scheduleWindowStateSync = (): void => {
  scheduleFrame("window.state-read", () => void syncWindowState().catch(report));
};

const minimize = (): void => {
  void windowHandle.minimize().catch(report);
};

const toggleMaximize = (): void => {
  void windowHandle.toggleMaximize().then(syncWindowState).catch(report);
};

const toggleFullscreen = (): void => {
  void windowHandle.setFullscreen(!fullscreen.value).then(syncWindowState).catch(report);
};

const onTitlebarDoubleClick = (event: MouseEvent): void => {
  if (event.target instanceof Element && event.target.closest(".window-actions")) return;
  toggleMaximize();
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key !== "F11") return;
  event.preventDefault();
  toggleFullscreen();
};

onMounted(() => {
  void sync().catch(report);
  window.addEventListener("keydown", onKeydown);
  void windowHandle.onResized(scheduleWindowStateSync).then((stop) => unlisten.push(stop));
  void windowHandle.onMoved(scheduleDisplaySync).then((stop) => unlisten.push(stop));
  void windowHandle.onScaleChanged(scheduleDisplaySync).then((stop) => unlisten.push(stop));
  void windowHandle
    .onCloseRequested((event) => {
      event.preventDefault();
      emit("closeRequested");
    })
    .then((stop) => unlisten.push(stop));
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  cancelScheduledFrame("window.display-profile");
  cancelScheduledFrame("window.display-read");
  cancelScheduledFrame("window.state-read");
  for (const stop of unlisten) stop();
});
</script>

<template>
  <header class="window-chrome" data-tauri-drag-region @dblclick="onTitlebarDoubleClick">
    <div class="brand" data-tauri-drag-region>
      <LogoMark :size="24" />
      <span class="wordmark" data-tauri-drag-region>RefRain</span>
      <span v-if="props.title !== 'RefRain'" class="document-title" data-tauri-drag-region>
        {{ props.title }}
      </span>
    </div>
    <nav class="window-actions" aria-label="窗口控制">
      <button type="button" aria-label="最小化" title="最小化" @click="minimize">
        <span class="minimize-glyph" aria-hidden="true" />
      </button>
      <button
        type="button"
        :aria-label="maximized ? '还原窗口' : '最大化窗口'"
        :title="maximized ? '还原窗口' : '最大化窗口'"
        @click="toggleMaximize"
      >
        <span :class="['maximize-glyph', { restored: maximized }]" aria-hidden="true" />
      </button>
      <button
        type="button"
        :aria-label="fullscreen ? '退出全屏' : '进入全屏'"
        :title="fullscreen ? '退出全屏（F11）' : '进入全屏（F11）'"
        @click="toggleFullscreen"
      >
        <span :class="['fullscreen-glyph', { active: fullscreen }]" aria-hidden="true" />
      </button>
      <button class="close" type="button" aria-label="关闭" title="关闭" @click="emit('closeRequested')">
        <span class="close-glyph" aria-hidden="true" />
      </button>
    </nav>
  </header>
</template>

<style scoped>
.window-chrome {
  position: fixed;
  z-index: 80;
  inset: 0 0 auto;
  height: var(--chrome-height);
  display: flex;
  align-items: stretch;
  color: var(--ink);
  background: color-mix(in srgb, var(--paper) 96%, transparent);
  border-bottom: var(--hairline, 1px) solid var(--hair);
  user-select: none;
  backdrop-filter: blur(16px);
}

.brand {
  min-width: 0;
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  padding-left: 12px;
}

.wordmark {
  font-family: var(--ui-font);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.08em;
}

.document-title {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-title::before {
  content: "/";
  margin-right: 8px;
  color: var(--hair);
}


.window-actions {
  display: flex;
  height: 100%;
}

.window-actions button {
  position: relative;
  width: 46px;
  border: 0;
  border-radius: 0;
  color: currentColor;
  background: transparent;
}

.window-actions button:hover {
  color: var(--ink);
  background: var(--hover);
}

.window-actions button:focus-visible {
  z-index: 1;
  outline: 2px solid var(--seal);
  outline-offset: -2px;
}

.window-actions .close:hover {
  color: white;
  background: #c42b1c;
}

.minimize-glyph,
.maximize-glyph,
.fullscreen-glyph,
.close-glyph,
.close-glyph::after {
  position: absolute;
  inset: 50% auto auto 50%;
  width: 10px;
  height: 10px;
  content: "";
  transform: translate(-50%, -50%);
}

.minimize-glyph {
  height: 1px;
  background: currentColor;
}

.maximize-glyph {
  border: 1px solid currentColor;
}

.maximize-glyph.restored::after {
  position: absolute;
  inset: -4px -4px auto auto;
  width: 7px;
  height: 7px;
  border: 1px solid currentColor;
  border-bottom: 0;
  border-left: 0;
  content: "";
}

.fullscreen-glyph {
  width: 12px;
  height: 12px;
  background:
    linear-gradient(currentColor, currentColor) left top / 5px 1px no-repeat,
    linear-gradient(currentColor, currentColor) left top / 1px 5px no-repeat,
    linear-gradient(currentColor, currentColor) right top / 5px 1px no-repeat,
    linear-gradient(currentColor, currentColor) right top / 1px 5px no-repeat,
    linear-gradient(currentColor, currentColor) left bottom / 5px 1px no-repeat,
    linear-gradient(currentColor, currentColor) left bottom / 1px 5px no-repeat,
    linear-gradient(currentColor, currentColor) right bottom / 5px 1px no-repeat,
    linear-gradient(currentColor, currentColor) right bottom / 1px 5px no-repeat;
}

.fullscreen-glyph.active {
  transform: translate(-50%, -50%) scale(0.75);
}

.close-glyph,
.close-glyph::after {
  height: 1px;
  background: currentColor;
  transform: translate(-50%, -50%) rotate(45deg);
}

.close-glyph::after {
  inset: 0;
  transform: rotate(90deg);
}
</style>
