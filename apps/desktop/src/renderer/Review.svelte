<script lang="ts">
import type { ProposalView, SliceView, VerdictView } from "./api.ts";
import type { Key } from "./i18n.ts";

interface Props {
  proposals: ProposalView[];
  comments: { target: string; text: string }[];
  t: (key: Key) => string;
  refusal: { reason: string; detail: string[] } | null;
  onCommit: (verdicts: VerdictView[]) => void;
  /**
   * Staged judgments, keyed by slice. Nothing here has touched the manuscript.
   *
   * Held by the shell rather than by this component. The sheet unmounts on
   * Escape, so owning them here meant a reader who had judged forty slices and
   * dismissed the panel to check the paragraph they were judging came back to
   * nothing. Judgments are what this application is for; they are the last
   * thing that should be cheap to lose.
   */
  staged: Record<string, VerdictView>;
  onStaged: (next: Record<string, VerdictView>) => void;
  /**
   * The rewrite the author is typing for a slice, before pressing "use mine".
   *
   * Same reason as `staged`: it is the author's own prose, and its only copy
   * was in a component the sheet unmounts on Escape.
   */
  draft: string;
  onDraft: (next: string) => void;
  /**
   * Which slice the rewrite box is open on.
   *
   * On its own this is a UI indicator. Once `draft` outlives the panel, this
   * has to as well: leaving it behind reopens the panel with the text intact
   * and the box shut, which the author reads as the text being gone.
   */
  editing: string | null;
  onEditing: (next: string | null) => void;
}

const {
  proposals,
  comments,
  t,
  refusal,
  onCommit,
  staged,
  onStaged,
  draft,
  onDraft,
  editing,
  onEditing,
}: Props = $props();
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
    const { [slice.id]: _removed, ...rest } = staged;
    onStaged(rest);
    return;
  }

  onStaged({
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
  });
};

/**
 * Stage one verdict for every slice in a proposal (SPEC Q6).
 *
 * The action an author wanted was never "merge without judging" — it was "I
 * have read all twenty and I agree, stop making me click". Those two differ
 * in the ledger, and the ledger is the point: this writes twenty separate
 * verdicts, each revisable on its own, where a single "accepted the lot" row
 * would lose exactly the grain the Verdict Ledger exists to keep.
 *
 * It stages. The author still presses Merge, and sees the whole proposal lit
 * up before doing so.
 */
const judgeAll = (proposal: ProposalView, kind: "accept" | "reject"): void => {
  const decidedAt = new Date().toISOString();
  const next = { ...staged };
  for (const slice of proposal.slices) {
    if (slice.kind === "same") continue;
    next[slice.id] = {
      id: `v-${slice.id}-${Date.now()}`,
      proposalId: proposal.id,
      sliceId: slice.id,
      kind,
      baseline: proposal.baseline,
      decidedAt,
      ...(staged[slice.id]?.reason === undefined ? {} : { reason: staged[slice.id]?.reason }),
    };
  }
  onStaged(next);
};

/** How many of this proposal's judgable slices already carry a verdict. */
const judgedIn = (proposal: ProposalView): number =>
  proposal.slices.filter((slice) => slice.kind !== "same" && staged[slice.id]).length;

const judgableIn = (proposal: ProposalView): number =>
  proposal.slices.filter((slice) => slice.kind !== "same").length;

const setReason = (sliceId: string, reason: string): void => {
  const verdict = staged[sliceId];
  if (!verdict) return;
  const trimmed = reason.trim();
  const { reason: _dropped, ...rest } = verdict;
  onStaged({ ...staged, [sliceId]: trimmed.length === 0 ? rest : { ...rest, reason: trimmed } });
  reasonFor = null;
};
</script>

