<script lang="ts">
import type { AgentView } from "./api.ts";
import { api } from "./api.ts";
import type { Key } from "./i18n.ts";

interface Props {
  root: string | null;
  t: (key: Key) => string;
}

const { root, t }: Props = $props();

let agents = $state<AgentView[]>([]);
let name = $state("");
let command = $state("");

$effect(() => {
  if (root)
    void api()
      .listAgents(root)
      .then((list) => (agents = list));
});

const add = async (): Promise<void> => {
  if (!root || name.trim().length === 0) return;
  const agent = await api().addAgent(root, name.trim(), command.trim());
  agents = [...agents, agent];
  name = "";
  command = "";
};
</script>

<div class="agents">
  {#if agents.length === 0}
    <p class="empty">{t("agents.none")}</p>
  {:else}
    <ul>
      {#each agents as agent (agent.id)}
        <li>
          <span class="name">{agent.name}</span>
          <span class="binding">
            {agent.binding.harness.startsWith("command:")
              ? agent.binding.harness.slice(8)
              : t("agents.fileChannel")}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="new">
    <div class="field">
      <span class="label">{t("agents.name")}</span>
      <input bind:value={name} placeholder="kimi" spellcheck="false" />
    </div>

    <div class="field">
      <span class="label">{t("agents.command")}</span>
      <input bind:value={command} placeholder={t("agents.placeholderCmd")} spellcheck="false" />
      <p class="hint">{t("agents.commandHint")}</p>
    </div>

    <button class="primary" onclick={add} disabled={name.trim().length === 0}>
      {t("agents.add")}
    </button>
  </div>
</div>

<style>
  .agents {
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
  }

  .empty {
    font-family: var(--serif);
    color: var(--ink-faint);
    line-height: 1.9;
    padding: 0.5rem 0;
  }

  ul {
    list-style: none;
    border-top: 1px solid var(--rule);
  }

  li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--rule);
  }

  .name {
    font-family: var(--serif);
  }

  .binding {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .new {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .hint {
    font-size: var(--step--2);
    color: var(--ink-faint);
    line-height: 1.75;
  }

  .primary {
    align-self: flex-start;
    padding: 0.5rem 1.1rem;
    background: var(--ink);
    color: var(--paper-raised);
    border-radius: 2px;
    font-size: var(--step--1);
  }

  .primary:disabled {
    background: var(--rule-strong);
    cursor: not-allowed;
  }
</style>
