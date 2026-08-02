// Agent 连接界面：RefRain 只调用作者已在本机安装并登录的 Agent 工具，
// 不保存账号或密钥。三步走——找到本机工具、连接、添加写作伙伴。
// biome-ignore-all lint/correctness/noUnusedVariables: bindings used only in JSX.
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { describe } from "../bridge";
import type { AgentDto, AgentReadingDto, HarnessDto } from "../generated/bindings.gen";
import {
  browserConnectionsGateway,
  ConnectionsSession,
  type ConnectionsView,
  harnessStatusLabel,
  type SkillStatus,
  skillStatusLabel,
} from "../shell/connections-session";

export type ConnectionsSurfaceProps = {
  rootId?: string;
  onClosed: () => void;
};

/** 已连接的通道：编辑表单里「怎样往返」与协议徽章的可选范围。 */
function connectedHarnessesOf(
  harnesses: readonly HarnessDto[],
): (HarnessDto & { connectionId: string })[] {
  return harnesses.filter(
    (harness): harness is HarnessDto & { connectionId: string } =>
      harness.status === "connected" && harness.connectionId !== null,
  );
}

/** 活动状态里值得让作者读的那句：报告的与失败的，进行中的交给进度措辞。 */
function noticeOf(view: ConnectionsView): string | null {
  const activity = view.activity;
  return activity.kind === "reported" || activity.kind === "failed" ? activity.text : null;
}

/**
 * 全部动作一处：组件体不为一排按钮各付一行包装，而「一击 → 一次会话操作」
 * 的对应关系仍只有这里一份。
 */
function connectionsActions(session: ConnectionsSession) {
  return {
    refresh: (): void => void session.load(),
    connect: (candidateId: string): void => void session.connect(candidateId),
    check: (connectionId: string): void => void session.probe(connectionId),
    installSkill: (connectionId: string): void => void session.installSkill(connectionId),
    removeConnection: (connectionId: string): void => void session.disconnect(connectionId),
    removeAgent: (id: string): void => void session.removeAgent(id),
    updateAgent: (id: string, name: string, channel: string, persona: string, argv: string): void =>
      void session.updateAgent(id, name, channel, persona, argv),
  };
}

/**
 * 装/更新协议的那颗按钮。
 *
 * 只发给已连接的通道，且只在徽章说「未装/过期」时出现——已装的不给一颗装了
 * 又装的按钮。它写的是 harness 的 skill 目录，所以必须是一颗显式的点击，
 * 不能是进入页面时的自动动作。
 */
function InstallSkillAction(props: {
  skill: SkillStatus | null;
  connectionId: string | null;
  busy: boolean;
  onInstall: (connectionId: string) => void;
}): JSX.Element {
  return (
    <Show when={props.skill !== null && props.skill !== "current" && props.connectionId}>
      {(connectionId) => (
        <button type="button" disabled={props.busy} onClick={() => props.onInstall(connectionId())}>
          {props.skill === "stale" ? "更新协议" : "安装协议"}
        </button>
      )}
    </Show>
  );
}

/**
 * 一张伙伴卡：看的时候是事实，改的时候是表单。
 *
 * 编辑态归卡片自己：保存或取消后列表整体刷新（session 重读名录），卡片按
 * For 的键重挂，编辑态随之退场——没有一个「正在编辑谁」的外层状态需要记。
 * 修改走 updateAgent（同一个 id），不是删了重建：重建会丢掉这个 id 在
 * 裁决账本里的参与记录。
 */
