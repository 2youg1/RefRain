<script setup lang="ts">
// biome-ignore-all lint/correctness/noUnusedVariables: Vue templates use these bindings.
import { computed, onMounted, ref } from "vue";
import { describe, unwrap } from "../bridge";
import {
  type BuiltinTypographyPreset,
  commands,
  type FontFamilyDto,
  type FontSlot,
  type TextAlignment,
  type TypographyConfig,
  type TypographyPreset,
} from "../generated/bindings.gen";

const SLOTS = ["latin", "chinese", "japanese"] as const satisfies readonly FontSlot[];
const SLOT_NAME: Record<FontSlot, string> = {
  latin: "西文",
  chinese: "中文",
  japanese: "日文",
};
const BUILTIN_COPY: Record<string, { name: string; detail: string }> = {
  "chinese-prose": { name: "中文长文", detail: "两字缩进，适中的段间呼吸" },
  "japanese-prose": { name: "日文长文", detail: "日文字形优先，收紧字间与行宽" },
  "english-prose": { name: "英文长文", detail: "较短行距，增加英文词间距" },
};

type NumericTypographyKey = {
  [Key in keyof TypographyConfig]: TypographyConfig[Key] extends number ? Key : never;
}[keyof TypographyConfig];

const typography = ref<TypographyConfig | null>(null);
const catalog = ref<FontFamilyDto[]>([]);
const builtins = ref<BuiltinTypographyPreset[]>([]);
const presets = ref<TypographyPreset[]>([]);
const familySearch = ref<Record<FontSlot, string>>({ latin: "", chinese: "", japanese: "" });
const presetName = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const status = ref("正在读取本机字体…");

const current = (): TypographyConfig => {
  if (!typography.value) throw new Error("排版尚未载入");
  return typography.value;
};

const load = async (): Promise<void> => {
  try {
    const [snapshot, installed, builtinRows] = await Promise.all([
      unwrap(commands.readConfig()),
      unwrap(commands.listFonts()),
      commands.listBuiltinTypographyPresets(),
    ]);
    typography.value = structuredClone(snapshot.config.appearance.typography);
    presets.value = structuredClone(snapshot.config.appearance.typography_presets);
    catalog.value = installed;
    builtins.value = builtinRows;
    status.value = `已找到 ${installed.length} 个字体家族`;
    error.value = null;
  } catch (cause) {
    error.value = describe(cause);
  }
};

onMounted(load);

