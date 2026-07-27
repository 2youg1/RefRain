<script lang="ts">
import type { Snippet } from "svelte";
import { type Key, translator } from "./i18n.ts";
import { loadPreferences } from "./preferences.ts";

interface Props {
  open: boolean;
  title: string;
  width?: string;
  onClose: () => void;
  children: Snippet;
  footer?: Snippet;
  /**
   * Optional so the shell need not thread it through six call sites at once.
   * When absent the stored language is read instead — see `localise`.
   */
  t?: (key: Key) => string;
}

const { open, title, width = "420px", onClose, children, footer, t }: Props = $props();

/*
 * The close button used to be labelled "close" in every language: the one
 * control a screen reader announces on this surface, and it announced it in
 * English to an author reading Chinese. The language is re-read whenever a
 * sheet appears, so a switch made in Settings is spoken correctly the next
 * time one opens; passing `t` in makes it immediate.
 */
const localise = $derived.by(() => {
  if (t) return t;
  void open;
  return translator(loadPreferences().lang);
});
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onClose}></div>

  <aside class="sheet" style="--sheet-width: {width}">
    <header>
      <h2>{title}</h2>
      <button class="close" onclick={onClose} aria-label={localise("sheet.close")}>✕</button>
    </header>

    <div class="body">
      {@render children()}
    </div>

    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </aside>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: color-mix(in oklab, var(--paper-sunk) 50%, transparent);
    animation: fade 140ms var(--ease);
  }

  .sheet {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 71;
    width: var(--sheet-width);
    max-width: 92vw;
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border-left: 1px solid var(--rule-strong);
    box-shadow: var(--shadow-float);
    animation: slide 200ms var(--ease);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.5rem 1.5rem 1rem;
  }

  h2 {
    font-family: var(--serif);
    font-size: var(--step-2);
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  .close {
    color: var(--ink-ghost);
    font-size: var(--step-0);
    line-height: 1;
    padding: 0.35rem;
  }

  .close:hover {
    color: var(--seal);
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 1.5rem 1.5rem;
  }

  footer {
    padding: 0.9rem 1.5rem;
    border-top: 1px solid var(--rule);
    background: var(--paper);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes slide {
    from {
      transform: translateX(12px);
      opacity: 0;
    }
  }
</style>
