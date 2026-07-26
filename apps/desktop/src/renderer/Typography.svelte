<script lang="ts">
import type { Key } from "./i18n.ts";

import { DEFAULTS, type TypeSettings } from "./typography.ts";

interface Props {
  settings: TypeSettings;
  t: (key: Key) => string;
  onChange: (next: TypeSettings) => void;
}

const { settings, t, onChange }: Props = $props();

const set = <K extends keyof TypeSettings>(key: K, value: TypeSettings[K]): void =>
  onChange({ ...settings, [key]: value });

const families: { id: TypeSettings["family"]; label: Key }[] = [
  { id: "serif", label: "typo.serif" },
  { id: "sans", label: "typo.sans" },
  { id: "display", label: "typo.display" },
  { id: "mono", label: "typo.mono" },
];

const weights = [200, 300, 400, 500, 600, 700];
</script>

<div class="typography">
  <div
    class="specimen"
    style="
      font-family: {settings.family === 'custom' && settings.customFamily
        ? settings.customFamily
        : `var(--${settings.family})`};
      font-size: {settings.size}px;
      font-weight: {settings.weight};
      line-height: {settings.leading};
      letter-spacing: {settings.tracking}em;
      word-spacing: {settings.wordSpacing}em;
      text-align: {settings.align};
      text-indent: {settings.indent}em;
    "
  >
    {t("typo.preview")}
  </div>

  <section>
    <span class="label">{t("typo.family")}</span>
    <div class="segmented">
      {#each families as family (family.id)}
        <button class:on={settings.family === family.id} onclick={() => set("family", family.id)}>
          {t(family.label)}
        </button>
      {/each}
    </div>
    <input
      class="custom"
      placeholder={t("typo.customPlaceholder")}
      value={settings.customFamily}
      oninput={(e) => {
        set("customFamily", e.currentTarget.value);
        if (e.currentTarget.value.trim()) set("family", "custom");
      }}
    />
  </section>

  <section>
    <span class="label">{t("typo.weight")}</span>
    <div class="segmented">
      {#each weights as weight (weight)}
        <button class:on={settings.weight === weight} onclick={() => set("weight", weight)}>
          {weight}
        </button>
      {/each}
    </div>
  </section>

  {#snippet slider(
    label: Key,
    key: keyof TypeSettings,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
  )}
    <div class="row">
      <span class="label">{t(label)}</span>
      <input
        type="range"
        {min}
        {max}
        {step}
        value={settings[key] as number}
        oninput={(e) => set(key as "size", Number(e.currentTarget.value))}
      />
      <output>{format(settings[key] as number)}</output>
    </div>
  {/snippet}

  <section class="sliders">
    {@render slider("typo.size", "size", 12, 32, 0.5, (v) => `${v}px`)}
    {@render slider("typo.leading", "leading", 1.2, 3, 0.05, (v) => v.toFixed(2))}
    {@render slider("typo.tracking", "tracking", -0.03, 0.2, 0.005, (v) => `${v.toFixed(3)}em`)}
    {@render slider("typo.wordSpacing", "wordSpacing", -0.1, 1, 0.05, (v) => `${v.toFixed(2)}em`)}
    {@render slider("typo.measure", "measure", 18, 60, 1, (v) => `${v}em`)}
    {@render slider("typo.indent", "indent", 0, 4, 0.5, (v) => (v === 0 ? t("typo.none") : `${v}字`))}
    {@render slider("typo.paraSpacing", "paragraphSpacing", 0, 3, 0.25, (v) => `${v.toFixed(2)}`)}
    {@render slider("typo.marginTop", "marginTop", 0, 20, 0.5, (v) => `${v}rem`)}
    {@render slider("typo.marginBottom", "marginBottom", 10, 70, 5, (v) => `${v}vh`)}
  </section>

  <section>
    <span class="label">{t("typo.align")}</span>
    <div class="segmented">
      <button class:on={settings.align === "left"} onclick={() => set("align", "left")}>
        {t("typo.alignLeft")}
      </button>
      <button class:on={settings.align === "justify"} onclick={() => set("align", "justify")}>
        {t("typo.alignJustify")}
      </button>
    </div>
  </section>

  <section>
    <div class="row toggle">
      <span class="label">{t("typo.grid")}</span>
      <button
        class="switch"
        class:on={settings.grid}
        aria-label={t("typo.grid")}
        aria-pressed={settings.grid}
        onclick={() => set("grid", !settings.grid)}
      >
        <span class="knob"></span>
      </button>
    </div>
    {#if settings.grid}
      {@render slider("typo.gridEvery", "gridEvery", 1, 4, 1, (v) => `${t("typo.everyN")} ${v}`)}
    {/if}
  </section>

  <button class="reset" onclick={() => onChange(DEFAULTS)}>{t("typo.reset")}</button>
</div>

<style>
  .typography {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .specimen {
    padding: 1.3rem 1.1rem;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--ink);
    min-height: 7rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .sliders {
    gap: 0.75rem;
  }

  .segmented {
    display: flex;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    overflow: hidden;
  }

  .segmented button {
    flex: 1;
    padding: 0.45rem 0;
    font-size: var(--step--1);
    color: var(--ink-soft);
    background: var(--paper-raised);
    border-right: 1px solid var(--rule);
  }

  .segmented button:last-child {
    border-right: none;
  }

  .segmented button.on {
    background: var(--ink);
    color: var(--paper-raised);
  }

  .custom {
    font-size: var(--step--1);
    padding: 0.4rem 0.55rem;
  }

  .row {
    display: grid;
    grid-template-columns: 5.2em 1fr 4.8em;
    align-items: center;
    gap: 0.7rem;
  }

  .row .label {
    text-transform: none;
    letter-spacing: 0.02em;
    font-weight: 400;
    font-size: var(--step--1);
  }

  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    height: 1px;
    padding: 0;
    border: none;
    background: var(--rule-strong);
    border-radius: 0;
  }

  input[type="range"]:focus {
    box-shadow: none;
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--seal);
    cursor: grab;
    border: 2px solid var(--paper-raised);
    box-shadow: 0 0 0 1px var(--seal);
  }

  output {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-faint);
    text-align: right;
  }

  .toggle {
    grid-template-columns: 1fr auto;
  }

  .switch {
    width: 34px;
    height: 19px;
    border-radius: 10px;
    background: var(--rule-strong);
    position: relative;
    transition: background 160ms var(--ease);
  }

  .switch.on {
    background: var(--seal);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: var(--paper-raised);
    transition: transform 160ms var(--ease);
  }

  .switch.on .knob {
    transform: translateX(15px);
  }

  .reset {
    align-self: flex-start;
    font-size: var(--step--2);
    color: var(--ink-faint);
    padding: 0.35rem 0;
  }

  .reset:hover {
    color: var(--seal);
  }
</style>
