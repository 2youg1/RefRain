<script lang="ts">
import type { ReviewTaskIntent } from "../shared/review-task.ts";
import type { AgentView, ManifestEntryView, RunView } from "./api.ts";
import { api } from "./api.ts";
import type { Key } from "./i18n.ts";

interface Props {
  root: string | null;
  chapter: string | null;
  selection: string;
  /** The whole blocks the selection touches, with their real core ids. */
  scope: { ids: string[]; text: string };
  runs: RunView[];
  t: (key: Key) => string;
  enqueueing: boolean;
  onDispatched: () => void;
  onEnqueue: (
    intent: ReviewTaskIntent,
  ) => Promise<{
    readonly accepted: boolean;
    readonly manifest: ManifestEntryView[] | null;
  }>;
  onCancel: (runId: string) => void;
  onCollect: (runId: string) => void;
  /**
   * The instruction the author is writing for this dispatch.
   *
   * Held by the shell, not here. Writing one means going back to the
   * manuscript — to quote a phrase, to check where the Edit Scope ends — and
   * the only way back is Escape, which unmounts this sheet. Eighty words of
   * the author's own instruction went with it.
   */
  prompt: string;
  onPrompt: (next: string) => void;
}

const {
  root,
  chapter,
  selection,
  scope,
  runs,
  t,
  enqueueing,
  onDispatched,
  onEnqueue,
  onCancel,
  onCollect,
  prompt,
  onPrompt,
}: Props = $props();

let agents = $state<AgentView[]>([]);
let manifest = $state<ManifestEntryView[]>([]);
let chosen = $state<string | null>(null);
let submitting = $state(false);

const queued = $derived(manifest.reduce((sum, entry) => sum + entry.runCount, 0));
const ready = $derived(
  !enqueueing &&
    !submitting &&
    root !== null &&
    chapter !== null &&
    chosen !== null &&
    prompt.trim().length > 0,
);

$effect(() => {
  const owner = root;
  if (!owner) {
    agents = [];
    manifest = [];
    chosen = null;
    return;
  }
  let current = true;
  void api()
    .listAgents(owner)
    .then((list) => {
      if (!current) return;
      agents = list;
      if (!list.some((agent) => agent.id === chosen)) chosen = list[0]?.id ?? null;
    });
  void api()
    .manifest(owner)
    .then((entries) => {
      if (current) manifest = entries;
    });
  return () => {
    current = false;
  };
});

const enqueue = async (): Promise<void> => {
  const owner = root;
  const target = chapter;
  const agent = chosen;
  const draft = prompt;
  const instruction = draft.trim();
  if (!owner || !target || !agent || instruction.length === 0 || enqueueing || submitting)
    return;

  submitting = true;
  try {
    // The renderer identifies the author's intended chapter and writable blocks.
    // Main owns the Revision, verifies every scope against it, and supplies the
    // chapter's readable Context Scope.
    const result = await onEnqueue({
      id: crypto.randomUUID(),
      agentId: agent,
      chapter: target,
      prompt: instruction,
      editScopes:
        scope.ids.length === 0
          ? []
          : [{ id: crypto.randomUUID(), blockIds: scope.ids, text: scope.text }],
    });
    if (!result.accepted) return;

    if (result.manifest !== null && root === owner) manifest = result.manifest;
    // Clear only the exact raw draft that was accepted. Text written while
    // this operation waited belongs to the next task and must stay.
    if (prompt === draft) onPrompt("");
  } finally {
    submitting = false;
  }
};

const send = async (): Promise<void> => {
  if (!root) return;
  await api().send(root);
  manifest = [];
  onDispatched();
};
</script>

