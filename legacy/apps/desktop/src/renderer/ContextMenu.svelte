<script lang="ts">
  import type { Key } from "./i18n.ts";

  interface Props {
    x: number;
    y: number;
    selection: string;
    bindings: Record<string, string>;
    t: (key: Key) => string;
    onFormat: (mark: "bold" | "italic" | "strike" | "code") => void;
    onAnnotate: () => void;
    onDispatch: () => void;
    onClose: () => void;
  }

  const { x, y, selection, bindings, t, onFormat, onAnnotate, onDispatch, onClose }: Props =
    $props();

  /**
   * The menu that appears where the author is looking.
   *
   * Formatting and handing a passage to an agent belong in the same place,
   * because from the author's side they are the same gesture: I have chosen
   * this run of text and I want to do something to it.
   */
  const has = $derived(selection.trim().length > 0);

  // Kept inside the window even when the click lands near an edge.
  const left = $derived(Math.min(x, window.innerWidth - 240));
  const top = $derived(Math.min(y, window.innerHeight - 300));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onClose} oncontextmenu={(e) => { e.preventDefault(); onClose(); }}></div>

<menu class="menu" style="left: {left}px; top: {top}px">
  <div class="marks">
    <button onclick={() => onFormat("bold")} title={t("edit.bold")}><b>B</b></button>
    <button onclick={() => onFormat("italic")} title={t("edit.italic")}><i>I</i></button>
    <button onclick={() => onFormat("strike")} title={t("edit.strike")}><s>S</s></button>
    <button onclick={() => onFormat("code")} title={t("edit.code")}><code>{"<>"}</code></button>
  </div>

  <hr />

  <button class="item" disabled={!has} onclick={onAnnotate}>
    <span>{t("edit.annotate")}</span>
  </button>

  <button class="item accent" disabled={!has} onclick={onDispatch}>
    <span>{t("edit.toAgent")}</span>
    <kbd>{bindings.dispatch}</kbd>
  </button>

  {#if !has}
    <p class="hint">{t("edit.selectFirst")}</p>
  {/if}
</menu>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 96;
  }

  .menu {
    position: fixed;
    z-index: 97;
    min-width: 210px;
    margin: 0;
    padding: 0.3rem;
    list-style: none;
    background: color-mix(in oklab, var(--paper-raised) 92%, transparent);
    backdrop-filter: blur(20px) saturate(1.2);
    -webkit-backdrop-filter: blur(20px) saturate(1.2);
    border: 1px solid var(--rule-strong);
    border-radius: 6px;
    box-shadow: var(--shadow-float);
    animation: appear 140ms var(--spring);
    transform-origin: top left;
  }

  .marks {
    display: flex;
    gap: 1px;
    padding: 0.15rem;
  }

  .marks button {
    flex: 1;
    padding: 0.4rem 0;
    border-radius: 3px;
    color: var(--ink-soft);
    font-size: var(--step--1);
  }

  .marks button:hover {
    background: var(--paper-sunk);
    color: var(--ink);
  }

  .marks code {
    font-family: var(--mono);
    font-size: var(--step--2);
  }

  hr {
    height: 1px;
    margin: 0.3rem 0.15rem;
    border: none;
    background: var(--rule);
  }

  .item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1.2rem;
    width: 100%;
    padding: 0.42rem 0.6rem;
    border-radius: 3px;
    text-align: left;
    font-size: var(--step--1);
    color: var(--ink-soft);
  }

  .item:hover:not(:disabled) {
    background: var(--paper-sunk);
    color: var(--ink);
  }

  .item:disabled {
    color: var(--ink-ghost);
    cursor: not-allowed;
  }

  .item.accent:hover:not(:disabled) {
    background: var(--seal-wash);
    color: var(--seal);
  }

  kbd {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }

  .hint {
    padding: 0.35rem 0.6rem 0.5rem;
    font-size: var(--step--2);
    color: var(--ink-ghost);
    line-height: 1.6;
  }

  @keyframes appear {
    from {
      opacity: 0;
      transform: scale(0.94) translateY(-4px);
    }
  }
</style>
