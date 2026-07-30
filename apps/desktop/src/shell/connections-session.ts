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
} from "../generated/bindings.gen";
import { type Activity, type DescribeError, Session } from "./session";

/** What this session can be busy doing. Named so a surface can say which. */
export type ConnectionsOperation =
  | "load"
  | "connect"
  | "disconnect"
  | "probe"
  | "create-agent"
  | "remove-agent";

/** The shared operation state, narrowed to this session's operations. */
export type ConnectionsActivity = Activity<ConnectionsOperation>;

export interface ConnectionsView {
  readonly harnesses: readonly HarnessDto[];
  readonly agents: readonly AgentDto[];
  readonly activity: ConnectionsActivity;
  /** Versions confirmed by a probe in this session, keyed by connection id. */
  readonly checkedVersions: Readonly<Record<string, string>>;
}

/** Exactly the six calls this session makes. A test double is six functions. */
export interface ConnectionsGateway {
  listHarnesses(): Promise<HarnessDto[]>;
  listAgents(): Promise<AgentDto[]>;
  agentReadingLedger(rootId: string): Promise<AgentReadingDto[]>;
  upsertHarnessConnection(candidateId: string): Promise<unknown>;
  removeHarnessConnection(connectionId: string): Promise<unknown>;
  probeConnection(connectionId: string): Promise<string>;
  upsertAgent(name: string, channel: string | null, persona: string | null): Promise<unknown>;
  removeAgent(id: string): Promise<unknown>;
}

export const browserConnectionsGateway: ConnectionsGateway = {
  listHarnesses: () => unwrap(commands.listHarnesses()),
  listAgents: () => commands.listAgents(),
  agentReadingLedger: (rootId) => unwrap(commands.agentReadingLedger(rootId)),
  upsertHarnessConnection: (candidateId) => unwrap(commands.upsertHarnessConnection(candidateId)),
  removeHarnessConnection: (connectionId) => unwrap(commands.removeHarnessConnection(connectionId)),
  probeConnection: (connectionId) => unwrap(commands.probeConnection(connectionId)),
  upsertAgent: (name, channel, persona) => unwrap(commands.upsertAgent(name, channel, persona)),
  removeAgent: (id) => unwrap(commands.removeAgent(id)),
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
