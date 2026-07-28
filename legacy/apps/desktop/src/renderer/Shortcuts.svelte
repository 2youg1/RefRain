<script lang="ts">
  import type { Key } from "./i18n.ts";
  import { chordOf, DEFAULT_BINDINGS } from "./keys.ts";
  import { inspectChord } from "./reserved-keys.ts";

  interface Props {
    bindings: Record<string, string>;
    t: (key: Key) => string;
    onChange: (next: Record<string, string>) => void;
  }

  const { bindings, t, onChange }: Props = $props();

  let capturing = $state<string | null>(null);
  /** Why the last chord was refused, and for which row. */
  let refused = $state<{ id: string; message: string } | null>(null);

  /**
   * Say no in the author's language, naming the obstacle.
   *
   * `inspectChord` and its reserved table were written and then never called,
   * so every one of these went straight into localStorage: a bare letter that
   * fired mid-sentence, Ctrl+C rebound away from copy, and — worst of the
   * three — a chord already claimed by another command. That last one failed
   * silently in both directions, because `commandFor` returns the first entry
   * whose keys match, so the older binding kept working and the new one never
   * ran while Settings displayed it as though it had.
   */
  const refusal = (chord: string, id: string): string | null => {
    const problem = inspectChord(chord, id, bindings);
    if (!problem) return null;
    if (problem.kind === "bare-key") return t("keys.bare");
    if (problem.kind === "reserved")
      return `${t("keys.reserved")}${problem.meaning}${t("keys.reservedTail")}`;
    return `${t("keys.duplicate")}${t(`keys.${problem.otherCommand}` as Key)}${t("keys.duplicateTail")}`;
  };

  /** Record the next chord the author presses, unless it cannot be honoured. */
  const capture = (event: KeyboardEvent, id: string): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      capturing = null;
      refused = null;
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;

    const chord = chordOf(event);
    const message = refusal(chord, id);
    if (message !== null) {
      // The row stays in capture, so the next press is another attempt rather
      // than a click to get back in.
      refused = { id, message };
      return;
    }

    onChange({ ...bindings, [id]: chord });
    capturing = null;
    refused = null;
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
            class:refused={refused?.id === id}
            onclick={() => {
              capturing = id;
              refused = null;
            }}
            onkeydown={(e) => capturing === id && capture(e, id)}
          >
            {capturing === id ? t("keys.press") : bindings[id]}
          </button>
        </div>
        {#if refused?.id === id}
          <p class="refusal" role="alert">{refused.message}</p>
        {/if}
      {/each}
    </section>
  {/each}

  <button class="reset" onclick={() => { onChange({ ...DEFAULT_BINDINGS }); refused = null; }}>
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

  /* `--refused` is the palette's existing word for a rejection, and this is
     one. A private colour here would be an eighth theme nobody maintains. */
  .chord.refused {
    border-color: var(--refused);
    color: var(--refused);
    animation: none;
  }

  .refusal {
    margin: 0 0 0.4rem;
    font-size: var(--step--2);
    line-height: 1.5;
    color: var(--refused);
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