<div class="dispatch">
  <section>
    <span class="label">{t("dispatch.selection")}</span>
    {#if selection.trim().length > 0}
      <blockquote>{selection.trim()}</blockquote>
    {:else}
      <p class="hint">{t("dispatch.noSelection")}</p>
    {/if}
  </section>

  <section>
    <span class="label">{t("dispatch.who")}</span>
    {#if agents.length === 0}
      <p class="hint">{t("agents.none")}</p>
    {:else}
      <div class="agents">
        {#each agents as agent (agent.id)}
          <button class="agent" class:on={chosen === agent.id} onclick={() => (chosen = agent.id)}>
            <span>{agent.name}</span>
            <span class="binding">
              {agent.binding.harness.startsWith("command:")
                ? agent.binding.harness.slice(8)
                : t("agents.fileChannel")}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <section>
    <span class="label">{t("dispatch.prompt")}</span>
    <textarea
      value={prompt}
      oninput={(event) => onPrompt(event.currentTarget.value)}
      rows="4"
      placeholder={t("dispatch.promptPlaceholder")}
    ></textarea>
    <button class="queue" onclick={enqueue} disabled={!ready}>{t("dispatch.queue")}</button>
  </section>

  {#if manifest.length > 0}
    <section class="manifest">
      <span class="label">{t("dispatch.manifest")} · {queued} {t("dispatch.runs")}</span>

      {#each manifest as entry (entry.agentName)}
        <div class="entry">
          <div class="entry-head">
            <strong>{entry.agentName}</strong>
            <span>{entry.runCount}</span>
          </div>
          <dl>
            <dt>{t("dispatch.harness")}</dt><dd>{entry.harness}</dd>
            <dt>{t("dispatch.model")}</dt><dd>{entry.model}</dd>
            <dt>{t("dispatch.effort")}</dt><dd>{entry.reasoningEffort}</dd>
            <dt>{t("dispatch.context")}</dt><dd>{entry.contexts.join(" · ")}</dd>
            <dt>{t("dispatch.scope")}</dt><dd
              >{entry.scopes.length === 0
                ? t("dispatch.noEditScope")
                : entry.scopes
                    .map((scope) => scope.blockIds.join(t("list.join")))
                    .join(" · ")}</dd
            >
          </dl>
          {#if entry.drifted.length > 0}
            <p class="drift"
              >{entry.drifted
                .flatMap(
                  (id) => entry.scopes.find((scope) => scope.id === id)?.blockIds ?? [id],
                )
                .join(t("list.join"))} — {t("dispatch.drifted")}</p
            >
          {/if}
        </div>
      {/each}

      <p class="no-price">{t("dispatch.noPrice")}</p>
      <button class="send" onclick={send}>{t("dispatch.send")}</button>
    </section>
  {/if}

  {#if runs.length > 0}
    <section>
      <span class="label">runs</span>
      {#each runs as run (run.id)}
        <div class="run">
          <span class="run-id">{run.id}</span>
          <span class="run-state {run.state}">{run.state}</span>
          {#if run.state === "dispatched"}
            <button onclick={() => onCancel(run.id)}>{t("dispatch.cancel")}</button>
          {/if}
          <!-- Only completed or manually recovered Runs have material to collect. -->
          {#if run.state === "completed" || (run.state === "dispatched" && run.failure)}
            <button onclick={() => onCollect(run.id)}>{t("dispatch.collect")}</button>
          {/if}
        </div>
        <!--
          The harness's own words. A misconfigured command or a malformed reply
          is diagnosed by what it said; "failed" on its own tells an author
          nothing they can act on, and the reason had no channel out of the Host
          until now.
        -->
        {#if run.failure}
          <p class="run-failure">{run.failure}</p>
        {/if}
      {/each}
    </section>
  {/if}
</div>

<style>
  .dispatch {
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  blockquote {
    font-family: var(--serif);
    font-size: var(--step-0);
    line-height: 1.95;
    padding: 0.75rem 0.9rem;
    background: var(--paper);
    border-left: 2px solid var(--seal);
    max-height: 9rem;
    overflow-y: auto;
    color: var(--ink-soft);
  }

  .hint {
    font-size: var(--step--1);
    color: var(--ink-faint);
    line-height: 1.85;
  }

  .agents {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .agent {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.1rem;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    background: var(--paper-raised);
    font-size: var(--step--1);
  }

  .agent.on {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--ink);
  }

  .binding {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }

  .queue,
  .send {
    align-self: flex-start;
    padding: 0.5rem 1.1rem;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    background: var(--paper-raised);
    font-size: var(--step--1);
    color: var(--ink-soft);
  }

  .queue:hover:not(:disabled) {
    border-color: var(--seal);
    color: var(--seal);
  }

  .queue:disabled {
    color: var(--ink-ghost);
    cursor: not-allowed;
  }

  .manifest {
    padding: 0.95rem;
    background: var(--paper);
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
  }

  .entry-head {
    display: flex;
    justify-content: space-between;
    font-family: var(--serif);
    margin-bottom: 0.35rem;
  }

  dl {
    display: grid;
    grid-template-columns: 4.5em 1fr;
    gap: 0.15rem 0.6rem;
    font-size: var(--step--2);
  }

  dt {
    color: var(--ink-ghost);
    font-family: var(--mono);
  }

  dd {
    font-family: var(--mono);
    color: var(--ink-soft);
    word-break: break-all;
  }

  .drift {
    margin-top: 0.45rem;
    font-size: var(--step--2);
    color: var(--seal);
    line-height: 1.7;
  }

  .no-price {
    margin: 0.75rem 0 0.6rem;
    font-size: var(--step--2);
    color: var(--ink-ghost);
    line-height: 1.7;
  }

  .send {
    width: 100%;
    text-align: center;
    background: var(--ink);
    color: var(--paper-raised);
    border-color: var(--ink);
  }

  .run {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--rule);
    font-size: var(--step--1);
  }

  .run-id {
    font-family: var(--mono);
    font-size: var(--step--2);
  }

  .run-failure {
    font-family: var(--mono);
    font-size: var(--step--2);
    line-height: 1.7;
    color: var(--refused);
    background: var(--refused-wash);
    border-left: 2px solid var(--refused);
    padding: 0.4rem 0.6rem;
    margin: 0.2rem 0 0.5rem;
    /* A path or a stack trace has no spaces to break at. */
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .run-state {
    font-size: var(--step--2);
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    background: var(--paper-sunk);
    color: var(--ink-faint);
  }

  .run-state.completed {
    color: var(--accepted);
    background: var(--accepted-wash);
  }

  .run-state.failed {
    color: var(--refused);
    background: var(--refused-wash);
  }

  .run button {
    margin-left: auto;
    font-size: var(--step--2);
    color: var(--seal);
  }
</style>
