import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentComment, appendMemos, type Proposal, parseAgentResult } from "@refrain/core";
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
  private readonly extraAdapters: HarnessAdapter[] = [];
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

  /** Adapters arrive as the author configures harnesses, not only at construction. */
  addAdapter(adapter: HarnessAdapter): this {
    this.extraAdapters.push(adapter);
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

  /**
   * One click, one consolidated dispatch. Every queued task leaves together.
   *
   * Preflight runs over the whole queue before anything starts. A queue that
   * fails halfway used to leave the author with some tasks dispatched, some
   * gone, and no way to tell which — so the checks that can be made without
   * spending anything are made first, and a failure leaves the queue intact.
   */
  async send(): Promise<readonly Run[]> {
    const resolved = this.queue.map((task) => {
      const agent = this.agents.get(task.agentId);
      if (!agent) throw new Error(`no agent registered for task ${task.id}`);

      const adapter = [...this.extraAdapters, ...this.adapters].find(
        (a) => a.id === agent.binding.harness,
      );
      if (!adapter) throw new Error(`no adapter for harness ${agent.binding.harness}`);

      return { task, agent, adapter };
    });

    const started: Run[] = [];
    const queued = this.queue.splice(0);

    for (const { task, agent, adapter } of resolved) {
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

      try {
        await adapter.dispatch(run, task, agent);
      } catch (error) {
        // The launch failed, so this run never existed. Everything queued goes
        // back, including the tasks that had already started — the author asked
        // for one dispatch, and a half-sent batch is not one.
        this.sequence -= 1;
        for (const dispatchedRun of started) {
          await this.adapterFor.get(dispatchedRun.id)?.cancel(dispatchedRun);
          this.dispatched.splice(this.dispatched.indexOf(dispatchedRun), 1);
          this.tasks.delete(dispatchedRun.id);
          this.adapterFor.delete(dispatchedRun.id);
        }
        this.queue.push(...queued);
        throw error;
      }

      this.dispatched.push(run);
      this.tasks.set(id, task);
      this.adapterFor.set(id, adapter);
      started.push(run);

      // Follow the run to its end without blocking the dispatch of the rest.
      // Before this existed a launched run stayed `dispatched` forever and the
      // author had to know to press collect — the harness finishing was not an
      // event the application could see.
      if (adapter.awaitCompletion) this.watch(run, adapter);
    }

    return started;
  }

  private readonly tasks = new Map<string, ReviewTask>();
  private readonly adapterFor = new Map<string, HarnessAdapter>();
  private readonly watching = new Map<string, Promise<void>>();

  /**
   * Wait for one run and record what happened.
   *
   * The promise is kept so a caller can await a specific run — tests need a
   * deterministic point to observe, and a UI wants to know when a run is worth
   * collecting. Failures are recorded on the run rather than thrown: a rejected
   * promise nobody is awaiting becomes an unhandled rejection, which in
   * Electron's main process takes the window with it.
   */
  private watch(run: Run, adapter: HarnessAdapter): void {
    const settled = (async () => {
      try {
        await adapter.awaitCompletion?.(run);
      } catch (error) {
        // A terminal state is final. A late failure must not rewrite a run the
        // author already cancelled, or one that already produced a result.
        if (run.state === "dispatched") {
          run.state = "failed";
          this.failures.set(run.id, String(error));
        }
        return;
      }

      /*
       * The harness exited cleanly, so the result is read now rather than when
       * the author happens to press collect. Freezing here is what moves the
       * run out of `dispatched` — and `collect` stays idempotent, so pressing
       * it afterwards returns the same Proposals rather than parsing twice.
       *
       * A malformed artifact marks the run failed and keeps the reason. It is
       * not thrown: nobody is awaiting this promise, and an unhandled rejection
       * in Electron's main process takes the window with it.
       */
      if (run.state !== "dispatched") return;
      try {
        await this.collect(run.id);
      } catch (error) {
        this.failures.set(run.id, String(error));
      }
    })();

    this.watching.set(run.id, settled);
  }

  private readonly failures = new Map<string, string>();

  /** Why a run failed, for the interface to show verbatim. */
  failureFor(runId: string): string | undefined {
    return this.failures.get(runId);
  }

  /**
   * Resolve once the harness has finished with this run.
   *
   * Returns immediately for adapters with nothing to wait on, so a caller does
   * not have to know which tier it is dealing with.
   */
  async settled(runId: string): Promise<void> {
    await this.watching.get(runId);
  }

  /** Resolve once every dispatched run has finished. */
  async allSettled(): Promise<void> {
    await Promise.all([...this.watching.values()]);
  }

  /**
   * Freeze a completed Result Artifact into Proposals. An invalid artifact
   * throws and leaves the run un-completed: a Proposal is only ever frozen
   * from a validated artifact (SPEC 3.1 rule 3).
   */
  async collect(runId: string): Promise<readonly Proposal[]> {
    // Idempotent: the Host collects automatically when a launched harness
    // exits, and the author may press collect afterwards. Parsing twice would
    // append the memo twice and mint a second set of Proposals for one run.
    const frozen = this.proposals.get(runId);
    if (frozen) return frozen;

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
    appendMemos(this.root, run.agentId, runId, parsed.value.memos);
    run.state = "completed";

    const proposals = parsed.value.replacements.flatMap((replacement) => {
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

    this.proposals.set(runId, proposals);
    return proposals;
  }

  private readonly proposals = new Map<string, readonly Proposal[]>();

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
