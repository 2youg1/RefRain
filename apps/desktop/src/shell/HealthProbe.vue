<script setup lang="ts">
// The R0 round trip: a Rust type, a generated binding, a real window.
// Nothing here is hand-written against the bridge — `verify:bridge` fails the
// build if it were (INV-11).
import { onMounted, ref } from "vue";
import { commands, type HealthReport } from "../generated/bindings.gen";

const report = ref<HealthReport | null>(null);
const failure = ref<string | null>(null);

onMounted(async () => {
  try {
    report.value = await commands.health("r0");
  } catch (error) {
    failure.value = String(error);
  }
});
</script>

<template>
  <section class="probe">
    <h1>RefRain</h1>
    <dl v-if="report">
      <dt>version</dt>
      <dd>{{ report.version }}</dd>
      <dt>commit</dt>
      <!-- Absent is shown as absent. An unidentified build never reads as an
           identified one, which is the same discipline INV-3 applies to token
           counts: unknown is a value, not a blank. -->
      <dd>{{ report.commit ?? "unidentified build" }}</dd>
      <dt>echo</dt>
      <dd>{{ report.echo }}</dd>
    </dl>
    <p v-else-if="failure" class="failure">{{ failure }}</p>
    <p v-else>…</p>
  </section>
</template>

<style scoped>
.probe {
  font-family: system-ui, sans-serif;
  line-height: 1.6;
}

h1 {
  font-weight: 500;
  letter-spacing: 0.02em;
}

dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1.5rem;
  margin: 0;
}

dt {
  opacity: 0.55;
}

dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
