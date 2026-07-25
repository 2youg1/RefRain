<script lang="ts">
import type { ProposalView, SliceView, VerdictView } from "./api.ts";

interface Props {
  proposals: ProposalView[];
  comments: { target: string; text: string }[];
  onCommit: (verdicts: VerdictView[]) => void;
  refusal: { reason: string; detail: string[] } | null;
}

const { proposals, comments, onCommit, refusal }: Props = $props();

// Staged judgments, keyed by slice. Nothing here has touched the manuscript.
let staged = $state<Record<string, VerdictView>>({});
let editing = $state<string | null>(null);
let draft = $state("");
let reasonFor = $state<string | null>(null);

const stagedCount = $derived(Object.keys(staged).length);

const judge = (
  proposal: ProposalView,
  slice: SliceView,
  kind: VerdictView["kind"],
  finalText?: string,
): void => {
  const existing = staged[slice.id];
  if (existing?.kind === kind && finalText === undefined) {
    const { [slice.id]: _, ...rest } = staged;
    staged = rest;
    return;
  }
  staged = {
    ...staged,
    [slice.id]: {
      id: `v-${slice.id}-${Date.now()}`,
      proposalId: proposal.id,
      sliceId: slice.id,
      kind,
      baseline: proposal.baseline,
      decidedAt: new Date().toISOString(),
      ...(finalText === undefined ? {} : { finalText }),
      ...(existing?.reason === undefined ? {} : { reason: existing.reason }),
    },
  };
};

const setReason = (sliceId: string, reason: string): void => {
  const verdict = staged[sliceId];
  if (!verdict) return;
  staged = {
    ...staged,
    [sliceId]:
      reason.trim().length === 0
        ? { ...verdict, reason: undefined }
        : { ...verdict, reason: reason.trim() },
  };
  reasonFor = null;
};

const beginEdit = (slice: SliceView): void => {
  editing = slice.id;
  draft = staged[slice.id]?.finalText ?? slice.text;
};
</script>