const commit = async (next: TypographyConfig, message = "排版已保存"): Promise<void> => {
  busy.value = true;
  try {
    const snapshot = await unwrap(
      commands.updatePreferences({ kind: "setTypography", value: structuredClone(next) }),
    );
    typography.value = structuredClone(snapshot.config.appearance.typography);
    presets.value = structuredClone(snapshot.config.appearance.typography_presets);
    status.value = message;
    error.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
};

const setField = <Key extends keyof TypographyConfig>(
  key: Key,
  value: TypographyConfig[Key],
): void => {
  const next = structuredClone(current());
  next[key] = value;
  void commit(next);
};

const setNumber = (key: NumericTypographyKey, value: number): void => {
  setField(key, value);
};

const setFamily = (slot: FontSlot, family: string): void => {
  const next = structuredClone(current());
  next.fonts[slot] = family;
  void commit(next, `${SLOT_NAME[slot]}字体已保存`);
};

const promote = (slot: FontSlot): void => {
  const next = structuredClone(current());
  next.fonts.priority = [slot, ...next.fonts.priority.filter((entry) => entry !== slot)] as [
    FontSlot,
    FontSlot,
    FontSlot,
  ];
  void commit(next, `${SLOT_NAME[slot]}字形已优先`);
};

const visibleFamilies = (slot: FontSlot): FontFamilyDto[] => {
  const query = familySearch.value[slot].trim().toLocaleLowerCase();
  const selected = typography.value?.fonts[slot];
  return catalog.value
    .filter((entry) => {
      if (entry.family === selected) return true;
      if (query) return entry.family.toLocaleLowerCase().includes(query);
      return entry.bundledSlot === slot;
    })
    .slice(0, 120);
};

const availableWeights = computed(() => {
  if (!typography.value) return [];
  const selected = new Set(
    Object.values(typography.value.fonts).filter((entry) => typeof entry === "string"),
  );
  const weights = new Set<number>([typography.value.font_weight]);
  for (const row of catalog.value) {
    if (!selected.has(row.family)) continue;
    for (const weight of row.weights) weights.add(weight);
  }
  return [...weights].sort((left, right) => left - right);
});

const applyBuiltin = (preset: BuiltinTypographyPreset): void => {
  const label = BUILTIN_COPY[preset.id]?.name ?? preset.id;
  void commit(structuredClone(preset.typography), `已应用“${label}”`);
};

const applyPreset = (preset: TypographyPreset): void => {
  void commit(structuredClone(preset.typography), `已应用“${preset.name}”`);
};

const savePreset = async (): Promise<void> => {
  const name = presetName.value.trim();
  if (!name) {
    error.value = "请先为这套排版命名。";
    return;
  }
  busy.value = true;
  try {
    const snapshot = await unwrap(
      commands.updatePreferences({ kind: "saveTypographyPreset", value: name }),
    );
    presets.value = structuredClone(snapshot.config.appearance.typography_presets);
    presetName.value = "";
    status.value = `已保存“${name}”`;
    error.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
};

const removePreset = async (preset: TypographyPreset): Promise<void> => {
  busy.value = true;
  try {
    const snapshot = await unwrap(
      commands.updatePreferences({ kind: "removeTypographyPreset", value: preset.id }),
    );
    presets.value = structuredClone(snapshot.config.appearance.typography_presets);
    status.value = `已删除“${preset.name}”`;
    error.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
};

const numberFrom = (event: Event): number =>
  Number((event.currentTarget as HTMLInputElement | HTMLSelectElement).value);
const textFrom = (event: Event): string =>
  (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
const faceStyle = (family: string): Record<string, string> => ({
  fontFamily: `"${family}", sans-serif`,
});
const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));
const alignmentFrom = (value: string): TextAlignment => (value === "justify" ? "justify" : "left");
</script>

<template>
  <div class="typography-panel" :aria-busy="busy">
    <p class="panel-status" aria-live="polite">{{ status }}</p>

    <section class="type-section preset-section" aria-labelledby="preset-title">
      <div class="section-heading">
        <div>
          <h3 id="preset-title">从一套稳妥的排版开始</h3>
          <p>预设会替换下面的全部排版值；应用后仍可逐项调整。</p>
        </div>
      </div>
      <div class="preset-grid">
        <button
          v-for="preset in builtins"
          :key="preset.id"
          type="button"
          class="preset-button"
          :disabled="busy"
          @click="applyBuiltin(preset)"
        >
          <strong>{{ BUILTIN_COPY[preset.id]?.name ?? preset.id }}</strong>
          <span>{{ BUILTIN_COPY[preset.id]?.detail }}</span>
        </button>
      </div>
      <div v-if="presets.length" class="saved-presets" aria-label="我的排版方案">
        <div v-for="preset in presets" :key="preset.id" class="saved-preset">
          <button type="button" :disabled="busy" @click="applyPreset(preset)">
            {{ preset.name }}
          </button>
          <button
            type="button"
            class="remove-preset"
            :aria-label="`删除排版方案 ${preset.name}`"
            :disabled="busy"
            @click="removePreset(preset)"
          >
            删除
          </button>
        </div>
      </div>
      <form class="save-preset" @submit.prevent="savePreset">
        <label for="preset-name">保存当前排版</label>
        <input
          id="preset-name"
          v-model="presetName"
          type="text"
          maxlength="40"
          placeholder="例如：访谈长稿"
          :disabled="busy || !typography"
        />
        <button type="submit" :disabled="busy || !typography">保存方案</button>
      </form>
    </section>

    <template v-if="typography">
      <section class="type-section" aria-labelledby="faces-title">
        <div class="section-heading">
          <div>
            <h3 id="faces-title">字体与共享汉字</h3>
            <p>输入名称即可搜索本机字体。排在第一位的字形负责绘制共享汉字。</p>
          </div>
          <div class="priority" aria-label="共享汉字优先级">
            <button
              v-for="(slot, index) in typography.fonts.priority"
              :key="slot"
              type="button"
              :class="{ first: index === 0 }"
              :disabled="busy"
              :title="`让${SLOT_NAME[slot]}字形优先`"
              @click="promote(slot)"
            >
              <span>{{ index + 1 }}</span>{{ SLOT_NAME[slot] }}
            </button>
          </div>
        </div>

        <div class="font-grid">
          <label v-for="slot in SLOTS" :key="slot" class="font-choice">
            <span>{{ SLOT_NAME[slot] }}字体</span>
            <input
              v-model="familySearch[slot]"
              type="search"
              :placeholder="`搜索本机${SLOT_NAME[slot]}字体`"
              :disabled="busy"
            />
            <select
              :value="typography.fonts[slot]"
              :disabled="busy"
              :aria-label="`${SLOT_NAME[slot]}字体`"
              :style="faceStyle(typography.fonts[slot])"
              @change="setFamily(slot, textFrom($event))"
            >
              <option
                v-for="face in visibleFamilies(slot)"
                :key="face.family"
                :value="face.family"
              >
                {{ face.family }}{{ face.bundledSlot ? " · 内置" : "" }}
              </option>
            </select>
          </label>
        </div>
      </section>

      <section class="type-section" aria-labelledby="rhythm-title">
        <div class="section-heading">
          <div>
            <h3 id="rhythm-title">字形与行文节奏</h3>
            <p>先调整字号和行距；字距只在稿件确实需要时微调。</p>
          </div>
        </div>
        <div class="control-grid">
          <label class="control">
            <span><b>字号</b><output>{{ (typography.text_size_tenths_px / 10).toFixed(1) }} px</output></span>
            <input
              type="range"
              min="120"
              max="360"
              step="5"
              :value="typography.text_size_tenths_px"
              :disabled="busy"
              @change="setNumber('text_size_tenths_px', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>字重</b><output>{{ typography.font_weight }}</output></span>
            <select
              :value="typography.font_weight"
              :disabled="busy"
              @change="setNumber('font_weight', numberFrom($event))"
            >
              <option v-for="weight in availableWeights" :key="weight" :value="weight">{{ weight }}</option>
            </select>
          </label>
          <label class="control">
            <span><b>行距</b><output>{{ (typography.line_height_percent / 100).toFixed(2) }}</output></span>
            <input
              type="range"
              min="120"
              max="300"
              step="5"
              :value="typography.line_height_percent"
              :disabled="busy"
              @change="setNumber('line_height_percent', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>字距</b><output>{{ signed(typography.letter_spacing_thousandths_em) }} / 1000 em</output></span>
            <input
              type="range"
              min="-100"
              max="200"
              step="5"
              :value="typography.letter_spacing_thousandths_em"
              :disabled="busy"
              @change="setNumber('letter_spacing_thousandths_em', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>词距</b><output>{{ signed(typography.word_spacing_thousandths_em) }} / 1000 em</output></span>
            <input
              type="range"
              min="-100"
              max="500"
              step="10"
              :value="typography.word_spacing_thousandths_em"
              :disabled="busy"
              @change="setNumber('word_spacing_thousandths_em', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>显示缩放</b><output>{{ typography.zoom_percent }}%</output></span>
            <input
              type="range"
              min="50"
              max="200"
              step="5"
              :value="typography.zoom_percent"
              :disabled="busy"
              @change="setNumber('zoom_percent', numberFrom($event))"
            />
          </label>
        </div>
      </section>

      <section class="type-section" aria-labelledby="paragraph-title">
        <div class="section-heading">
          <div>
            <h3 id="paragraph-title">版心与段落</h3>
            <p>控制每行长度、首行缩进和段落之间的距离。</p>
          </div>
        </div>
        <div class="control-grid">
          <label class="control">
            <span><b>每行宽度</b><output>{{ (typography.measure_tenths_em / 10).toFixed(1) }} em</output></span>
            <input
              type="range"
              min="200"
              max="720"
              step="10"
              :value="typography.measure_tenths_em"
              :disabled="busy"
              @change="setNumber('measure_tenths_em', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>首行缩进</b><output>{{ (typography.first_line_indent_tenths_em / 10).toFixed(1) }} em</output></span>
            <input
              type="range"
              min="0"
              max="40"
              step="5"
              :value="typography.first_line_indent_tenths_em"
              :disabled="busy"
              @change="setNumber('first_line_indent_tenths_em', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>段落间距</b><output>{{ typography.paragraph_spacing_percent }}%</output></span>
            <input
              type="range"
              min="0"
              max="200"
              step="5"
              :value="typography.paragraph_spacing_percent"
              :disabled="busy"
              @change="setNumber('paragraph_spacing_percent', numberFrom($event))"
            />
          </label>
          <label class="control segmented">
            <span><b>段落对齐</b></span>
            <span class="segment-buttons">
              <button
                type="button"
                :class="{ current: typography.alignment === 'left' }"
                :disabled="busy"
                @click="setField('alignment', alignmentFrom('left'))"
              >
                左对齐
              </button>
              <button
                type="button"
                :class="{ current: typography.alignment === 'justify' }"
                :disabled="busy"
                @click="setField('alignment', alignmentFrom('justify'))"
              >
                两端对齐
              </button>
            </span>
          </label>
        </div>
      </section>

      <section class="type-section" aria-labelledby="page-title">
        <div class="section-heading">
          <div>
            <h3 id="page-title">页面留白与基线</h3>
            <p>底部留白让光标停在视野中部；基线规则只辅助观察，不写入正文。</p>
          </div>
        </div>
        <div class="control-grid">
          <label class="control">
            <span><b>顶部留白</b><output>{{ (typography.page_top_padding_tenths_rem / 10).toFixed(1) }} rem</output></span>
            <input
              type="range"
              min="0"
              max="120"
              step="5"
              :value="typography.page_top_padding_tenths_rem"
              :disabled="busy"
              @change="setNumber('page_top_padding_tenths_rem', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>底部留白</b><output>{{ (typography.page_bottom_padding_tenths_vh / 10).toFixed(0) }} vh</output></span>
            <input
              type="range"
              min="0"
              max="1000"
              step="50"
              :value="typography.page_bottom_padding_tenths_vh"
              :disabled="busy"
              @change="setNumber('page_bottom_padding_tenths_vh', numberFrom($event))"
            />
          </label>
          <label class="control">
            <span><b>基线参考线</b><output>{{ typography.baseline_grid_lines === 0 ? "关闭" : `每 ${typography.baseline_grid_lines} 行` }}</output></span>
            <select
              :value="typography.baseline_grid_lines"
              :disabled="busy"
              @change="setNumber('baseline_grid_lines', numberFrom($event))"
            >
              <option :value="0">关闭</option>
              <option v-for="line in 6" :key="line" :value="line">每 {{ line }} 行</option>
            </select>
          </label>
        </div>
      </section>
    </template>

    <p v-if="error" class="panel-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.typography-panel {
  display: grid;
  gap: 18px;
}

.panel-status {
  margin: 0;
  color: var(--ink-faint);
  font-size: 11px;
  text-align: right;
}

.type-section {
  border-top: 1px solid var(--rule);
  padding-top: 20px;
}

.preset-section {
  border-top: 0;
  padding-top: 0;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 20px;
  margin-bottom: 16px;
}

.section-heading h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 680;
}

