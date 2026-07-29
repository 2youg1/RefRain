<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue templates use these bindings.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { describe } from "../bridge";
import { commands } from "../generated/bindings.gen";
import LogoMark from "./LogoMark.vue";
import { iconDataUrl } from "./universal-icon";

const emit = defineEmits<{ activate: [] }>();
const revealed = ref(false);
const iconUrl = ref<string | null>(null);
const error = ref<string | null>(null);
let stopConfig: UnlistenFn | null = null;
let hideTimer: number | null = null;
let disposed = false;

const refresh = async (): Promise<void> => {
  try {
    const bytes = await commands.universalIcon();
    if (!disposed) iconUrl.value = bytes === null ? null : iconDataUrl(bytes);
  } catch (cause) {
    if (!disposed) error.value = describe(cause);
  }
};

const reveal = (): void => {
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  revealed.value = true;
};

const scheduleHide = (event: PointerEvent): void => {
  const zone = event.currentTarget as HTMLElement;
  if (zone.contains(document.activeElement)) return;
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    revealed.value = false;
  }, 240);
};

const activate = (): void => {
  revealed.value = false;
  emit("activate");
};

onMounted(async () => {
  try {
    await refresh();
    const stop = await listen("config-changed", () => void refresh());
    if (disposed) stop();
    else stopConfig = stop;
  } catch (cause) {
    if (!disposed) error.value = describe(cause);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  stopConfig?.();
  if (hideTimer !== null) window.clearTimeout(hideTimer);
});
</script>

<template>
  <div class="universal-hot-zone" aria-hidden="true" @pointerenter="reveal"></div>
  <div
    class="universal-button-zone"
    :class="{ revealed }"
    @pointerenter="reveal"
    @pointerleave="scheduleHide"
  >
    <button
      type="button"
      class="universal-button"
      title="打开命令菜单（Ctrl+K）"
      aria-label="打开命令菜单"
      @focus="reveal"
      @click="activate"
    >
      <img v-if="iconUrl" :src="iconUrl" alt="" />
      <LogoMark v-else :size="20" />
    </button>
    <span v-if="error" class="universal-icon-error" role="status">图标不可用</span>
  </div>
</template>

<style scoped>
.universal-hot-zone {
  position: fixed;
  z-index: 91;
  top: 0;
  left: 50%;
  width: 112px;
  height: calc(2 * var(--hairline, 1px));
  transform: translateX(-50%);
}

.universal-button-zone {
  position: fixed;
  z-index: 90;
  top: 0;
  left: 50%;
  display: grid;
  width: 136px;
  height: 86px;
  place-items: start center;
  padding-top: 4px;
  transform: translate(-50%, -14px);
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition:
    opacity 90ms var(--ease),
    transform 140ms var(--ease),
    visibility 0s 140ms;
}

.universal-button-zone.revealed,
.universal-button-zone:focus-within {
  transform: translate(-50%, 0);
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
  transition:
    opacity 90ms var(--ease),
    transform 140ms var(--ease),
    visibility 0s;
}

.universal-button {
  display: grid;
  width: 34px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--rule-strong);
  border-radius: 0 0 8px 8px;
  color: var(--ink);
  background: var(--paper-raised);
  box-shadow: 0 8px 24px color-mix(in oklab, var(--ink) 14%, transparent);
  font-size: 17px;
}

.universal-button img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.universal-icon-error {
  margin-top: 34px;
  color: var(--refused);
  font-size: 10px;
}

@media (prefers-reduced-motion: reduce) {
  .universal-button-zone,
  .universal-button-zone.revealed {
    transition: opacity 90ms linear;
  }
}
</style>
