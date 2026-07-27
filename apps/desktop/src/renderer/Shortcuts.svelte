<script lang="ts">
  
  import type { Key } from "./i18n.ts";
import { chordOf, DEFAULT_BINDINGS } from "./keys.ts";

  interface Props {
    bindings: Record<string, string>;
    t: (key: Key) => string;
    onChange: (next: Record<string, string>) => void;
  }

  const { bindings, t, onChange }: Props = $props();

  let capturing = $state<string | null>(null);

  /** Record the next chord the author presses, whatever it is. */
  const capture = (event: KeyboardEvent, id: string): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") return void (capturing = null);
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;

    onChange({ ...bindings, [id]: chordOf(event) });
    capturing = null;
  };

  const groups: { label: Key; ids: string[] }[] = [
    { label: "group.project", ids: ["open", "newChapter", "save"] },
    { label: "group.write", ids: ["bold", "italic"] },
    { label: "group.collab", ids: ["dispatch", "review", "edits", "ledger"] },
    { label: "group.view", ids: ["palette", "zen", "settings", "zoomIn", "zoomOut", "zoomReset"] },
  ];

  const labelFor = (id: string): Key => `keys.${id}` as Key;
</script>

<div class="shortcuts">
  {#each groups as group (group.label)}
    <section>
      <span class="label">{t(group.label)}</span>
      {#each group.ids as id (id)}
        <div class="row">
          <span class="name">{t(labelFor(id))}</span>
          <button
            class="chord"
            class:capturing={capturing === id}
            onclick={() => (capturing = id)}
            onkeydown={(e) => capturing === id && capture(e, id)}
          >
            {capturing === id ? t("keys.press") : bindings[id]}
          </button>
        </div>
      {/each}
    </section>
  {/each}

  <button class="reset" onclick={() => onChange({ ...DEFAULT_BINDINGS })}>
    {t("keys.reset")}
  </button>
</div>

<style>
  .shortcuts {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.25rem 0;
  }

  .name {
    font-size: var(--step--1);
    color: var(--ink-soft);
  }

  .chord {
    font-family: var(--mono);
    font-size: var(--step--2);
    padding: 0.24rem 0.5rem;
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
    color: var(--ink-faint);
    min-width: 6.5em;
    text-align: center;
  }

  .chord:hover {
    border-color: var(--seal);
    color: var(--seal);
  }

  .chord.capturing {
    border-color: var(--seal);
    background: var(--seal-wash);
    color: var(--seal);
    animation: breathe 1.2s ease-in-out infinite;
  }

  .reset {
    align-self: flex-start;
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .reset:hover {
    color: var(--seal);
  }

  @keyframes breathe {
    50% {
      opacity: 0.55;
    }
  }
</style>
