<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number;
    label?: string;
  }>(),
  {
    size: 28,
    label: "RefRain",
  },
);
</script>

<template>
  <svg
    class="logo-mark"
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    role="img"
    :aria-label="label"
  >
    <g stroke="currentColor" stroke-width="1.6">
      <path d="M10 11v26" stroke-width="3.2" />
      <path d="M13.6 11v26" stroke-width="1" />
      <path d="M23 13l-3.5 13M31 13l-3.5 13M39 13l-3.5 13" />
    </g>
    <path d="M18 33h23" stroke="var(--seal, #c1542f)" stroke-width="2" />
  </svg>
</template>

<style scoped>
.logo-mark {
  display: block;
  flex: none;
}
</style>
