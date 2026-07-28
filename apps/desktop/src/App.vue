<script setup lang="ts">
// App.vue mounts and provides. It holds no state machine and coordinates
// nothing (SPEC 9.10); a gate fails the build past 120 lines.
import HealthProbe from "./shell/HealthProbe.vue";
</script>

<template>
  <main class="shell">
    <HealthProbe />
  </main>
</template>

<style>
:root {
  --paper: #f7f5f0;
  --ink: #1a1a1c;
  color-scheme: light;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: system-ui, sans-serif;
}

.shell {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
}
</style>
