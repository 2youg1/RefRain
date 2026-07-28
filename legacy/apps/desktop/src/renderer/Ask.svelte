<script lang="ts">
import type { Key } from "./i18n.ts";

/**
 * One line of text, asked for and answered.
 *
 * `window.prompt` is disabled in Electron, and four entrances to "new chapter"
 * — the rail button, the command palette, Ctrl+N, and the empty page — all
 * called it, so all four did nothing at all. Nothing failed loudly; the writer
 * pressed a button and the application declined to react.
 *
 * A shared primitive rather than a dialog per caller: new chapter, new file,
 * and rename are the same question, and a second hand-rolled input is how the
 * focus trap gets forgotten on one of them.
 */

interface Props {
  open: boolean;
  title: string;
  /** Shown under the field: what will be created, or why the answer is refused. */
  hint?: string;
  initial?: string;
  confirm: Key;
  t: (key: Key) => string;
  /** Return a reason to refuse, or null to accept. Runs as the writer types. */
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

const { open, title, hint, initial = "", confirm, t, validate, onSubmit, onCancel }: Props =
  $props();

let value = $state("");
let field = $state<HTMLInputElement | null>(null);
let touched = $state(false);

const refusal = $derived(validate?.(value.trim()) ?? null);
const ready = $derived(value.trim().length > 0 && refusal === null);

$effect(() => {
  if (!open) return;
  value = initial;
  touched = false;
  // The field is the only reason this is on screen, so it takes focus itself
  // rather than making the writer click into it.
  queueMicrotask(() => field?.select());
});

const submit = (): void => {
  touched = true;
  if (ready) onSubmit(value.trim());
};

/*
 * Escape closes this, not whatever is behind it.
 *
 * Sheets register their own window-level Escape handler, so an unstopped key
 * press here would cancel the input *and* close the panel underneath — one
 * key, two dismissals, and the writer loses the place they were working in.
 */
const onKey = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    submit();
  }
};

/** Tab must not walk out of a modal into the manuscript behind it. */
const trap = (event: KeyboardEvent): void => {
  if (event.key !== "Tab") return;
  const focusable = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      "input, button:not([disabled])",
    ),
  ];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="veil"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    onkeydown={trap}
    onclick={(event) => event.target === event.currentTarget && onCancel()}
  >
    <div class="ask">
      <p class="title">{title}</p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:this={field}
        bind:value
        onkeydown={onKey}
        oninput={() => (touched = true)}
        aria-label={title}
        aria-invalid={touched && refusal !== null}
        spellcheck="false"
      />
      {#if touched && refusal}
        <p class="refusal">{refusal}</p>
      {:else if hint}
        <p class="hint">{hint}</p>
      {/if}
      <div class="row">
        <button class="quiet" onclick={onCancel}>{t("review.cancel")}</button>
        <button class="primary" disabled={!ready} onclick={submit}>{t(confirm)}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .veil {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklch, var(--ink) 22%, transparent);
    backdrop-filter: blur(2px);
    z-index: 60;
  }

  .ask {
    width: min(26rem, calc(100vw - 3rem));
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    padding: 1.2rem 1.3rem;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
    box-shadow: 0 18px 48px color-mix(in oklch, var(--ink) 18%, transparent);
  }

  .title {
    margin: 0;
    font-size: 0.95rem;
    color: var(--ink);
  }

  input {
    padding: 0.5rem 0.6rem;
    font: inherit;
    font-size: 0.95rem;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
  }

  input:focus-visible {
    outline: 2px solid var(--seal);
    outline-offset: 1px;
  }

  .hint,
  .refusal {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.5;
  }

  .hint {
    color: var(--ink-faint);
  }

  .refusal {
    color: var(--refused);
  }

  .row {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  button {
    padding: 0.4rem 0.9rem;
    font: inherit;
    font-size: 0.85rem;
    border-radius: 2px;
    cursor: pointer;
  }

  .quiet {
    color: var(--ink-soft);
    background: none;
    border: 1px solid var(--rule);
  }

  .primary {
    color: var(--paper);
    background: var(--seal);
    border: 1px solid var(--seal);
  }

  .primary:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
