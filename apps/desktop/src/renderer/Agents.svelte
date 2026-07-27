<script lang="ts">
  
  import type { AgentView } from "./api.ts";
import { api } from "./api.ts";
  import type { Key } from "./i18n.ts";

  /**
   * The half-filled "add an agent" form, held by the shell.
   *
   * Lower stakes than a dispatch instruction — this is configuration, and an
   * argv can usually be pasted again — but it is still typing the author did,
   * and Escape used to take it. One shape, one remedy.
   */
  interface Draft {
    adding: boolean;
    name: string;
    command: string;
  }

  interface Props {
    root: string | null;
    t: (key: Key) => string;
    draft: Draft;
    onDraft: (next: Draft) => void;
  }

  const { root, t, draft, onDraft }: Props = $props();
  const adding = $derived(draft.adding);
  const name = $derived(draft.name);
  const command = $derived(draft.command);

  type Status = "ready" | "checking" | "unreachable" | "file" | "untrusted";

  interface AgentRow extends AgentView {
    status: Status;
    detail?: string;
  }

  let agents = $state<AgentRow[]>([]);
  let checking = $state<string | null>(null);

  /*
   * Opening this screen used to run every configured binary.
   *
   * Each agent was probed on arrival, and a probe executes the command's first
   * token. `agents.json` lives in the project folder, so it comes with whatever
   * the project came with — and reading someone else's writing project ran
   * their choice of program before its name had appeared on screen.
   *
   * A command restored from a project file is listed but not run. The author
   * sees the argv and decides; only then does it get probed.
   */
  $effect(() => {
    if (!root) return;
    void api()
      .listAgents(root)
      .then((list) => {
        agents = list.map((agent) => ({
          ...agent,
          status:
            agent.binding.harness === "file"
              ? "file"
              : agent.trusted === false
                ? "untrusted"
                : "checking",
        }));
        for (const agent of agents) if (agent.status === "checking") void probe(agent.id);
      });
  });

  /** The author read the command and accepts it; only now may it be probed. */
  const trust = async (id: string): Promise<void> => {
    if (!root) return;
    if (!(await api().trustAgent(root, id))) return;
    agents = agents.map((agent) =>
      agent.id === id ? { ...agent, trusted: true, status: "checking" } : agent,
    );
    await probe(id);
  };

  /**
   * Ask the harness whether it is actually there.
   *
   * A configuration screen that only stores a command tells the author nothing:
   * they find out it was wrong when a run silently fails an hour later. The
   * check runs the command's own version flag and reports what came back.
   */
  const probe = async (id: string): Promise<void> => {
    if (!root) return;
    checking = id;
    const result = await api().probeAgent(root, id);
    agents = agents.map((agent) =>
      agent.id === id
        ? {
            ...agent,
            // Main refuses to run an unvouched command even when asked, so the
            // row returns to waiting for consent rather than reading as broken.
            status: result.ok ? "ready" : result.reason === "untrusted" ? "untrusted" : "unreachable",
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          }
        : agent,
    );
    checking = null;
  };

  const add = async (): Promise<void> => {
    if (!root || name.trim().length === 0) return;
    const agent = await api().addAgent(root, name.trim(), command.trim());
    agents = [
      ...agents,
      { ...agent, status: command.trim().length === 0 ? "file" : "checking" },
    ];
    if (command.trim().length > 0) void probe(agent.id);
    onDraft({ adding: false, name: "", command: "" });
  };

  const remove = async (id: string): Promise<void> => {
    if (!root) return;
    await api().removeAgent(root, id);
    agents = agents.filter((agent) => agent.id !== id);
  };

  const statusKey = (status: Status): Key => `agents.${status}` as Key;

  /**
   * Ready-made entries for the harnesses whose interfaces are documented.
   *
   * No shell metacharacters. Commands are launched with `shell: false`, because
   * a prompt is author text and must never become a command — so a `>` here is
   * a literal argument, not a redirection, and the claude preset shipped as an
   * example that could not work and taught the wrong template shape.
   */
  const presets: { name: string; command: string }[] = [
    { name: "codex", command: "codex exec --file {request} --output {result}" },
    { name: "claude", command: "claude -p --output-format text --output-file {result} {prompt}" },
    { name: "kimi", command: "kimi run --input {request} --output {result}" },
    { name: "pi", command: "pi run --file {request} --out {result}" },
  ];
</script>

