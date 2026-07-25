<script lang="ts">
import type { AgentView, ManifestEntryView, RunView } from "./api.ts";
import { api } from "./api.ts";

interface Props {
  root: string | null;
  chapter: string | null;
  selection: string;
  runs: RunView[];
  onDispatched: () => void;
  onCollect: (runId: string) => void;
}

const { root, chapter, selection, runs, onDispatched, onCollect }: Props = $props();

let agents = $state<AgentView[]>([]);
let manifest = $state<ManifestEntryView[]>([]);
let prompt = $state("");
let chosen = $state<string | null>(null);
let newName = $state("");
let newCommand = $state("");
let adding = $state(false);
let queued = $state(0);

$effect(() => {
  if (root)
    void api()
      .listAgents(root)
      .then((list) => (agents = list));
});

const addAgent = async (): Promise<void> => {
  if (!root || newName.trim().length === 0) return;
  const agent = await api().addAgent(root, newName.trim(), newCommand.trim());
  agents = [...agents, agent];
  chosen = agent.id;
  newName = "";
  newCommand = "";
  adding = false;
};

const enqueue = async (): Promise<void> => {
  if (!root || !chapter || !chosen || prompt.trim().length === 0) return;
  const target = selection.trim();
  if (target.length === 0) return;

  await api().enqueue(root, {
    id: `t${Date.now()}`,
    agentId: chosen,
    baseline: `${chapter}@current`,
    prompt: prompt.trim(),
    contextScope: [],
    editScopes: [{ id: `s${Date.now()}`, blockIds: [`${chapter}:sel`], text: target }],
  });
  manifest = await api().manifest(root);
  queued = manifest.reduce((sum, entry) => sum + entry.runCount, 0);
  prompt = "";
};

const send = async (): Promise<void> => {
  if (!root) return;
  await api().send(root);
  manifest = [];
  queued = 0;
  onDispatched();
};
</script>

<div class="dispatch">
  <section>
    <p class="label">选中的文字</p>
    {#if selection.trim().length > 0}
      <blockquote>{selection.trim()}</blockquote>
    {:else}
      <p class="hint">先在正文里选中一段，它将成为 Agent 唯一可以改写的范围。</p>
    {/if}
  </section>

  <section>
    <p class="label">交给谁</p>
    <div class="agents">
      {#each agents as agent (agent.id)}
        <button class="agent" class:on={chosen === agent.id} onclick={() => (chosen = agent.id)}>
          <span>{agent.name}</span>
          <span class="binding">{agent.binding.harness}</span>
        </button>
      {/each}
      <button class="agent add" onclick={() => (adding = !adding)}>＋ 新增</button>
    </div>

    {#if adding}
      <div class="new-agent">
        <input bind:value={newName} placeholder="名字，例如 kimi" />
        <input
          bind:value={newCommand}
          placeholder="启动命令，留空则用文件通道（把 request.md 手动交给任意 Agent）"
        />
        <p class="hint">
          命令里用 &#123;request&#125; 和 &#123;result&#125; 表示两个文件路径。留空最稳妥：
          程序把请求写成 Markdown，你交给任何 Agent，再把回复贴回 result.md。
        </p>
        <button class="primary" onclick={addAgent}>建立</button>
      </div>
    {/if}
  </section>

  <section>
    <p class="label">要求</p>
    <textarea bind:value={prompt} rows="4" placeholder="例如：把这段改得更冷，不要解释情绪。"></textarea>
    <button class="queue" onclick={enqueue}>加入待发队列</button>
  </section>

  {#if manifest.length > 0}
    <section class="manifest">
      <p class="label">待发清单 · {queued} 次运行</p>
      {#each manifest as entry (entry.agentName)}
        <div class="entry">
          <div class="entry-head">
            <strong>{entry.agentName}</strong>
            <span>{entry.runCount} 次</span>
          </div>
          <dl>
            <dt>Harness</dt><dd>{entry.harness}</dd>
            <dt>模型</dt><dd>{entry.model}</dd>
            <dt>思考强度</dt><dd>{entry.reasoningEffort}</dd>
            <dt>范围</dt><dd>{entry.scopes.join("、")}</dd>
          </dl>
          {#if entry.drifted.length > 0}
            <p class="drift">正文已变动：{entry.drifted.join("、")}——由你决定是否重读。</p>
          {/if}
        </div>
      {/each}
      <p class="no-price">此处不显示价格，本程序不做任何计费换算。</p>
      <button class="primary send" onclick={send}>一次送出全部</button>
    </section>
  {/if}

  {#if runs.length > 0}
    <section>
      <p class="label">运行</p>
      {#each runs as run (run.id)}
        <div class="run">
          <span class="run-id">{run.id}</span>
          <span class="run-state {run.state}">{run.state}</span>
          <button onclick={() => onCollect(run.id)}>读取结果</button>
        </div>
      {/each}
      <p class="hint">Agent 把回复写进 result.md 后，点「读取结果」把它冻结成提案。</p>
    </section>
  {/if}
</div>

<style>
  .dispatch {
    padding: 1.25rem 1.5rem 3rem;
    overflow-y: auto;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  blockquote {
    font-family: var(--serif);
    font-size: 14px;
    line-height: 1.9;
    padding: 0.6rem 0.8rem;
    background: var(--paper-raised);
    border-left: 2px solid var(--seal);
    border-radius: 0 3px 3px 0;
    max-height: 8rem;
    overflow-y: auto;
  }

  .hint {
    font-size: 11px;
    color: var(--ink-faint);
    line-height: 1.7;
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
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
    background: var(--paper-raised);
    font-size: 12px;
  }

  .agent.on {
    border-color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--ink);
  }

  .binding {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-faint);
  }

  .agent.add {
    color: var(--ink-faint);
    border-style: dashed;
    justify-content: center;
  }

  .new-agent {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem;
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    border-radius: 3px;
  }

  button.primary {
    background: var(--ink);
    color: var(--paper-raised);
    padding: 0.45rem 0.8rem;
    border-radius: 3px;
    font-size: 12px;
    align-self: flex-start;
  }

  .queue {
    align-self: flex-start;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
    background: var(--paper-raised);
    font-size: 12px;
  }

  .manifest {
    padding: 0.85rem;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    border-radius: 4px;
    box-shadow: var(--shadow-raised);
  }

  .entry-head {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    margin-bottom: 0.3rem;
  }

  dl {
    display: grid;
    grid-template-columns: 5.5em 1fr;
    gap: 0.15rem 0.5rem;
    font-size: 11px;
    color: var(--ink-soft);
  }

  dt {
    color: var(--ink-faint);
  }

  dd {
    font-family: var(--mono);
    word-break: break-all;
  }

  .drift {
    margin-top: 0.4rem;
    font-size: 11px;
    color: var(--seal);
  }

  .no-price {
    margin-top: 0.6rem;
    font-size: 10px;
    color: var(--ink-faint);
    letter-spacing: 0.02em;
  }

  .send {
    margin-top: 0.6rem;
    width: 100%;
    text-align: center;
  }

  .run {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 12px;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .run-id {
    font-family: var(--mono);
    font-size: 11px;
  }

  .run-state {
    font-size: 10px;
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    background: var(--paper);
    color: var(--ink-faint);
  }

  .run-state.completed {
    color: var(--accepted);
    background: var(--accepted-soft);
  }

  .run-state.failed {
    color: var(--refused);
    background: var(--refused-soft);
  }

  .run button {
    margin-left: auto;
    font-size: 11px;
    color: var(--seal);
  }
</style>
