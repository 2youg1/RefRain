// Agent 连接界面：RefRain 只调用作者已在本机安装并登录的 Agent 工具，
// 不保存账号或密钥。三步走——找到本机工具、连接、添加写作伙伴。
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in JSX.
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { describe } from "../bridge";
import type { HarnessDto } from "../generated/bindings.gen";
import {
  browserConnectionsGateway,
  ConnectionsSession,
  harnessStatusLabel,
} from "../shell/connections-session";

export type ConnectionsSurfaceProps = {
  rootId?: string;
  onClosed: () => void;
};

export function ConnectionsSurface(props: ConnectionsSurfaceProps): JSX.Element {
  // Catalogue state, the exclusion lock, and every bridge call belong to the
  // session. What stays here is what only a screen can own: the text currently
  // typed into the new-partner form.
  const session = new ConnectionsSession(browserConnectionsGateway, props.rootId ?? "", describe);
  const [tick, bump] = createSignal(0, { equals: false });
  onCleanup(session.onChanged(() => bump(0)));
  const view = createMemo(() => {
    tick();
    return session.view();
  });

  const [agentName, setAgentName] = createSignal("");
  const [agentChannel, setAgentChannel] = createSignal("");
  const [agentPersona, setAgentPersona] = createSignal("");

  const harnesses = () => view().harnesses;
  const agents = () => view().agents;
  const checkedVersions = () => view().checkedVersions;
  const busy = () => view().activity.kind === "working";
  const notice = () => {
    const activity = view().activity;
    return activity.kind === "reported" || activity.kind === "failed" ? activity.text : null;
  };
  const connectedHarnesses = createMemo(() =>
    harnesses().filter(
      (harness): harness is HarnessDto & { connectionId: string } =>
        harness.status === "connected" && harness.connectionId !== null,
    ),
  );
  const readingOf = (agentId: string) => session.readingOf(agentId);
  const statusLabel = (harness: HarnessDto): string => harnessStatusLabel(harness.status);

  const refresh = (): void => void session.load();
  const connect = (candidateId: string): void => void session.connect(candidateId);
  const check = (connectionId: string): void => void session.probe(connectionId);
  const removeConnection = (connectionId: string): void => void session.disconnect(connectionId);
  const removeAgent = (id: string): void => void session.removeAgent(id);
  const createAgent = (): void => {
    void session.createAgent(agentName(), agentChannel(), agentPersona()).then(() => {
      if (view().activity.kind === "reported") {
        setAgentName("");
        setAgentPersona("");
      }
    });
  };

  onMount(() => {
    refresh();
  });

  return (
    <section class="connections" aria-label="Agent 连接">
      <header class="connections-head">
        <div>
          <h2 class="conn-title">Agent 连接</h2>
          <p class="conn-hint">
            RefRain 只调用你已在电脑上安装并登录的 Agent 工具，不保存账号或密钥。
          </p>
        </div>
        <button type="button" class="scan" disabled={busy()} onClick={() => void refresh()}>
          重新扫描
        </button>
      </header>

      <Show when={notice()}>
        {(message) => (
          <p class="notice" role="status">
            {message()}
          </p>
        )}
      </Show>

      <ol class="steps" aria-label="连接步骤">
        <li class="step">
          <b>1</b> 找到本机工具
        </li>
        <li class="step">
          <b>2</b> 连接
        </li>
        <li class="step">
          <b>3</b> 添加写作伙伴
        </li>
      </ol>

      <div class="tool-list">
        <For each={harnesses()}>
          {(harness) => (
            <article class="tool-card">
              <div class="tool-copy">
                <strong>{harness.label}</strong>
                <span class="tool-state" data-status={harness.status}>
                  {statusLabel(harness)}
                </span>
                <small>
                  {checkedVersions()[harness.connectionId ?? ""] ?? harness.version ?? harness.tier}
                </small>
              </div>
              <div class="tool-actions">
                <Show when={harness.status === "available" || harness.status === "needs-attention"}>
                  <button
                    type="button"
                    class="primary"
                    disabled={busy()}
                    onClick={() => void connect(harness.candidateId)}
                  >
                    {harness.status === "needs-attention" ? "重新连接" : "连接"}
                  </button>
                </Show>
                <Show when={harness.status === "connected" && harness.connectionId}>
                  {(connectionId) => (
                    <button
                      type="button"
                      disabled={busy()}
                      onClick={() => void check(connectionId())}
                    >
                      检查
                    </button>
                  )}
                </Show>
                <Show when={harness.connectionId}>
                  {(connectionId) => (
                    <button
                      type="button"
                      class="quiet"
                      disabled={busy()}
                      onClick={() => void removeConnection(connectionId())}
                    >
                      断开
                    </button>
                  )}
                </Show>
              </div>
            </article>
          )}
        </For>
      </div>

      <section class="partners" aria-labelledby="partners-title">
        <div class="partners-head">
          <div>
            <h3 id="partners-title">写作伙伴</h3>
            <p>名称与工作方式属于这个伙伴；模型账号仍由本机 Agent 工具管理。</p>
          </div>
        </div>

        <For each={agents()}>
          {(agent) => (
            <article class="partner-card">
              <div class="partner-copy">
                <strong>{agent.name}</strong>
                <span>
                  {agent.channel} · {agent.version}
                </span>
                <Show when={readingOf(agent.id)}>
                  {(reading) => (
                    <small>
                      已参与 {reading().rounds} 轮 ·{" "}
                      {reading().stale ? "手稿后来改过" : "读到当前版本"}
                    </small>
                  )}
                </Show>
              </div>
              <Show when={agent.hasPersona}>
                <span class="has-brief">有工作说明</span>
              </Show>
              <button
                type="button"
                class="quiet"
                disabled={busy()}
                onClick={() => void removeAgent(agent.id)}
              >
                移除
              </button>
            </article>
          )}
        </For>

        <form
          class="partner-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createAgent();
          }}
        >
          <label>
            <span>伙伴名称</span>
            <input
              class="conn-input"
              placeholder="例如：史料校对"
              maxlength="40"
              value={agentName()}
              onInput={(event) => setAgentName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>怎样往返</span>
            <select
              class="conn-input"
              value={agentChannel()}
              onChange={(event) => setAgentChannel(event.currentTarget.value)}
            >
              <option value="">手动往返（也可用于网页聊天）</option>
              <For each={connectedHarnesses()}>
                {(harness) => (
                  <option value={harness.connectionId}>由 {harness.label} 直接运行</option>
                )}
              </For>
            </select>
          </label>
          <label>
            <span>
              工作说明 <i>可留空</i>
            </span>
            <textarea
              class="partner-brief"
              rows="3"
              placeholder="例如：只校对史实，不改段落结构。"
              value={agentPersona()}
              onInput={(event) => setAgentPersona(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            class="primary add-partner"
            disabled={busy() || agentName().trim().length === 0}
          >
            添加写作伙伴
          </button>
        </form>
      </section>

      <button type="button" class="conn-close" onClick={() => props.onClosed()}>
        返回手稿
      </button>
    </section>
  );
}
