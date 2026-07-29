<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in the template.
// 排版（SPEC 9.8）:three face slots, the priority order that draws shared
// Han, and the manuscript's size and leading — all through the one Config.
import { onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import { commands, type FontSlot } from "../generated/bindings.gen";

const FACES: Record<FontSlot, string[]> = {
  latin: ["Antic Didone", "Jost", "Courier Prime"],
  chinese: ["Chiron Sung HK", "Noto Sans SC"],
  japanese: ["Shippori Mincho", "Zen Kaku Gothic New", "Murecho"],
};
const SLOT_NAME: Record<FontSlot, string> = { latin: "西文", chinese: "中文", japanese: "日文" };

const families = ref<Record<FontSlot, string>>({ latin: "", chinese: "", japanese: "" });
const priority = ref<FontSlot[]>(["latin", "chinese", "japanese"]);
const textSize = ref(17);
const lineHeight = ref(190);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const snapshot = await unwrap(commands.readConfig());
    families.value = { ...snapshot.config.appearance.fonts };
    priority.value = [...snapshot.config.appearance.fonts.priority];
    textSize.value = snapshot.config.appearance.text_size;
    lineHeight.value = snapshot.config.appearance.line_height;
  } catch (cause) {
    error.value = describe(cause);
  }
});

const write = async (change: Parameters<typeof commands.updatePreferences>[0]): Promise<void> => {
  try {
    await unwrap(commands.updatePreferences(change));
  } catch (cause) {
    error.value = describe(cause);
  }
};

const pickFamily = (slot: FontSlot, family: string): void => {
  families.value = { ...families.value, [slot]: family };
  void write({ kind: "setFontFamily", value: { slot, family } });
};

/** The order walks the stack per character; the first face carrying the
 * glyph wins, so the first slot draws shared Han. Click to promote. */
const promote = (slot: FontSlot): void => {
  const next = [slot, ...priority.value.filter((entry) => entry !== slot)];
  priority.value = next as FontSlot[];
  void write({ kind: "setFontPriority", value: next as [FontSlot, FontSlot, FontSlot] });
};

const sizeChanged = (): void => {
  void write({ kind: "setTextSize", value: textSize.value });
};

const leadingChanged = (): void => {
  void write({ kind: "setLineHeight", value: lineHeight.value });
};
</script>

<template>
  <div class="typography">
    <div v-for="slot in ['latin', 'chinese', 'japanese'] as FontSlot[]" :key="slot" class="row">
      <span class="name">{{ SLOT_NAME[slot] }}</span>
      <select
        :aria-label="`${SLOT_NAME[slot]}字体`"
        :value="families[slot]"
        @change="pickFamily(slot, ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="face in FACES[slot]" :key="face" :value="face">{{ face }}</option>
      </select>
    </div>
    <div class="row">
      <span class="name">字序</span>
      <div class="priority">
        <button
          v-for="(slot, index) in priority"
          :key="slot"
          type="button"
          :class="{ first: index === 0 }"
          :title="`${SLOT_NAME[slot]}优先`"
          @click="promote(slot)"
        >
          {{ SLOT_NAME[slot] }}
        </button>
      </div>
    </div>
    <div class="row">
      <span class="name">字号</span>
      <input
        v-model.number="textSize"
        type="range"
        min="14"
        max="22"
        step="1"
        aria-label="字号"
        @change="sizeChanged"
      />
      <span class="value">{{ textSize }}px</span>
    </div>
    <div class="row">
      <span class="name">行距</span>
      <input
        v-model.number="lineHeight"
        type="range"
        min="150"
        max="230"
        step="5"
        aria-label="行距"
        @change="leadingChanged"
      />
      <span class="value">{{ lineHeight / 100 }}</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.typography {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.name {
  color: var(--ink-faint);
  flex: none;
  width: 32px;
}

.row select {
  flex: 1;
}

.priority {
  display: flex;
  gap: 4px;
}

.priority button.first {
  border-color: var(--seal);
  color: var(--seal);
}

.row input[type="range"] {
  flex: 1;
  accent-color: var(--seal);
}

.value {
  width: 44px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
}

.error {
  margin: 0;
  font-size: 12px;
  color: var(--pending);
}
</style>
