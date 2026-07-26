<script lang="ts">
  
  import type { Key } from "./i18n.ts";
import Mark from "./Mark.svelte";

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
    icon: string | null;
    inverted?: boolean;
    onOpen: () => void;
    onClose: () => void;
  }

  const { open, commands, t, icon, inverted = false, onOpen, onClose }: Props = $props();

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
    if (haystack.startsWith(needle)) return 4;
    if (haystack.includes(needle)) return 3;

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

<!--
  The one control that is always on screen. Everything the application can do is
  behind it, so the interface needs no permanent toolbar and the manuscript
  keeps the room a toolbar would have taken.
-->
<button class="key" class:lifted={open} onclick={onOpen} aria-label={t("palette.hint")}>
  <Mark size={22} custom={icon} {inverted} />
</button>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onClose}></div>

  <!-- The scrim owns dismissal; the menu simply sits above it. -->
  <nav class="menu">
    <div class="field">
      <Mark size={22} custom={icon} />
      <input
        bind:this={field}
        bind:value={query}
        oninput={() => (cursor = 0)}
        onkeydown={onKeydown}
        placeholder={t("palette.placeholder")}
        spellcheck="false"
        autocomplete="off"
      />
    </div>

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

    <footer>
      <span><kbd>↑↓</kbd> {t("palette.navigate")}</span>
      <span><kbd>↵</kbd> {t("palette.run")}</span>
      <span><kbd>esc</kbd> {t("palette.dismiss")}</span>
    </footer>
  </nav>
{/if}

<style>
  /*
   * In the layout, not over it. Absolute positioning put this on top of the
   * rail's own content twice — first the two commands that create things, then
   * the first root's name. A button that covers the interface it opens is a
   * defect no amount of restyling fixes.
   */
  .key {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 7px;
    background: transparent;
    border: 1px solid transparent;
    flex: none;
    transition:
      transform 220ms var(--spring),
      background 200ms var(--ease),
      border-color 200ms var(--ease);
  }

  .key:hover {
    transform: scale(1.08) rotate(-3deg);
    background: color-mix(in oklab, currentColor 10%, transparent);
  }

  .key:active {
    transform: translateY(0) scale(0.94);
    transition-duration: 90ms;
  }

  /* While the menu is open the button reads as its origin, not as a duplicate. */
  .key.lifted {
    transform: scale(0.82);
    opacity: 0;
    pointer-events: none;
  }

  /* Enough blur that what is behind reads as light, not as legible text. */
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 93;
    background: color-mix(in oklab, var(--ink) 22%, transparent);
    backdrop-filter: blur(24px) saturate(1.15);
    -webkit-backdrop-filter: blur(24px) saturate(1.15);
    animation: fade 200ms var(--ease);
  }

  .menu {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 94;
    width: min(400px, 84vw);
    display: flex;
    flex-direction: column;
    background: color-mix(
      in oklab,
      var(--paper-raised) calc(var(--surface-alpha, 1) * 96%),
      transparent
    );
    backdrop-filter: blur(40px) saturate(1.3);
    -webkit-backdrop-filter: blur(40px) saturate(1.3);
    border-right: 1px solid var(--rule-strong);
    box-shadow: var(--shadow-float);
    animation: slide-in 300ms var(--spring);
  }

  .field {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 1.15rem 1.15rem 0.9rem;
    border-bottom: 1px solid var(--rule);
  }

  .field input {
    border: none;
    border-radius: 0;
    padding: 0;
    background: transparent;
    font-size: var(--step-0);
    font-family: var(--serif);
  }

  .field input:focus {
    box-shadow: none;
  }

  .results {
    overflow-y: auto;
    padding: 0.35rem 0 0.5rem;
    max-height: calc(100vh - 8.5rem);
  }

  .group {
    padding: 0.75rem 1.15rem 0.3rem;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.34rem 1.15rem;
    text-align: left;
    color: var(--ink-soft);
    border-left: 2px solid transparent;
    transition: none;
  }

  .row.on {
    background: color-mix(in oklab, var(--seal) 14%, transparent);
    color: var(--ink);
    border-left-color: var(--seal);
    font-weight: 500;
  }

  .text {
    font-size: var(--step--1);
  }

  kbd {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
    letter-spacing: 0.03em;
  }

  .empty {
    padding: 1.6rem 1.15rem;
    color: var(--ink-faint);
    font-family: var(--serif);
  }

  footer {
    display: flex;
    gap: 1.1rem;
    margin-top: auto;
    padding: 0.6rem 1.15rem;
    border-top: 1px solid var(--rule);
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  footer kbd {
    margin-right: 0.25rem;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes slide-in {
    from {
      transform: translateX(-26px);
      opacity: 0;
    }
  }
</style>
