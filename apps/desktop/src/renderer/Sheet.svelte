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
const componentId = $props.id();
const titleId = `${componentId}-title`;

let closeButton = $state<HTMLButtonElement | null>(null);
let returnFocus: HTMLElement | null = null;
let wasOpen = false;

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

$effect(() => {
  if (open && !wasOpen) {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => closeButton?.focus());
  } else if (!open && wasOpen) {
    const target = returnFocus;
    returnFocus = null;
    queueMicrotask(() => {
      // A nonmodal Sheet may yield focus to the manuscript before it closes.
      // Restore only when removing the Sheet itself left focus nowhere useful.
      if (target?.isConnected && document.activeElement === document.body) target.focus();
    });
  }
  wasOpen = open;
});
</script>

{#if open}
  <div class="scrim" aria-hidden="true"></div>

  <dialog
    open
    class="sheet"
    style="--sheet-width: {width}"
    aria-labelledby={titleId}
  >
    <header>
      <h2 id={titleId}>{title}</h2>
      <button
        class="close"
        bind:this={closeButton}
        onclick={onClose}
        aria-label={localise("sheet.close")}>✕</button
      >
    </header>

    <div class="body">
      {@render children()}
    </div>

    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </dialog>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: color-mix(in oklab, var(--paper-sunk) 50%, transparent);
    pointer-events: none;
    animation: fade 140ms var(--ease);
  }

  .sheet {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    left: auto;
    z-index: 71;
    width: var(--sheet-width);
    height: 100vh;
    max-width: 92vw;
    max-height: none;
    margin: 0 0 0 auto;
    padding: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border: 0;
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
