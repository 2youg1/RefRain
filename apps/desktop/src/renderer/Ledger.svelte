<script lang="ts">
import type { VerdictView } from "./api.ts";
import { api } from "./api.ts";

const { root }: { root: string | null } = $props();

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

const label: Record<string, string> = {
  accept: "接受",
  "accept-modified": "改写后接受",
  reject: "拒绝",
  "comment-only": "仅批注",
};
</script>

<div class="ledger">
  {#if verdicts.length === 0}
    <div class="empty">
      <p class="label">账本是空的</p>
      <p>每一次裁决都会留在这里——包括你写下的理由。它们会随下一轮送回给 Agent。</p>
    </div>
  {:else}
    <p class="label">{verdicts.length} 项裁决</p>
    {#each verdicts as verdict (verdict.id)}
      <article class="entry">
        <header>
          <span class="kind {verdict.kind}">{label[verdict.kind] ?? verdict.kind}</span>
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
          <p class="no-reason">未写理由</p>
        {/if}
      </article>
    {/each}
  {/if}

  {#if reply}
    <div class="reply">
      <div class="reply-head">
        <span class="label">送回 Agent 的内容</span>
        <button onclick={() => (reply = null)}>关闭</button>
      </div>
      <pre>{reply}</pre>
    </div>
  {/if}
</div>

<style>
  .ledger {
    padding: 1.25rem 1.5rem 3rem;
    overflow-y: auto;
    height: 100%;
  }

  .empty {
    color: var(--ink-faint);
    padding: 3rem 0;
    text-align: center;
    line-height: 2;
  }

  .entry {
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .entry header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 11px;
  }

  .kind {
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    font-size: 10px;
  }

  .kind.accept {
    color: var(--accepted);
    background: var(--accepted-soft);
  }

  .kind.reject {
    color: var(--refused);
    background: var(--refused-soft);
  }

  .kind\\.accept-modified {
    color: var(--seal);
    background: var(--seal-soft);
  }

  .ref {
    font-family: var(--mono);
    color: var(--ink-faint);
  }

  .ref:hover {
    color: var(--seal);
  }

  time {
    margin-left: auto;
    color: var(--ink-faint);
  }

  .final {
    font-family: var(--serif);
    font-size: 13px;
    margin-top: 0.3rem;
  }

  .reason {
    font-family: var(--serif);
    font-size: 12px;
    color: var(--seal);
    margin-top: 0.2rem;
  }

  .no-reason {
    font-size: 11px;
    color: var(--ink-faint);
    margin-top: 0.2rem;
  }

  .reply {
    position: absolute;
    inset: 1rem;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    box-shadow: var(--shadow-raised);
    display: flex;
    flex-direction: column;
  }

  .reply-head {
    display: flex;
    justify-content: space-between;
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--rule);
  }

  .reply-head button {
    font-size: 11px;
    color: var(--ink-faint);
  }

  pre {
    flex: 1;
    overflow: auto;
    padding: 0.8rem;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.7;
    white-space: pre-wrap;
  }
</style>