function PartnerCard(props: {
  agent: AgentDto;
  reading: AgentReadingDto | null;
  /** 已连接的通道：编辑表单里「怎样往返」的可选项。 */
  harnesses: readonly { connectionId: string; label: string }[];
  /** 已存的启动参数：编辑表单的预填，原样示出。 */
  argv: readonly string[];
  busy: boolean;
  onSave: (id: string, name: string, channel: string, persona: string, argv: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [name, setName] = createSignal(props.agent.name);
  const [channel, setChannel] = createSignal(props.agent.connectionId ?? "");
  const [persona, setPersona] = createSignal(props.agent.persona ?? "");
  /** argv 的回显：带空白的参数得带着它的引号回来，否则读出来是另一组参数。 */
  const argvTextOf = (argv: readonly string[]): string =>
    argv.map((token) => (token.includes(" ") ? `"${token}"` : token)).join(" ");
  const [argv, setArgv] = createSignal(argvTextOf(props.argv));

  /** 进入编辑：草稿从卡的当前事实重新起，取消过的半截修改不留下次。 */
  const begin = (): void => {
    setName(props.agent.name);
    setChannel(props.agent.connectionId ?? "");
    setPersona(props.agent.persona ?? "");
    setArgv(argvTextOf(props.argv));
    setEditing(true);
  };

  return (
    <article class="partner-card">
      <Show
        when={editing()}
        fallback={
          <>
            <div class="partner-copy">
              <strong>{props.agent.name}</strong>
              <span>
                {props.agent.channel} · {props.agent.version}
              </span>
              <Show when={props.reading}>
                {(reading) => (
                  <small>
                    已参与 {reading().rounds} 轮 ·{" "}
                    {reading().stale ? "手稿后来改过" : "读到当前版本"}
                  </small>
                )}
              </Show>
            </div>
            <Show when={props.agent.hasPersona}>
              <span class="has-brief">有身份说明</span>
            </Show>
            <button type="button" disabled={props.busy} onClick={begin}>
              编辑
            </button>
            <button
              type="button"
              class="quiet"
              disabled={props.busy}
              onClick={() => props.onRemove(props.agent.id)}
            >
              移除
            </button>
          </>
        }
      >
        <form
          class="partner-edit"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSave(props.agent.id, name(), channel(), persona(), argv());
          }}
        >
          <label>
            <span>伙伴名称</span>
            <input
              class="conn-input"
              maxlength="40"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>怎样往返</span>
            <select
              class="conn-input"
              value={channel()}
              onChange={(event) => setChannel(event.currentTarget.value)}
            >
              <option value="">手动往返（也可用于网页聊天）</option>
              <For each={props.harnesses}>
                {(harness) => (
                  <option value={harness.connectionId}>由 {harness.label} 直接运行</option>
                )}
              </For>
            </select>
          </label>
          <label>
            <span>
              身份说明 <i>可留空</i>
            </span>
            {/*
              桥上是整体替换语义：表单已用现有说明预填，原样保存即保留；
              唯一会丢说明的动作是亲手清空——所以只对「清空」给一句照实的提示。
            */}
            <Show when={props.agent.hasPersona}>
              <small class="conn-hint">已预填现有说明；清空后保存将删除它。</small>
            </Show>
            <textarea
              class="partner-brief"
              rows="3"
              placeholder="例如：只校对史实，不改段落结构。"
              value={persona()}
              onInput={(event) => setPersona(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>
              启动参数 <i>可留空</i>
            </span>
            {/*
              自由文本，保存时解析成 argv 数组（空白分词、双引号成团）。
              模型、思考强度就是参数本身，不枚举——与连接那一层同一规矩。
            */}
            <small class="conn-hint">随每次启动追加在连接参数之后，不经 shell。</small>
            <input
              class="conn-input"
              placeholder="例如：-m <模型>"
              value={argv()}
              onInput={(event) => setArgv(event.currentTarget.value)}
            />
          </label>
          <div class="partner-edit-actions">
            <button
              type="submit"
              class="primary"
              disabled={props.busy || name().trim().length === 0}
            >
              保存
            </button>
            <button
              type="button"
              class="quiet"
              disabled={props.busy}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </form>
      </Show>
    </article>
  );
}

export function ConnectionsSurface(props: ConnectionsSurfaceProps): JSX.Element {
  // Catalogue state, the exclusion lock, and every bridge call belong to the session.
  // What stays here is what only a screen can own: the text typed into the new-partner form.
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
  const notice = () => noticeOf(view());
  const connectedHarnesses = createMemo(() => connectedHarnessesOf(harnesses()));
  const readingOf = (agentId: string) => session.readingOf(agentId);
  const statusLabel = (harness: HarnessDto): string => harnessStatusLabel(harness.status);
  const skillOf = (harness: HarnessDto) => session.skillStatusOf(harness);
  const { refresh, connect, check, installSkill, removeConnection, removeAgent, updateAgent } =
    connectionsActions(session);
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
    <section class="connections" data-quarter="agent" aria-label="Agent 连接">
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
        <button type="button" class="conn-close" onClick={() => props.onClosed()}>
          返回手稿
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
                <Show when={skillOf(harness)}>
                  {(skill) => (
                    <span class="tool-skill" data-skill={skill()}>
                      {skillStatusLabel(skill())}
                    </span>
                  )}
                </Show>
                <small>
                  {checkedVersions()[harness.connectionId ?? ""] ?? harness.version ?? harness.tier}
                </small>
                {/*
                  「以前能用」是状态的一半：二进制死了就什么版本也答不上来，
                  唯一知道的是上一次成功探测记下的那个——照实显示，而不是
                  只剩一颗「重新连接」让作者猜为什么。
                */}
                <Show when={harness.status === "needs-attention" ? harness.lastKnownVersion : null}>
                  {(version) => (
                    <small class="tool-last-known">上次可用 v{version()}，当前不可达</small>
                  )}
                </Show>
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
                <InstallSkillAction
                  skill={skillOf(harness)}
                  connectionId={harness.connectionId}
                  busy={busy()}
                  onInstall={installSkill}
                />
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
            <PartnerCard
              agent={agent}
              reading={readingOf(agent.id)}
              harnesses={connectedHarnesses()}
              argv={session.agentArgvOf(agent)}
              busy={busy()}
              onSave={updateAgent}
              onRemove={removeAgent}
            />
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
              身份说明 <i>可留空</i>
            </span>
            <small class="conn-hint">随每次派发一起送出，定义 Agent 以什么角色工作。</small>
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
    </section>
  );
}
