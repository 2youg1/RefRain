<script lang="ts">
  import type { Key } from "./i18n.ts";
  import { localTime } from "./time.ts";

  export interface EditView {
    id: string;
    kind: "replace" | "insert" | "remove";
    blockId: string;
    before?: string;
    after?: string;
    at: string;
    note?: string;
  }

  interface Props {
    edits: EditView[];
    t: (key: Key) => string;
    onRevert: (id: string) => void;
    onRevertAll: () => void;
    onNote: (id: string, note: string) => void;
    onSendToAgent: () => void;
  }

  const { edits, t, onRevert, onRevertAll, onNote, onSendToAgent }: Props = $props();

  let noting = $state<string | null>(null);

  const kindKey = (kind: EditView["kind"]): Key => `edits.${kind}` as Key;
</script>

<div class="edits">
  {#if edits.length === 0}
    <p class="empty">{t("edits.empty")}</p>
  {:else}
    <header class="summary">
      <span class="label">{edits.length} {t("edits.count")}</span>
      <div>
        <button onclick={onSendToAgent}>{t("edits.toAgent")}</button>
        <button class="danger" onclick={onRevertAll}>{t("edits.revertAll")}</button>
      </div>
    </header>

    {#each edits as edit (edit.id)}
      <article>
        <div class="head">
          <span class="kind {edit.kind}">{t(kindKey(edit.kind))}</span>
          <time datetime={edit.at}>{localTime(edit.at)}</time>
          <button class="revert" onclick={() => onRevert(edit.id)}>{t("edits.revert")}</button>
        </div>

        {#if edit.before !== undefined}
          <p class="before">{edit.before}</p>
        {/if}
        {#if edit.after !== undefined}
          <p class="after">{edit.after}</p>
        {/if}

        {#if noting === edit.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            placeholder={t("edits.notePlaceholder")}
            value={edit.note ?? ""}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                onNote(edit.id, e.currentTarget.value);
                noting = null;
              }
              if (e.key === "Escape") noting = null;
            }}
            onblur={(e) => {
              onNote(edit.id, e.currentTarget.value);
              noting = null;
            }}
          />
        {:else if edit.note}
          <button class="note" onclick={() => (noting = edit.id)}>「{edit.note}」</button>
        {:else}
          <button class="add-note" onclick={() => (noting = edit.id)}>{t("edits.addNote")}</button>
        {/if}
      </article>
    {/each}
  {/if}
</div>

<style>
  .edits {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .empty {
    font-family: var(--serif);
    color: var(--ink-faint);
    line-height: 1.95;
    padding: 1rem 0;
  }

  .summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--rule);
  }

  .summary div {
    display: flex;
    gap: 0.35rem;
  }

  .summary button {
    font-size: var(--step--2);
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
  }

  .summary button:hover {
    border-color: var(--seal);
    color: var(--seal);
  }

  .summary .danger:hover {
    border-color: var(--refused);
    color: var(--refused);
  }

  article {
    padding: 0.55rem 0 0.7rem;
    border-bottom: 1px solid var(--rule);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--step--2);
  }

  .kind {
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
  }

  .kind.replace {
    color: var(--seal);
    background: var(--seal-wash);
  }

  .kind.insert {
    color: var(--accepted);
    background: var(--accepted-wash);
  }

  .kind.remove {
    color: var(--refused);
    background: var(--refused-wash);
  }

  time {
    color: var(--ink-ghost);
    font-family: var(--mono);
  }

  .revert {
    margin-left: auto;
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .revert:hover {
    color: var(--seal);
  }

  .before,
  .after {
    font-family: var(--serif);
    font-size: var(--step--1);
    line-height: 1.8;
    margin-top: 0.3rem;
    padding-left: 0.6rem;
    border-left: 2px solid transparent;
  }

  .before {
    color: var(--ink-faint);
    border-left-color: var(--refused);
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--refused) 40%, transparent);
  }

  .after {
    color: var(--ink);
    border-left-color: var(--accepted);
  }

  .note,
  .add-note {
    display: block;
    margin-top: 0.35rem;
    font-size: var(--step--2);
    text-align: left;
  }

  .note {
    color: var(--seal);
    font-family: var(--serif);
  }

  .add-note {
    color: var(--ink-ghost);
  }

  .add-note:hover {
    color: var(--seal);
  }
</style>
