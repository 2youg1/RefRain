<script lang="ts">
  
  import { api } from "./api.ts";
import type { Key } from "./i18n.ts";
  import {
    BUNDLED_CJK,
    BUNDLED_JP,
    BUNDLED_LATIN,
    DEFAULTS,
    type TypeSettings,
  } from "./typography.ts";

  interface Props {
    settings: TypeSettings;
    t: (key: Key) => string;
    onChange: (next: TypeSettings) => void;
  }

  const { settings, t, onChange }: Props = $props();

  let systemFonts = $state<string[]>([]);
  let filter = $state("");
  /** Which slot a chosen system font fills. */
  let slot = $state<"cjkFamily" | "jpFamily" | "latinFamily">("cjkFamily");

  $effect(() => {
    void api().systemFonts().then((list) => (systemFonts = list));
  });

  const set = <K extends keyof TypeSettings>(key: K, value: TypeSettings[K]): void =>
    onChange({ ...settings, [key]: value });

  const matching = $derived(
    filter.trim().length === 0
      ? systemFonts.slice(0, 60)
      : systemFonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase())).slice(0, 60),
  );
</script>

<div class="typography">
  <div
    class="specimen"
    style="
      font-family: '{settings.latinFamily}', '{settings.jpFamily}', '{settings.cjkFamily}', serif;
      font-size: {settings.size}px;
      font-weight: {settings.weight};
      line-height: {settings.leading};
      letter-spacing: {settings.tracking}em;
      text-align: {settings.align};
      text-indent: {settings.indent}em;
    "
  >
    {t("typo.preview")}
  </div>

  <section>
    <span class="label">{t("typo.cjk")}</span>
    <div class="chips">
      {#each BUNDLED_CJK as family (family)}
        <button
          class:on={settings.cjkFamily === family}
          style="font-family: '{family}'"
          onclick={() => set("cjkFamily", family)}>{family}</button
        >
      {/each}
    </div>
    <input
      class="typed"
      value={settings.cjkFamily}
      oninput={(e) => set("cjkFamily", e.currentTarget.value)}
      placeholder={t("typo.typeName")}
    />
  </section>

  <section>
    <span class="label">{t("typo.jp")}</span>
    <div class="chips">
      {#each BUNDLED_JP as family (family)}
        <button
          class:on={settings.jpFamily === family}
          style="font-family: '{family}'"
          onclick={() => set("jpFamily", family)}>{family}</button
        >
      {/each}
    </div>
    <input
      class="typed"
      value={settings.jpFamily}
      oninput={(e) => set("jpFamily", e.currentTarget.value)}
      placeholder={t("typo.typeName")}
    />
    <p class="hint">{t("typo.jpHint")}</p>
  </section>

  <section>
    <span class="label">{t("typo.latin")}</span>
    <div class="chips">
      {#each BUNDLED_LATIN as family (family)}
        <button
          class:on={settings.latinFamily === family}
          style="font-family: '{family}'"
          onclick={() => set("latinFamily", family)}>{family}</button
        >
      {/each}
    </div>
    <input
      class="typed"
      value={settings.latinFamily}
      oninput={(e) => set("latinFamily", e.currentTarget.value)}
      placeholder={t("typo.typeName")}
    />
  </section>

  {#if systemFonts.length > 0}
    <section>
      <span class="label">{t("typo.system")} · {systemFonts.length}</span>
      <!--
        Which slot a chosen system font fills.
        Every button here used to write `cjkFamily`, so an author who wanted a
        favourite Latin face from their own library got it installed as the
        Chinese one instead — and no control existed to undo that choice.
      -->
      <div class="segmented slot">
        {#each [["cjkFamily", "typo.cjk"], ["jpFamily", "typo.jp"], ["latinFamily", "typo.latin"]] as const as [key, label] (key)}
          <button class:on={slot === key} onclick={() => (slot = key)}>{t(label)}</button>
        {/each}
      </div>
      <input bind:value={filter} placeholder={t("typo.searchFont")} class="typed" />
      <div class="font-list">
        {#each matching as family (family)}
          <button style="font-family: '{family}'" onclick={() => set(slot, family)}>
            {family}
          </button>
        {/each}
      </div>
      <p class="hint">{t("typo.systemHint")}</p>
    </section>
  {/if}

  {#snippet number(
    label: Key,
    key: keyof TypeSettings,
    min: number,
    max: number,
    step: number,
    unit: string,
  )}
    <div class="row">
      <span class="name">{t(label)}</span>
      <input
        type="range"
        {min}
        {max}
        {step}
        value={settings[key] as number}
        oninput={(e) => set(key as "size", Number(e.currentTarget.value))}
      />
      <!-- Typed as well as dragged: a slider cannot hit 1.875 on purpose. -->
      <input
        class="value"
        type="number"
        {min}
        {max}
        {step}
        value={settings[key] as number}
        oninput={(e) => set(key as "size", Number(e.currentTarget.value))}
      />
      <span class="unit">{unit}</span>
    </div>
  {/snippet}

  <section class="numbers">
    {@render number("typo.size", "size", 10, 48, 0.5, "px")}
    {@render number("typo.weight", "weight", 100, 900, 10, "")}
    {@render number("typo.leading", "leading", 1, 4, 0.05, "×")}
    {@render number("typo.tracking", "tracking", -0.05, 0.5, 0.005, "em")}
    {@render number("typo.wordSpacing", "wordSpacing", -0.2, 2, 0.05, "em")}
    {@render number("typo.measure", "measure", 14, 80, 1, "em")}
    {@render number("typo.indent", "indent", 0, 8, 0.5, t("typo.chars"))}
    {@render number("typo.paraSpacing", "paragraphSpacing", 0, 4, 0.25, "×")}
    {@render number("typo.marginTop", "marginTop", 0, 30, 0.5, "rem")}
    {@render number("typo.marginBottom", "marginBottom", 5, 80, 5, "vh")}
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
      <span class="name">{t("typo.grid")}</span>
      <button
        class="switch"
        class:on={settings.grid}
        aria-label={t("typo.grid")}
        aria-pressed={settings.grid}
        onclick={() => set("grid", !settings.grid)}><span class="knob"></span></button
      >
    </div>
    {#if settings.grid}
      {@render number("typo.gridEvery", "gridEvery", 1, 6, 1, t("typo.everyN"))}
    {/if}

    <div class="row toggle">
      <span class="name">{t("typo.breathe")}</span>
      <button
        class="switch"
        class:on={settings.breathe}
        aria-label={t("typo.breathe")}
        aria-pressed={settings.breathe}
        onclick={() => set("breathe", !settings.breathe)}><span class="knob"></span></button
      >
    </div>
    <p class="hint">{t("typo.breatheHint")}</p>

    <div class="row toggle">
      <span class="name">{t("typo.lineNumbers")}</span>
      <button
        class="switch"
        class:on={settings.lineNumbers}
        aria-label={t("typo.lineNumbers")}
        aria-pressed={settings.lineNumbers}
        onclick={() => set("lineNumbers", !settings.lineNumbers)}><span class="knob"></span></button
      >
    </div>
  </section>

  <section>
    <span class="label">{t("typo.progress")}</span>
    <div class="segmented">
      <button class:on={settings.progress === "gradient"} onclick={() => set("progress", "gradient")}>
        {t("typo.gradient")}
      </button>
      <button class:on={settings.progress === "solid"} onclick={() => set("progress", "solid")}>
        {t("typo.solid")}
      </button>
      <button class:on={settings.progress === "minimap"} onclick={() => set("progress", "minimap")}>
        {t("typo.minimap")}
      </button>
      <button class:on={settings.progress === "off"} onclick={() => set("progress", "off")}>
        {t("typo.gridOff")}
      </button>
    </div>
    {#if settings.progress !== "off" && settings.progress !== "minimap"}
      <div class="segmented">
        <button
          class:on={settings.progressPlace === "top"}
          onclick={() => set("progressPlace", "top")}>{t("typo.top")}</button
        >
        <button
          class:on={settings.progressPlace === "right"}
          onclick={() => set("progressPlace", "right")}>{t("typo.right")}</button
        >
      </div>
    {/if}
  </section>

  <button class="reset" onclick={() => onChange({ ...DEFAULTS })}>{t("typo.reset")}</button>
</div>

<style>
  .typography {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
  }

  .specimen {
    padding: 1.3rem 1.1rem;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--ink);
    min-height: 6.5rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .chips button {
    padding: 0.35rem 0.65rem;
    font-size: var(--step--1);
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
    background: var(--paper-raised);
  }

  .chips button.on {
    background: var(--ink);
    color: var(--paper-raised);
    border-color: var(--ink);
  }

  .typed {
    font-size: var(--step--1);
    padding: 0.4rem 0.55rem;
  }

  .slot {
    margin-bottom: 0.4rem;
  }

  .font-list {
    display: flex;
    flex-direction: column;
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--rule);
    border-radius: 2px;
  }

  .font-list button {
    text-align: left;
    padding: 0.35rem 0.6rem;
    font-size: var(--step--1);
    color: var(--ink-soft);
    border-bottom: 1px solid var(--rule);
  }

  .font-list button:hover {
    background: var(--paper-sunk);
    color: var(--ink);
  }

  .numbers {
    gap: 0.55rem;
  }

  .row {
    display: grid;
    grid-template-columns: 5em 1fr 4.2em 2em;
    align-items: center;
    gap: 0.55rem;
  }

  .name {
    font-size: var(--step--1);
    color: var(--ink-soft);
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

  .value {
    font-family: var(--mono);
    font-size: var(--step--2);
    padding: 0.2rem 0.3rem;
    text-align: right;
  }

  .unit {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
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

  .toggle {
    grid-template-columns: 1fr auto;
  }

  .switch {
    width: 34px;
    height: 19px;
    border-radius: 10px;
    background: var(--rule-strong);
    position: relative;
    transition: background 180ms var(--ease);
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
    transition: transform 200ms var(--spring);
  }

  .switch.on .knob {
    transform: translateX(15px);
  }

  .hint {
    font-size: var(--step--2);
    color: var(--ink-faint);
    line-height: 1.7;
  }

  .reset {
    align-self: flex-start;
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .reset:hover {
    color: var(--seal);
  }
</style>