<div class="review">
  {#if proposals.length === 0 && comments.length === 0}
    <p class="empty">{t("review.empty")}</p>
  {/if}

  {#each proposals as proposal (proposal.id)}
    <article class="proposal">
      <header>
        <span class="label">{proposal.id}</span>
        <span class="scope">{proposal.scope.id}</span>
        {#if judgableIn(proposal) > 1}
          <span class="progress">{judgedIn(proposal)}/{judgableIn(proposal)}</span>
          <div class="bulk">
            <button onclick={() => judgeAll(proposal, "accept")}>{t("review.acceptAll")}</button>
            <button onclick={() => judgeAll(proposal, "reject")}>{t("review.rejectAll")}</button>
          </div>
        {/if}
      </header>

      {#each proposal.slices as slice (slice.id)}
        {@const verdict = staged[slice.id]}
        <div class="row">
          <div class="slice {slice.kind}" class:judged={verdict !== undefined}>
            {#if editing === slice.id}
              <textarea
                value={draft}
                oninput={(event) => onDraft(event.currentTarget.value)}
                rows="3"
              ></textarea>
              <div class="edit-actions">
                <button
                  class="primary"
                  onclick={() => {
                    judge(proposal, slice, "accept-modified", draft);
                    onEditing(null);
                  }}>{t("review.useMine")}</button
                >
                <button onclick={() => onEditing(null)}>{t("review.cancel")}</button>
              </div>
            {:else}
              <span class="text" class:struck={slice.kind === "del" && verdict?.kind === "accept"}>
                {verdict?.finalText ?? slice.text}
              </span>
            {/if}
          </div>

          {#if slice.kind !== "same" && editing !== slice.id}
            <div class="actions">
              <button
                class:on={verdict?.kind === "accept"}
                onclick={() => judge(proposal, slice, "accept")}>{t("review.accept")}</button
              >
              <button
                class:on={verdict?.kind === "reject"}
                onclick={() => judge(proposal, slice, "reject")}>{t("review.reject")}</button
              >
              {#if slice.kind === "ins"}
                <button
                  onclick={() => {
                    onEditing(slice.id);
                    onDraft(verdict?.finalText ?? slice.text);
                  }}>{t("review.rewrite")}</button
                >
              {/if}
              {#if verdict}
                <button
                  class="reason-toggle"
                  class:has={verdict.reason !== undefined}
                  onclick={() => (reasonFor = reasonFor === slice.id ? null : slice.id)}
                  >{t("review.reason")}</button
                >
              {/if}
            </div>
          {/if}
        </div>

        {#if reasonFor === slice.id}
          <div class="reason-field">
            <!-- svelte-ignore a11y_autofocus -->
            <input
              autofocus
              placeholder={t("review.reasonPlaceholder")}
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
      <span class="label">{t("review.comment")} · {comment.target}</span>
      <p>{comment.text}</p>
    </aside>
  {/each}

  {#if refusal}
    <div class="refusal">
      <strong>{t("review.refused")}：{refusal.reason}</strong>
      {#each refusal.detail as line (line)}<span>{line}</span>{/each}
    </div>
  {/if}
</div>

{#if stagedCount > 0}
  <div class="commit-bar">
    <span>{stagedCount} {t("review.staged")}</span>
    <div>
      <button onclick={() => onStaged({})}>{t("review.clear")}</button>
      <button
        class="primary"
        onclick={() => onCommit(Object.values(staged))}>{t("review.commit")}</button
      >
    </div>
  </div>
{/if}

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
    padding-bottom: 4rem;
  }

  .empty {
    font-family: var(--serif);
    color: var(--ink-faint);
    line-height: 1.95;
    padding: 1rem 0;
  }

  .proposal {
    border: 1px solid var(--rule);
    border-radius: 3px;
    overflow: hidden;
    background: var(--paper-raised);
  }

  .proposal header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.55rem 0.75rem;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }

  /* Pushes the bulk buttons to the right edge; the scope keeps the middle. */
  .progress {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .bulk {
    display: flex;
    gap: 0.5rem;
  }

  /* Deliberately quiet. Staging every slice at once is a convenience, not the
     recommended path — the author should still read what they are agreeing to,
     and a prominent button would say otherwise. */
  .bulk button {
    font-size: var(--step--2);
    color: var(--ink-faint);
    text-decoration: underline;
    text-underline-offset: 0.24em;
    text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in oklab, var(--ink-faint) 40%, transparent);
  }

  .bulk button:hover {
    color: var(--ink);
  }

  .scope {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
    /* Holds the middle so the bulk buttons sit at the right edge. */
    margin-right: auto;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
    padding: 0 0.4rem;
  }

  .slice {
    flex: 1;
    min-width: 0;
    padding: 0.45rem 0.6rem;
    border-left: 2px solid transparent;
    font-family: var(--serif);
    line-height: 1.9;
  }

  .slice.same {
    color: var(--ink-ghost);
  }

  .slice.del {
    border-left-color: var(--refused);
    background: var(--refused-wash);
  }

  .slice.ins {
    border-left-color: var(--accepted);
    background: var(--accepted-wash);
  }

  .slice.judged {
    border-left-width: 3px;
  }

  .struck {
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--refused) 55%, transparent);
    opacity: 0.6;
  }

  .actions {
    display: flex;
    gap: 0.1rem;
    padding-top: 0.5rem;
    opacity: 0;
    transition: opacity 130ms var(--ease);
  }

  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
  }

  .actions button {
    font-size: var(--step--2);
    padding: 0.22rem 0.42rem;
    border-radius: 2px;
    color: var(--ink-faint);
    white-space: nowrap;
  }

  .actions button:hover {
    background: var(--paper-sunk);
    color: var(--ink);
  }

  .actions button.on {
    background: var(--ink);
    color: var(--paper-raised);
  }

  .reason-toggle.has {
    color: var(--seal);
  }

  .reason-field {
    padding: 0 0.75rem 0.55rem 1.05rem;
  }

  .reason-shown {
    padding: 0 0.75rem 0.5rem 1.05rem;
    color: var(--seal);
    font-family: var(--serif);
    font-size: var(--step--1);
    line-height: 1.75;
  }

  .edit-actions {
    display: flex;
    gap: 0.35rem;
    margin-top: 0.5rem;
  }

  .edit-actions button,
  .commit-bar button {
    font-size: var(--step--2);
    padding: 0.32rem 0.7rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    background: var(--paper-raised);
    color: var(--ink-soft);
  }

  .primary {
    background: var(--ink) !important;
    color: var(--paper-raised) !important;
    border-color: var(--ink) !important;
  }

  .comment {
    border-left: 2px solid var(--rule-strong);
    padding: 0.5rem 0.85rem;
    color: var(--ink-soft);
    font-family: var(--serif);
    line-height: 1.85;
  }

  .refusal {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0.9rem;
    background: var(--refused-wash);
    border: 1px solid var(--refused);
    border-radius: 3px;
    font-size: var(--step--2);
    color: var(--refused);
    line-height: 1.7;
  }

  .commit-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin: 0 -1.5rem -1.5rem;
    padding: 0.8rem 1.5rem;
    background: var(--paper-raised);
    border-top: 1px solid var(--rule-strong);
    font-size: var(--step--1);
    color: var(--ink-soft);
  }

  .commit-bar div {
    display: flex;
    gap: 0.35rem;
  }
</style>
