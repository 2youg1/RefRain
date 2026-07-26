<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
  open: boolean;
  title: string;
  width?: string;
  onClose: () => void;
  children: Snippet;
  footer?: Snippet;
}

const { open, title, width = "420px", onClose, children, footer }: Props = $props();

/**
 * One sheet at a time, opened on demand and dismissed with Escape. The
 * alternative — three panels standing open forever — forces every feature to
 * occupy screen whether or not the author is using it, which is how the
 * previous build filled itself with buttons.
 */
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") onClose();
};
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim" onclick={onClose}></div>

  <aside class="sheet" style="--sheet-width: {width}">
    <header>
      <h2>{title}</h2>
      <button class="close" onclick={onClose} aria-label="close">✕</button>
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
