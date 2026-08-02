/**
 * The one owner of "which agents and harnesses this machine can talk to".
 *
 * Six operations previously lived in the component, each repeating the same
 * five steps: refuse if busy, clear the notice, cross the bridge, refresh the
 * whole catalogue, release the lock in `finally`. Repeating a sequence six
 * times is how a missing concept announces itself — the concept is "one
 * exclusive operation against the connection catalogue", and it lives here.
 *
 * Framework-free: no solid-js import, no DOM. The surface subscribes, reads
 * `view()`, and emits intents.
 */

import { unwrap } from "../bridge";
import {
  type AgentDto,
  type AgentReadingDto,
  commands,
  type HarnessDto,
  type SkillStatus,
} from "../generated/bindings.gen";
import { type Activity, type DescribeError, Session } from "./session";

/** 徽章与按钮读同一张表；形状归桥（生成的 SkillStatus），措辞归这里。 */
export type { SkillStatus } from "../generated/bindings.gen";

/** What this session can be busy doing. Named so a surface can say which. */
export type ConnectionsOperation =
  | "load"
  | "connect"
  | "disconnect"
  | "probe"
  | "install-skill"
  | "create-agent"
  | "update-agent"
  | "remove-agent";

/** The shared operation state, narrowed to this session's operations. */
export type ConnectionsActivity = Activity<ConnectionsOperation>;

/**
 * 协议在一个连接上的装载状态：未装 / 已装 / 过期（桥用 digest 比对得出）。
 */
export function skillStatusLabel(status: SkillStatus): string {
  switch (status) {
    case "none":
      return "未装协议";
    case "current":
      return "协议已装";
    case "stale":
      return "协议过期";
  }
}

/**
 * 启动参数的解析结果：一个 argv 数组，或一句作者读得懂的拒绝。
 * 鉴别联合而不是 string[] | null：null 既是「留空」又是「解析失败」，
 * 两种意思不该共用一个值。
 */
