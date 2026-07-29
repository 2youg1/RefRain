<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: `kara` is used in the template.
// The KARA surface (SPEC 9.3): the machine in Rust decides; this surface
// projects. Quiet chrome: the return card after Away, the debrief bar while
// Leaving, the interruption line. No clock, no statistics (Q17).
import { useKara } from "./kara-state";

const kara = useKara();
</script>

<template>
  <div class="kara-chrome">
    <Transition name="card">
      <div v-if="kara.returnCard.value" class="return-card">
        你停在这里:{{ kara.returnCard.value.sentenceTail }}
      </div>
    </Transition>

    <div v-if="kara.leaving.value" class="debrief" role="status">
      <span v-for="line in kara.debriefText.value" :key="line">{{ line }}</span>
      <span v-if="kara.debriefText.value.length === 0">这一段很安静。</span>
    </div>

    <div v-if="kara.interruption.value" class="interruption" role="alert">
      {{ kara.interruption.value }}
    </div>
  </div>
</template>

<style>
.kara-chrome {
  pointer-events: none;
  position: fixed;
  inset: 0;
  z-index: 30;
}

.return-card {
  position: absolute;
  top: 24vh;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--serif);
  font-size: 14px;
  color: var(--ink-soft);
}

.debrief {
  position: absolute;
  bottom: 12vh;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--ink-faint);
}

.interruption {
  position: absolute;
  top: 8vh;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 16px;
  background: var(--refused-wash);
  border-left: 3px solid var(--refused);
  font-size: 13px;
}

.card-enter-active,
.card-leave-active {
  transition: opacity 0.2s;
}

.card-enter-from,
.card-leave-to {
  opacity: 0;
}
</style>
