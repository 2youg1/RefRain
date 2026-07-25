import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentComment, type Proposal, parseAgentResult } from "@recension/core";
import { FileChannelAdapter } from "./file-channel.ts";
import type { Agent, HarnessAdapter, ReviewTask, Run } from "./types.ts";

/** What the author sees before one click sends everything (SPEC 3.2). */
export interface ManifestEntry {
  readonly agentName: string;
  readonly harness: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly runCount: number;
  readonly scopes: readonly string[];
  readonly prompts: readonly string[];
  /** Scopes whose text changed while queued. The author decides what to do. */
  readonly drifted: readonly string[];
}

/**
 * The local process holding agents, the pending queue, runs, and results.
 *
 * Dispatch is manual by construction: `enqueue` only queues, and nothing leaves
 * the queue without `send`. Idle time, cursor movement, and autosave have no
 * path into this class.
 */
export class AgentHost {
  private readonly agents = new Map<string, Agent>();
  private readonly queue: ReviewTask[] = [];
  private readonly dispatched: Run[] = [];
  private readonly comments = new Map<string, AgentComment[]>();
  private readonly drifted = new Set<string>();
  private sequence = 0;

  constructor(
    private readonly root: string,
    private readonly adapters: readonly HarnessAdapter[] = [new FileChannelAdapter(root)],
  ) {}

  register(agent: Agent): this {
    this.agents.set(agent.id, agent);
    return this;
  }

  enqueue(task: ReviewTask): this {
    this.queue.push(task);
    return this;
  }

  pending(): readonly ReviewTask[] {
    return this.queue;
  }

  runs(): readonly Run[] {
    return this.dispatched;
  }

  commentsFor(runId: string): readonly AgentComment[] {
    return this.comments.get(runId) ?? [];
  }

  /**
   * SPEC 3.5: a scope whose text moved is marked, not cancelled. Cancellation
   * belongs to the human, who alone knows whether the change matters.
   */
  noteManuscriptChange(blockId: string, _text: string): void {
    for (const task of this.queue)
      for (const scope of task.editScopes)
        if (scope.blockIds.includes(blockId)) this.drifted.add(scope.id);
  }

  isDrifted(scopeId: string): boolean {
    return this.drifted.has(scopeId);
  }

  /** One click, one consolidated dispatch. Every queued task leaves together. */
  async send(): Promise<readonly Run[]> {
    const started: Run[] = [];

    for (const task of this.queue.splice(0)) {
      const agent = this.agents.get(task.agentId);
      if (!agent) throw new Error(`no agent registered for task ${task.id}`);

      const adapter = this.adapters.find((a) => a.id === agent.binding.harness);
      if (!adapter) throw new Error(`no adapter for harness ${agent.binding.harness}`);

      const id = `run${++this.sequence}`;
      const workspace = join(this.root, "runs", id);
      const run: Run = {
        id,
        taskId: task.id,
        agentId: agent.id,
        baseline: task.baseline,
        workspace,
        requestPath: join(workspace, "request.md"),
        resultPath: join(workspace, "result.md"),
        state: "dispatched",
      };

      await adapter.dispatch(run, task, agent);
      this.dispatched.push(run);
      this.tasks.set(id, task);
      started.push(run);
    }

    return started;
  }

  private readonly tasks = new Map<string, ReviewTask>();

  /**
   * Freeze a completed Result Artifact into Proposals. An invalid artifact
   * throws and leaves the run un-completed: a Proposal is only ever frozen
   * from a validated artifact (SPEC 3.1 rule 3).
   */
  async collect(runId: string): Promise<readonly Proposal[]> {
    const run = this.dispatched.find((r) => r.id === runId);
    const task = this.tasks.get(runId);
    if (!run || !task) throw new Error(`unknown run ${runId}`);
    if (!existsSync(run.resultPath)) throw new Error(`run ${runId} has written no result yet`);

    const parsed = parseAgentResult(readFileSync(run.resultPath, "utf8"));
    if (!parsed.ok) {
      run.state = "failed";
      throw new Error(`${parsed.error.code}: ${parsed.error.detail}`);
    }

    this.comments.set(runId, [...parsed.value.comments]);
    run.state = "completed";

    return parsed.value.replacements.flatMap((replacement) => {
      const scope = task.editScopes.find((s) => s.id === replacement.scope);
      if (!scope) return [];
      return [
        {
          id: `${runId}:${scope.id}`,
          runId,
          baseline: run.baseline,
          scope: { id: scope.id, blockIds: scope.blockIds },
          before: scope.text,
          after: replacement.text,
        } satisfies Proposal,
      ];
    });
  }

  agentFor(id: string): Agent | undefined {
    return this.agents.get(id);
  }
}

/**
 * SPEC 3.2: before sending, the author sees run count, locked binding, scope
 * ranges, and prompt text — and no prices, because this application performs
 * no billing math at all.
 */
export const sendManifest = (host: AgentHost): readonly ManifestEntry[] => {
  const byAgent = new Map<string, ReviewTask[]>();
  for (const task of host.pending())
    byAgent.set(task.agentId, [...(byAgent.get(task.agentId) ?? []), task]);

  return [...byAgent].flatMap(([agentId, tasks]) => {
    const agent = host.agentFor(agentId);
    if (!agent) return [];
    const scopes = tasks.flatMap((t) => t.editScopes.map((s) => s.id));

    return [
      {
        agentName: agent.name,
        harness: agent.binding.harness,
        model: agent.binding.model,
        reasoningEffort: agent.binding.reasoningEffort,
        runCount: tasks.length,
        scopes,
        prompts: tasks.map((t) => t.prompt),
        drifted: scopes.filter((id) => host.isDrifted(id)),
      },
    ];
  });
};
