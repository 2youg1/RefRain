<script lang="ts">
import type { Key } from "./i18n.ts";

export interface Command {
  id: string;
  label: Key;
  group: Key;
  keys?: string;
  run: () => void;
  when?: () => boolean;
}

interface Props {
  open: boolean;
  commands: Command[];
  t: (key: Key) => string;
  onClose: () => void;
}

const { open, commands, t, onClose }: Props = $props();

let query = $state("");
let cursor = $state(0);
let field = $state<HTMLInputElement | null>(null);

const available = $derived(commands.filter((c) => c.when?.() ?? true));

/**
 * Subsequence matching, so `nc` reaches "New chapter" the way a fuzzy finder
 * does. Matching runs against the translated label: the author searches in
 * the language they are reading.
 */
const score = (label: string, q: string): number => {
  if (q.length === 0) return 1;
  const haystack = label.toLowerCase();
  const needle = q.toLowerCase();
  if (haystack.startsWith(needle)) return 3;
  if (haystack.includes(needle)) return 2;

  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at) + 1;
    if (at === 0) return 0;
  }
  return 1;
};

const matches = $derived(
  available
    .map((command) => ({ command, rank: score(t(command.label), query) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank),
);

const grouped = $derived(
  matches.reduce<{ group: Key; items: Command[] }[]>((acc, { command }) => {
    const bucket = acc.find((g) => g.group === command.group);
    if (bucket) bucket.items.push(command);
    else acc.push({ group: command.group, items: [command] });
    return acc;
  }, []),
);

const flat = $derived(grouped.flatMap((g) => g.items));

$effect(() => {
  if (open) {
    query = "";
    cursor = 0;
    queueMicrotask(() => field?.focus());
  }
});

const choose = (command: Command | undefined): void => {
  if (!command) return;
  onClose();
  command.run();
};

const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") return onClose();
  if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
    event.preventDefault();
    cursor = Math.min(cursor + 1, flat.length - 1);
  } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
    event.preventDefault();
    cursor = Math.max(cursor - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    choose(flat[cursor]);
  }
};
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="palette" onclick={(e) => e.stopPropagation()}>
      <input
        bind:this={field}
        bind:value={query}
        oninput={() => (cursor = 0)}
        onkeydown={onKeydown}
        placeholder={t("palette.placeholder")}
        spellcheck="false"
        autocomplete="off"
      />

      <div class="results">
        {#if flat.length === 0}
          <p class="empty">{t("palette.empty")}</p>
        {/if}

        {#each grouped as group (group.group)}
          <p class="group label">{t(group.group)}</p>
          {#each group.items as command (command.id)}
            {@const index = flat.indexOf(command)}
            <button
              class="row"
              class:on={index === cursor}
              onmouseenter={() => (cursor = index)}
              onclick={() => choose(command)}
            >
              <span class="text">{t(command.label)}</span>
              {#if command.keys}<kbd>{command.keys}</kbd>{/if}
            </button>
          {/each}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 16vh;
    background: color-mix(in oklab, var(--paper-sunk) 62%, transparent);
    backdrop-filter: blur(3px) saturate(0.9);
    animation: fade 120ms var(--ease);
  }

  .palette {
    width: min(560px, 88vw);
    max-height: 62vh;
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    box-shadow: var(--shadow-float);
    overflow: hidden;
    animation: rise 160ms var(--ease);
  }

  .palette input {
    border: none;
    border-bottom: 1px solid var(--rule);
    border-radius: 0;
    padding: 1rem 1.15rem;
    font-size: var(--step-1);
    font-family: var(--serif);
    background: transparent;
  }

  .palette input:focus {
    box-shadow: none;
    border-color: var(--rule);
  }

  .results {
    overflow-y: auto;
    padding: 0.4rem 0 0.5rem;
  }

  .group {
    padding: 0.7rem 1.15rem 0.3rem;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.44rem 1.15rem;
    text-align: left;
    color: var(--ink-soft);
    border-left: 2px solid transparent;
  }

  .row.on {
    background: var(--paper-sunk);
    color: var(--ink);
    border-left-color: var(--seal);
  }

  .text {
    font-size: var(--step-0);
  }

  kbd {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
    letter-spacing: 0.04em;
  }

  .empty {
    padding: 1.6rem 1.15rem;
    color: var(--ink-faint);
    font-family: var(--serif);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.99);
    }
  }
</style>