<div class="review">
  {#if proposals.length === 0 && comments.length === 0}
    <div class="empty">
      <p class="label">尚无提案</p>
      <p>把段落交给 Agent，结果回来后在这里逐句裁决。</p>
    </div>
  {:else}
    {#each proposals as proposal (proposal.id)}
      <article class="proposal">
        <header>
          <span class="label">提案 {proposal.id}</span>
          <span class="scope">作用于 {proposal.scope.id}</span>
        </header>

        {#each proposal.slices as slice (slice.id)}
          {@const verdict = staged[slice.id]}
          <div class="row">
            <div
              class="slice {slice.kind} {verdict ? `judged-${verdict.kind}` : ''}"
              class:editing={editing === slice.id}
            >
              {#if editing === slice.id}
                <textarea bind:value={draft} rows="3"></textarea>
                <div class="edit-actions">
                  <button
                    class="primary"
                    onclick={() => {
                      judge(proposal, slice, "accept-modified", draft);
                      editing = null;
                    }}>用我的写法</button
                  >
                  <button onclick={() => (editing = null)}>取消</button>
                </div>
              {:else}
                {slice.text}
              {/if}
            </div>

            {#if slice.kind !== "same" && editing !== slice.id}
              <div class="actions">
                <button
                  class:on={verdict?.kind === "accept"}
                  title="接受"
                  onclick={() => judge(proposal, slice, "accept")}>接受</button
                >
                <button
                  class:on={verdict?.kind === "reject"}
                  title="拒绝"
                  onclick={() => judge(proposal, slice, "reject")}>拒绝</button
                >
                {#if slice.kind === "ins"}
                  <button title="改写后接受" onclick={() => beginEdit(slice)}>改写</button>
                {/if}
                {#if verdict}
                  <button
                    class="reason-toggle"
                    class:has={verdict.reason !== undefined}
                    title="写下理由"
                    onclick={() => (reasonFor = reasonFor === slice.id ? null : slice.id)}
                    >理由</button
                  >
                {/if}
              </div>
            {/if}
          </div>

          {#if reasonFor === slice.id}
            <div class="reason">
              <input
                placeholder="为什么这样判断——这句会随下一轮送回给 Agent"
                value={staged[slice.id]?.reason ?? ""}
                onkeydown={(e) => {
                  if (e.key === "Enter") setReason(slice.id, e.currentTarget.value);
                  if (e.key === "Escape") reasonFor = null;
                }}
                onblur={(e) => setReason(slice.id, e.currentTarget.value)}
              />
            </div>
          {:else if staged[slice.id]?.reason}
            <p class="reason-shown">「{staged[slice.id]?.reason}」</p>
          {/if}
        {/each}
      </article>
    {/each}

    {#each comments as comment (comment.target + comment.text)}
      <aside class="comment">
        <span class="label">批注 · {comment.target}</span>
        <p>{comment.text}</p>
      </aside>
    {/each}
  {/if}
</div>

{#if refusal}
  <div class="refusal">
    <strong>整批未合并：{refusal.reason}</strong>
    {#each refusal.detail as line (line)}<span>{line}</span>{/each}
  </div>
{/if}

{#if stagedCount > 0}
  <footer class="commit-bar">
    <span>{stagedCount} 项裁决待合并</span>
    <div>
      <button onclick={() => (staged = {})}>全部撤下</button>
      <button
        class="primary"
        onclick={() => {
          onCommit(Object.values(staged));
          staged = {};
        }}>合并进正文</button
      >
    </div>
  </footer>
{/if}

<style>
  .review {
    padding: 1.5rem 1.75rem 6rem;
    overflow-y: auto;
    height: 100%;
  }

  .empty {
    color: var(--ink-faint);
    padding: 4rem 1rem;
    text-align: center;
    line-height: 2;
  }

  .proposal {
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    border-radius: 4px;
    box-shadow: var(--shadow-raised);
    margin-bottom: 1.25rem;
    overflow: hidden;
  }

  .proposal header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid var(--rule);
    background: linear-gradient(var(--paper), var(--paper-raised));
  }

  .scope {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--ink-faint);
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0 0.5rem;
  }

  .row .slice {
    flex: 1;
    min-width: 0;
  }

  .actions {
    display: flex;
    gap: 0.15rem;
    padding-top: 0.5rem;
    opacity: 0;
    transition: opacity 120ms ease;
  }

  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
  }

  .actions button {
    font-size: 11px;
    padding: 0.25rem 0.45rem;
    border-radius: 3px;
    color: var(--ink-soft);
    white-space: nowrap;
  }

  .actions button:hover {
    background: var(--paper);
    color: var(--ink);
  }

  .actions button.on {
    background: var(--ink);
    color: var(--paper-raised);
  }

  .reason-toggle.has {
    color: var(--seal);
  }

  .reason {
    padding: 0 0.9rem 0.6rem 1.4rem;
  }

  .reason-shown {
    padding: 0 0.9rem 0.55rem 1.4rem;
    color: var(--seal);
    font-family: var(--serif);
    font-size: 13px;
  }

  .edit-actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .edit-actions button,
  .commit-bar button {
    font-size: 12px;
    padding: 0.35rem 0.7rem;
    border-radius: 3px;
    border: 1px solid var(--rule-strong);
    background: var(--paper-raised);
  }

  .primary {
    background: var(--ink) !important;
    color: var(--paper-raised);
    border-color: var(--ink) !important;
  }

  .comment {
    border-left: 2px solid var(--rule-strong);
    padding: 0.5rem 0.9rem;
    margin-bottom: 1rem;
    color: var(--ink-soft);
    font-family: var(--serif);
  }

  .refusal {
    position: absolute;
    bottom: 4.5rem;
    left: 1.75rem;
    right: 1.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.75rem 0.9rem;
    background: var(--refused-soft);
    border: 1px solid var(--refused);
    border-radius: 4px;
    font-size: 12px;
    color: var(--refused);
  }

  .commit-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1.75rem;
    background: var(--paper-raised);
    border-top: 1px solid var(--rule-strong);
    font-size: 12px;
    color: var(--ink-soft);
  }

  .commit-bar div {
    display: flex;
    gap: 0.4rem;
  }
</style>