.section-heading p {
  margin: 5px 0 0;
  color: var(--ink-faint);
  font-size: 11px;
  line-height: 1.5;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
}

.preset-button {
  display: flex;
  min-height: 72px;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 13px;
  text-align: left;
}

.preset-button strong {
  font-size: 12px;
}

.preset-button span {
  color: var(--ink-faint);
  font-size: 10px;
  line-height: 1.4;
}

.saved-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}

.saved-preset {
  display: flex;
}

.saved-preset > button:first-child {
  border-radius: 5px 0 0 5px;
}

.remove-preset {
  border-left: 0;
  border-radius: 0 5px 5px 0;
  color: var(--ink-faint);
  font-size: 10px;
}

.save-preset {
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto;
  align-items: center;
  gap: 9px;
  margin-top: 12px;
}

.save-preset label {
  color: var(--ink-soft);
  font-size: 11px;
}

.font-grid,
.control-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
}

.font-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.font-choice,
.control {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.font-choice > span,
.control > span:first-child {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--ink-soft);
  font-size: 11px;
}

.font-choice input,
.font-choice select,
.save-preset input,
.control select {
  min-width: 0;
  height: 34px;
}

.control input[type="range"] {
  width: 100%;
  accent-color: var(--seal);
}

.control output {
  color: var(--ink-faint);
  font-variant-numeric: tabular-nums;
}

.priority {
  display: flex;
  gap: 5px;
}

.priority button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
}

.priority button span {
  display: grid;
  width: 16px;
  height: 16px;
  place-items: center;
  border-radius: 50%;
  background: var(--paper-recessed);
  color: var(--ink-faint);
  font-size: 9px;
}

.priority button.first,
.segment-buttons button.current {
  border-color: var(--seal);
  color: var(--seal);
}

.segmented {
  align-content: start;
}

.segment-buttons {
  display: flex;
}

.segment-buttons button {
  flex: 1;
  border-radius: 0;
}

.segment-buttons button:first-child {
  border-radius: 5px 0 0 5px;
}

.segment-buttons button:last-child {
  border-left: 0;
  border-radius: 0 5px 5px 0;
}

.panel-error {
  margin: 0;
  color: var(--pending);
  font-size: 12px;
}

@media (max-width: 760px) {
  .preset-grid,
  .font-grid,
  .control-grid {
    grid-template-columns: 1fr;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .save-preset {
    grid-template-columns: 1fr;
  }
}
</style>
