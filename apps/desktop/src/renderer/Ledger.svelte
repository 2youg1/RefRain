<script lang="ts">
import type { VerdictView } from "./api.ts";
import { api } from "./api.ts";
import type { Key } from "./i18n.ts";

interface Props {
  root: string | null;
  t: (key: Key) => string;
}

const { root, t }: Props = $props();

let verdicts = $state<VerdictView[]>([]);
let reply = $state<string | null>(null);

$effect(() => {
  if (root)
    void api()
      .ledger(root)
      .then((all) => (verdicts = all));
});

const showReply = async (proposalId: string): Promise<void> => {
  if (!root) return;
  reply = await api().reply(root, proposalId);
};

const kindKey = (kind: VerdictView["kind"]): Key => `kind.${kind}` as Key;
</script>

<div class="ledger">
  {#if verdicts.length === 0}
    <p class="empty">{t("ledger.empty")}</p>
  {:else}
    <p class="count label">{verdicts.length} {t("ledger.count")}</p>

    {#each verdicts as verdict (verdict.id)}
      <article>
        <header>
          <span class="kind {verdict.kind}">{t(kindKey(verdict.kind))}</span>
          <button class="ref" onclick={() => showReply(verdict.proposalId)}>
            {verdict.sliceId ?? verdict.proposalId}
          </button>
          <time>{verdict.decidedAt.slice(0, 16).replace("T", " ")}</time>
        </header>

        {#if verdict.finalText}
          <p class="final">{verdict.finalText}</p>
        {/if}

        {#if verdict.reason}
          <p class="reason">「{verdict.reason}」</p>
        {:else}
          <p class="no-reason">{t("ledger.noReason")}</p>
        {/if}
      </article>
    {/each}
  {/if}
</div>

{#if reply}
  <div class="reply">
    <header>
      <span class="label">{t("ledger.reply")}</span>
      <button onclick={() => (reply = null)}>{t("ledger.close")}</button>
    </header>
    <pre>{reply}</pre>
  </div>
{/if}

<style>
  .empty {
    font-family: var(--serif);
    color: var(--ink-faint);
    line-height: 1.95;
    padding: 1rem 0;
  }

  .count {
    padding-bottom: 0.5rem;
  }

  article {
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--rule);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-size: var(--step--2);
  }

  .kind {
    padding: 0.12rem 0.4rem;
    border-radius: 2px;
    letter-spacing: 0.02em;
  }

  .kind.accept {
    color: var(--accepted);
    background: var(--accepted-wash);
  }

  .kind.reject {
    color: var(--refused);
    background: var(--refused-wash);
  }

  .kind.accept-modified {
    color: var(--seal);
    background: var(--seal-wash);
  }

  .ref {
    font-family: var(--mono);
    color: var(--ink-ghost);
  }

  .ref:hover {
    color: var(--seal);
  }

  time {
    margin-left: auto;
    color: var(--ink-ghost);
    font-family: var(--mono);
  }

  .final {
    font-family: var(--serif);
    font-size: var(--step-0);
    margin-top: 0.4rem;
    line-height: 1.8;
  }

  .reason {
    font-family: var(--serif);
    font-size: var(--step--1);
    color: var(--seal);
    margin-top: 0.25rem;
    line-height: 1.8;
  }

  .no-reason {
    font-size: var(--step--2);
    color: var(--ink-ghost);
    margin-top: 0.25rem;
  }

  .reply {
    position: fixed;
    inset: 12vh 12vw;
    z-index: 80;
    display: flex;
    flex-direction: column;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    box-shadow: var(--shadow-float);
  }

  .reply header {
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid var(--rule);
    justify-content: space-between;
  }

  .reply header button {
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  pre {
    flex: 1;
    overflow: auto;
    padding: 1.1rem;
    font-family: var(--mono);
    font-size: var(--step--1);
    line-height: 1.85;
    white-space: pre-wrap;
    color: var(--ink-soft);
  }
</style>