export type ArgvParse =
  | { readonly kind: "ok"; readonly argv: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * 自由文本 → argv 数组。空白分词，双引号成团。
 *
 * 危险旗标与 shell 元字符的白名单校验权威在 harness 适配器（它最懂自己
 * 启动什么）；这里只做一层就近的诚实的预检——明显不该出现在 argv 里的
 * 东西在过桥前就拦下，省一次注定失败的往返。
 */
export function parseAgentArgv(text: string): ArgvParse {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "ok", argv: [] };
  // 双引号成团，所以引号必须成对——落单的那只不是「宽松一点」，是作者
  // 写错了一半，照单收会把一个带着引号字符的参数递出去。
  if ((trimmed.match(/"/g) ?? []).length % 2 !== 0) {
    return { kind: "invalid", reason: "启动参数里有一只落单的双引号。" };
  }
  const argv: string[] = [];
  // 逐个成团：引号内的是一团，引号外的按空白切。单引号不成团——启动不经
  // shell，它在 argv 里本来就是个普通字符，解析与执行同一条语义。
  for (const match of trimmed.matchAll(/"([^"]*)"|(\S+)/g)) {
    argv.push(match[1] ?? match[2] ?? "");
  }
  for (const token of argv) {
    if (/[;&|><$`]/.test(token)) {
      return {
        kind: "invalid",
        reason: `「${token}」带着 shell 元字符——启动不经 shell，它没有意义，请去掉。`,
      };
    }
    if (token.startsWith("--dangerously")) {
      return { kind: "invalid", reason: `「${token}」是危险旗标，不接受写进启动参数。` };
    }
  }
  return { kind: "ok", argv };
}

export interface ConnectionsView {
  readonly harnesses: readonly HarnessDto[];
  readonly agents: readonly AgentDto[];
  readonly activity: ConnectionsActivity;
  /** Versions confirmed by a probe in this session, keyed by connection id. */
  readonly checkedVersions: Readonly<Record<string, string>>;
}

/** Exactly the bridge calls this session makes. A test double is this list and nothing more. */
export interface ConnectionsGateway {
  listHarnesses(): Promise<HarnessDto[]>;
  listAgents(): Promise<AgentDto[]>;
  agentReadingLedger(rootId: string): Promise<AgentReadingDto[]>;
  upsertHarnessConnection(candidateId: string): Promise<unknown>;
  removeHarnessConnection(connectionId: string): Promise<unknown>;
  probeConnection(connectionId: string): Promise<string>;
  upsertAgent(name: string, channel: string | null, persona: string | null): Promise<unknown>;
  /** 原地改一个已存在的伙伴：id 必须来自 list_agents，改名不新建。 */
  updateAgent(
    id: string,
    name: string,
    connectionId: string | null,
    persona: string | null,
    argv: readonly string[],
  ): Promise<unknown>;
  removeAgent(id: string): Promise<unknown>;
  /**
   * 把协议装进一个连接的 skill 目录。显式按钮触发的写路径——第一种写到
   * Root 之外的字节，所以只有点击能到它。
   */
  installSkill(connectionId: string): Promise<unknown>;
}

export const browserConnectionsGateway: ConnectionsGateway = {
  listHarnesses: () => unwrap(commands.listHarnesses()),
  listAgents: () => commands.listAgents(),
  agentReadingLedger: (rootId) => unwrap(commands.agentReadingLedger(rootId)),
  upsertHarnessConnection: (candidateId) => unwrap(commands.upsertHarnessConnection(candidateId)),
  removeHarnessConnection: (connectionId) => unwrap(commands.removeHarnessConnection(connectionId)),
  probeConnection: (connectionId) => unwrap(commands.probeConnection(connectionId)),
  // 新建不带启动参数——那是编辑表单的事；第一棒总是空 argv 出发。
  upsertAgent: (name, channel, persona) => unwrap(commands.upsertAgent(name, channel, persona, [])),
  updateAgent: (id, name, connectionId, persona, argv) =>
    unwrap(commands.updateAgent(id, name, connectionId, persona, [...argv])),
  removeAgent: (id) => unwrap(commands.removeAgent(id)),
  installSkill: (connectionId) => unwrap(commands.installSkill(connectionId)),
};

export class ConnectionsSession extends Session<ConnectionsOperation> {
  #harnesses: readonly HarnessDto[] = [];
  #agents: readonly AgentDto[] = [];
  #ledger: readonly AgentReadingDto[] = [];
  #checkedVersions: Record<string, string> = {};

  constructor(
    private readonly gateway: ConnectionsGateway,
    private readonly rootId: string,
    private readonly describe: DescribeError,
  ) {
    super();
  }

  protected describeError(error: unknown): string {
    return this.describe(error);
  }

  view(): ConnectionsView {
    return {
      harnesses: this.#harnesses,
      agents: this.#agents,
      activity: this.activity,
      checkedVersions: this.#checkedVersions,
    };
  }

  /** Reading state for one agent, or null when it has read nothing yet. */
  readingOf(agentId: string): AgentReadingDto | null {
    return this.#ledger.find((row) => row.agentId === agentId) ?? null;
  }

  load(): Promise<void> {
    return this.exclusive("load", async () => {
      await this.#refresh();
      return null;
    });
  }

  connect(candidateId: string): Promise<void> {
    return this.exclusive("connect", async () => {
      await this.gateway.upsertHarnessConnection(candidateId);
      await this.#refresh();
      return "已连接。可以创建写作伙伴了。";
    });
  }

  disconnect(connectionId: string): Promise<void> {
    return this.exclusive("disconnect", async () => {
      await this.gateway.removeHarnessConnection(connectionId);
      // A stale version would claim we still know something about a harness
      // this machine is no longer talking to.
      const { [connectionId]: _removed, ...rest } = this.#checkedVersions;
      this.#checkedVersions = rest;
      await this.#refresh();
      return "已断开连接。";
    });
  }

  probe(connectionId: string): Promise<void> {
    return this.exclusive("probe", async () => {
      const version = await this.gateway.probeConnection(connectionId);
      this.#checkedVersions = { ...this.#checkedVersions, [connectionId]: version };
      return `测试通过：${version}`;
    });
  }

  createAgent(name: string, channel: string, persona: string): Promise<void> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return Promise.resolve();
    return this.exclusive("create-agent", async () => {
      await this.gateway.upsertAgent(
        trimmedName,
        channel === "" ? null : channel,
        persona.trim() === "" ? null : persona.trim(),
      );
      await this.#refresh();
      return "写作伙伴已就绪。派发时可以直接选择它。";
    });
  }

  /**
   * 原地改一个伙伴：同一个 id，不是删了重建——重建会丢掉它在账本里的
   * 参与记录（reading ledger 按 id 记）。
   *
   * 启动参数先过 parseAgentArgv：明显不合法的不过桥；桥侧适配器的白名单
   * 校验仍是权威，它拒了的措辞原样落在公告里。
   */
  updateAgent(
    id: string,
    name: string,
    channel: string,
    persona: string,
    argvText: string,
  ): Promise<void> {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return Promise.resolve();
    const parsed = parseAgentArgv(argvText);
    if (parsed.kind === "invalid") {
      this.report(parsed.reason);
      return Promise.resolve();
    }
    return this.exclusive("update-agent", async () => {
      await this.gateway.updateAgent(
        id,
        trimmedName,
        channel === "" ? null : channel,
        persona.trim() === "" ? null : persona.trim(),
        parsed.argv,
      );
      await this.#refresh();
      return "已保存写作伙伴的修改。";
    });
  }

  /**
   * 装协议：把生成的 SKILL 文本写进这个连接的 skill 目录。装失败、装完
   * digest 不符，都如实显示——「接续诚实性」对装与被装是同一条规矩。
   */
  installSkill(connectionId: string): Promise<void> {
    return this.exclusive("install-skill", async () => {
      await this.gateway.installSkill(connectionId);
      await this.#refresh();
      return "协议已安装。";
    });
  }

  /** 一个连接的协议装载状态，桥用 digest 比对得出。 */
  skillStatusOf(harness: HarnessDto): SkillStatus {
    return harness.skillStatus;
  }

  /** 一个伙伴已存的启动参数：编辑表单的预填，原样示出，不加不减。 */
  agentArgvOf(agent: AgentDto): readonly string[] {
    return agent.argv;
  }

  removeAgent(id: string): Promise<void> {
    return this.exclusive("remove-agent", async () => {
      await this.gateway.removeAgent(id);
      await this.#refresh();
      return "已移除写作伙伴。";
    });
  }

  async #refresh(): Promise<void> {
    const [harnesses, agents] = await Promise.all([
      this.gateway.listHarnesses(),
      this.gateway.listAgents(),
    ]);
    this.#harnesses = harnesses;
    this.#agents = agents;
    // The reading ledger is per-project and only meaningful once agents exist.
    this.#ledger = agents.length === 0 ? [] : await this.gateway.agentReadingLedger(this.rootId);
  }
}

/** The author-facing name for a harness state. */
export function harnessStatusLabel(status: HarnessDto["status"]): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "available":
      return "已找到";
    case "missing":
      return "这台电脑上未找到";
    case "needs-attention":
      return "需要重新连接";
  }
}
