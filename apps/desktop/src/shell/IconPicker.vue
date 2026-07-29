<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: `pick` and `chosen` are used in the template.
// The Universal Button's icon picker (SPEC 9.8): the pipeline judges by
// content, the Config stores only the digest, and the button shows the
// normalised asset through a data URL (CSP img-src 'self' data:).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import { commands } from "../generated/bindings.gen";

const iconUrl = ref<string | null>(null);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
let disposed = false;
let stopConfig: UnlistenFn | null = null;

const toDataUrl = (bytes: number[]): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
};

const refresh = async (): Promise<void> => {
  const bytes = await commands.universalIcon();
  iconUrl.value = bytes === null ? null : toDataUrl(bytes);
};

const refreshSafely = async (): Promise<void> => {
  try {
    await refresh();
  } catch (cause) {
    if (!disposed) error.value = describe(cause);
  }
};

const pick = (): void => {
  fileInput.value?.click();
};

const chosen = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const bytes = [...new Uint8Array(await file.arrayBuffer())];
    await unwrap(commands.setUniversalIcon(bytes));
    error.value = null;
    await refresh();
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    input.value = "";
  }
};

onMounted(async () => {
  try {
    const unlisten = await listen("config-changed", () => void refreshSafely());
    if (disposed) {
      unlisten();
      return;
    }
    stopConfig = unlisten;
    await refreshSafely();
  } catch (cause) {
    if (!disposed) error.value = describe(cause);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  stopConfig?.();
});
</script>

<template>
  <div class="icon-picker">
    <button type="button" class="icon-button" title="写作入口图标" @click="pick">
      <img v-if="iconUrl" :src="iconUrl" alt="写作入口图标" />
      <span v-else>◇</span>
    </button>
    <input
      ref="fileInput"
      type="file"
      accept=".svg,image/svg+xml,.png,image/png"
      style="display: none"
      @change="chosen"
    />
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style>
.icon-picker {
  padding: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.icon-button {
  all: unset;
  cursor: pointer;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  font-size: 16px;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
}

.icon-button img {
  width: 22px;
  height: 22px;
  border-radius: 4px;
}

.icon-picker .error {
  font-size: 12px;
  color: var(--pending);
  max-width: 180px;
}
</style>