<div class="agents">
  {#if agents.length === 0 && !adding}
    <div class="empty">
      <p>{t("agents.none")}</p>
      <p class="quiet">{t("agents.fileExplains")}</p>
    </div>
  {/if}

  {#each agents as agent (agent.id)}
    <article class="agent">
      <div class="head">
        <span class="dot {agent.status}" class:pulsing={checking === agent.id}></span>
        <span class="name">{agent.name}</span>
        <span class="status">{t(statusKey(agent.status))}</span>
        <button class="remove" onclick={() => remove(agent.id)} aria-label={t("agents.remove")}>
          ✕
        </button>
      </div>

      <p class="binding">
        {agent.binding.harness === "file"
          ? t("agents.fileChannel")
          : agent.binding.harness.replace(/^command:/, "")}
      </p>

      {#if agent.status === "untrusted"}
        <div class="consent">
          <p class="explains">{t("agents.untrustedExplains")}</p>
          {#if agent.command}
            <code class="argv">{agent.command}</code>
          {/if}
          <button class="trust" onclick={() => trust(agent.id)}>{t("agents.trust")}</button>
        </div>
      {:else if agent.detail}
        <p class="detail">{agent.detail}</p>
      {/if}

      {#if agent.status !== "file" && agent.status !== "untrusted"}
        <button class="recheck" onclick={() => probe(agent.id)}>{t("agents.recheck")}</button>
      {/if}
    </article>
  {/each}

  {#if adding}
    <div class="new">
      <div class="field">
        <span class="label">{t("agents.name")}</span>
        <input
          value={name}
          oninput={(event) => onDraft({ ...draft, name: event.currentTarget.value })}
          placeholder="kimi"
          spellcheck="false"
        />
      </div>

      <div class="field">
        <span class="label">{t("agents.command")}</span>
        <input
          value={command}
          oninput={(event) => onDraft({ ...draft, command: event.currentTarget.value })}
          placeholder={t("agents.placeholderCmd")}
          spellcheck="false"
        />
        <p class="hint">{t("agents.commandHint")}</p>
      </div>

      <div class="presets">
        <span class="label">{t("agents.presets")}</span>
        <div class="chips">
          {#each presets as preset (preset.name)}
            <button
              onclick={() => onDraft({ ...draft, name: preset.name, command: preset.command })}
              >{preset.name}</button
            >
          {/each}
          <button
            onclick={() => onDraft({ ...draft, command: "" })}>{t("agents.fileChannel")}</button
          >
        </div>
      </div>

      <div class="actions">
        <button class="primary" onclick={add} disabled={name.trim().length === 0}>
          {t("agents.add")}
        </button>
        <button onclick={() => onDraft({ ...draft, adding: false })}>{t("review.cancel")}</button>
      </div>
    </div>
  {:else}
    <button class="open-new" onclick={() => onDraft({ ...draft, adding: true })}
      >＋ {t("agents.connect")}</button
    >
  {/if}
</div>

<style>
  .agents {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .empty {
    padding: 0.5rem 0 0.2rem;
  }

  .empty p {
    font-family: var(--serif);
    color: var(--ink-soft);
    line-height: 1.95;
  }

  .quiet {
    margin-top: 0.6rem;
    font-family: var(--sans) !important;
    font-size: var(--step--1);
    color: var(--ink-faint) !important;
  }

  .agent {
    padding: 0.7rem 0.8rem;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 3px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* Connection state, stated as a colour before it is stated in words. */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }

  .dot.ready {
    background: var(--accepted);
  }

  .dot.file {
    background: var(--ink-ghost);
  }

  .dot.unreachable {
    background: var(--refused);
  }

  .dot.checking {
    background: var(--seal);
  }

  /* Awaiting consent is not an error and not a success: it is a question. */
  .dot.untrusted {
    background: var(--agent);
  }

  .consent {
    display: grid;
    gap: 0.6rem;
    margin-top: 0.7rem;
    padding: 0.8rem 0.9rem;
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
    background: var(--paper-sunk);
  }

  .consent .explains {
    margin: 0;
    font-size: var(--step--1);
    line-height: 1.7;
    color: var(--ink-soft);
  }

  /* The argv wraps rather than truncates: a command the author cannot read
     whole is a command they cannot agree to. */
  .consent .argv {
    font-family: var(--mono);
    font-size: var(--step--1);
    line-height: 1.6;
    padding: 0.5rem 0.6rem;
    border-radius: 2px;
    background: var(--paper);
    color: var(--ink);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .consent .trust {
    justify-self: start;
    font-size: var(--step--1);
    padding: 0.35rem 0.9rem;
    border: 1px solid var(--seal);
    border-radius: 2px;
    background: transparent;
    color: var(--seal);
    cursor: pointer;
  }

  .consent .trust:hover {
    background: var(--seal-wash);
  }

  .dot.pulsing {
    animation: pulse 1.1s ease-in-out infinite;
  }

  .name {
    font-family: var(--serif);
    font-size: var(--step-0);
  }

  .status {
    font-size: var(--step--2);
    color: var(--ink-faint);
  }

  .remove {
    margin-left: auto;
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }

  .remove:hover {
    color: var(--refused);
  }

  .binding,
  .detail {
    font-family: var(--mono);
    font-size: var(--step--2);
    color: var(--ink-faint);
    margin-top: 0.35rem;
    word-break: break-all;
    line-height: 1.65;
  }

  .detail {
    color: var(--refused);
  }

  .recheck {
    margin-top: 0.4rem;
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }

  .recheck:hover {
    color: var(--seal);
  }

  .new {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 0.9rem;
    background: var(--paper);
    border: 1px solid var(--rule-strong);
    border-radius: 3px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .hint {
    font-size: var(--step--2);
    color: var(--ink-faint);
    line-height: 1.7;
  }

  .presets {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .chips button {
    padding: 0.25rem 0.55rem;
    font-size: var(--step--2);
    font-family: var(--mono);
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
  }

  .chips button:hover {
    border-color: var(--seal);
    color: var(--seal);
  }

  .actions {
    display: flex;
    gap: 0.4rem;
  }

  .actions button {
    padding: 0.45rem 0.9rem;
    font-size: var(--step--1);
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
  }

  .primary {
    background: var(--ink);
    color: var(--paper-raised);
    border-color: var(--ink) !important;
  }

  .primary:disabled {
    background: var(--rule-strong);
    cursor: not-allowed;
  }

  .open-new {
    align-self: flex-start;
    font-size: var(--step--1);
    color: var(--ink-faint);
    padding: 0.4rem 0;
  }

  .open-new:hover {
    color: var(--seal);
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
</style>
