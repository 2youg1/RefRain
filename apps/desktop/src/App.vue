<script setup lang="ts">
// App.vue mounts and provides. It holds no state machine and coordinates
// nothing (SPEC 9.10); a gate fails the build past 120 lines.

import { listen } from "@tauri-apps/api/event";
import { onMounted, ref, watch } from "vue";
import { unwrap } from "./bridge";
import { manuscriptStack } from "./fonts";
import { commands } from "./generated/bindings.gen";
import Workbench from "./shell/Workbench.vue";
import "./app.css";
import "./fonts.css";
import "./themes.css";

const theme = ref("tou");

// The generated selectors live on :root[data-theme]; the shell element is
// not :root. One projection, one direction (INV-15).
watch(
  theme,
  (next) => {
    document.documentElement.dataset.theme = next;
  },
  { immediate: true },
);

const applyConfig = async (): Promise<void> => {
  try {
    const snapshot = await unwrap(commands.readConfig());
    theme.value = snapshot.config.appearance.theme;
    document.documentElement.dataset.paper = snapshot.config.appearance.paper;
    document.documentElement.style.setProperty(
      "--manuscript-family",
      manuscriptStack(snapshot.config.appearance.fonts),
    );
    document.documentElement.style.setProperty(
      "--manuscript-size",
      `${snapshot.config.appearance.text_size}px`,
    );
    document.documentElement.style.setProperty(
      "--manuscript-leading",
      `${snapshot.config.appearance.line_height / 100}`,
    );
  } catch {
    // A damaged Config is the Settings surface's story to tell, not a reason
    // the author cannot write today (SPEC 10.1).
  }
};

onMounted(async () => {
  await listen("config-changed", () => void applyConfig());
  await applyConfig();
});
</script>

<template>
  <main class="shell">
    <Workbench @theme-changed="(next: string) => (theme = next)" />
  </main>
</template>

<style>
.shell {
  min-height: 100vh;
  background: var(--paper);
  color: var(--ink);
}
</style>
