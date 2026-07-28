<script lang="ts">
  import type { Persona, PersonaCarry } from "@refrain/core";
  import { PRESETS } from "@refrain/core";
  import type { Key } from "./i18n.ts";

  interface Props {
    persona: Persona | undefined;
    carry: PersonaCarry;
    t: (key: Key) => string;
    onChange: (persona: Persona | undefined, carry: PersonaCarry) => void;
  }

  const { persona, carry, t, onChange }: Props = $props();

  /*
   * Empty initialisers with the effect below as the single source of sync.
   * Reading `persona` in an initialiser would capture whichever agent was
   * selected when the component mounted and never update — so selecting a
   * different agent would show the wrong brief in an editable field, which is
   * how an author ends up rewriting someone else's identity by accident.
   */
  let editingId = $state<string | undefined>(undefined);
  let brief = $state("");
  let name = $state("");

  $effect(() => {
    if (persona?.id === editingId) return;
    editingId = persona?.id;
    brief = persona?.brief ?? "";
    name = persona?.name ?? "";
  });

  /*
   * A preset fills the fields and then gets out of the way. The author owns
   * the text from that point on — `basedOn` records where it started so a
   * later revision can tell an edited preset from one still at its default.
   */
  const applyPreset = (preset: Persona): void => {
    name = preset.name;
    brief = preset.brief;
    onChange({ id: persona?.id ?? crypto.randomUUID(), name, brief, basedOn: preset.id }, carry);
  };

  const commit = (): void => {
    onChange(
      brief.trim().length === 0
        ? undefined
        : {
            id: persona?.id ?? crypto.randomUUID(),
            name: name.trim().length === 0 ? t("persona.unnamed") : name.trim(),
            brief,
            ...(persona?.basedOn === undefined ? {} : { basedOn: persona.basedOn }),
          },
      carry,
    );
  };

  const carries: PersonaCarry[] = ["first-round", "every-round", "never"];
  const carryKey = (value: PersonaCarry): Key => `persona.carry.${value}` as Key;
</script>

<div class="persona">
  <p class="why">{t("persona.why")}</p>

  <div class="presets">
    {#each PRESETS as preset (preset.id)}
      <button
        class="preset"
        class:active={persona?.basedOn === preset.id}
        onclick={() => applyPreset(preset)}
      >
        {preset.name}
      </button>
    {/each}
  </div>

  <input class="name" bind:value={name} onblur={commit} placeholder={t("persona.namePlaceholder")} />

  <textarea
    class="brief"
    bind:value={brief}
    onblur={commit}
    rows="5"
    placeholder={t("persona.briefPlaceholder")}
  ></textarea>

  <div class="carry">
    <span class="label">{t("persona.carryLabel")}</span>
    {#each carries as option (option)}
      <button
        class="opt"
        class:on={carry === option}
        onclick={() => onChange(persona, option)}
      >
        {t(carryKey(option))}
      </button>
    {/each}
  </div>

  <p class="cost">{t("persona.cost")}: {brief.trim().length} {t("persona.chars")}</p>
</div>

<style>
  .persona {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .why {
    margin: 0;
    font-size: var(--step--2);
    line-height: 1.8;
    color: var(--ink-faint);
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.36rem;
  }

  .preset {
    font-size: var(--step--2);
    padding: 0.24rem 0.6rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
  }

  .preset:hover,
  .preset.active {
    border-color: var(--seal);
    color: var(--seal);
  }

  .name,
  .brief {
    background: var(--paper-sunk);
    border: 1px solid var(--rule);
    border-radius: 2px;
    padding: 0.44rem 0.55rem;
    color: var(--ink);
    font-family: inherit;
  }

  .name {
    font-size: var(--step--1);
  }

  .brief {
    font-size: var(--step--1);
    line-height: 1.85;
    resize: vertical;
  }

  .name:focus,
  .brief:focus {
    outline: none;
    border-color: var(--seal);
  }

  .carry {
    display: flex;
    align-items: center;
    gap: 0.36rem;
  }

  .label {
    font-size: var(--step--2);
    color: var(--ink-faint);
    margin-right: 0.2rem;
  }

  .opt {
    font-size: var(--step--2);
    padding: 0.2rem 0.5rem;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--ink-faint);
  }

  .opt.on {
    border-color: var(--seal);
    color: var(--seal);
  }

  .cost {
    margin: 0;
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }
</style>
