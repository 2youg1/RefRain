import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentComment, appendMemos, type Proposal, parseAgentResult } from "@refrain/core";
import { FileChannelAdapter } from "./file-channel.ts";
import { type HostState, readHostState, type StoredRun, writeHostState } from "./host-state.ts";
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
  ) {
    this.restore(readHostState(root));
  }

  private restore(state: HostState): void {
    this.sequence = state.sequence;
    this.queue.push(...state.queue);
    for (const scopeId of state.drifted) this.drifted.add(scopeId);
    for (const stored of state.runs) {
      const workspace = join(this.root, "runs", stored.id);
      const run: Run = {
        id: stored.id,
        taskId: stored.task.id,
        agentId: stored.task.agentId,
        baseline: stored.task.baseline,
        workspace,
        requestPath: join(workspace, "request.md"),
        resultPath: join(workspace, "result.md"),
        state: stored.state,
      };
      this.dispatched.push(run);
      this.tasks.set(run.id, stored.task);
      this.comments.set(run.id, [...stored.comments]);
      if (stored.state === "completed" || stored.proposals.length > 0)
        this.proposals.set(run.id, [...stored.proposals]);
      if (stored.failure !== undefined) this.failures.set(run.id, stored.failure);
    }
  }

  private storedRun(run: Run): StoredRun | undefined {
    const task = this.tasks.get(run.id);
    if (!task) return undefined;
    const failure = this.failures.get(run.id);
    return {
      id: run.id,
      state: run.state,
      task,
      ...(failure === undefined ? {} : { failure }),
      comments: this.comments.get(run.id) ?? [],
      proposals: this.proposals.get(run.id) ?? [],
    };
  }

  private persist(): void {
    writeHostState(this.root, {
      version: 1,
      sequence: this.sequence,
      queue: this.queue,
      runs: this.dispatched.flatMap((run) => {
        const stored = this.storedRun(run);
        return stored === undefined ? [] : [stored];
      }),
      drifted: [...this.drifted],
    });
  }

  register(agent: Agent): this {
    this.agents.set(agent.id, agent);
    return this;
  }

  unregister(agentId: string): this {
    this.agents.delete(agentId);
    return this;
  }

  /** Adapters arrive as the author configures harnesses, not only at construction. */
  addAdapter(adapter: HarnessAdapter): this {
    this.extraAdapters.push(adapter);
    return this;
  }

  enqueue(task: ReviewTask): this {
    this.queue.push(task);
    try {
      this.persist();
    } catch (error) {
      this.queue.pop();
      throw error;
    }
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
    const added: string[] = [];
    for (const task of this.queue)
      for (const scope of task.editScopes)
        if (scope.blockIds.includes(blockId) && !this.drifted.has(scope.id)) {
          this.drifted.add(scope.id);
          added.push(scope.id);
        }
    if (added.length === 0) return;
    try {
      this.persist();
    } catch (error) {
      for (const scopeId of added) this.drifted.delete(scopeId);
      throw error;
    }
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
        (candidate) => candidate.id === agent.binding.harness,
      );
      if (!adapter) throw new Error(`no adapter for harness ${agent.binding.harness}`);

      return { task, agent, adapter };
    });
    if (resolved.length === 0) return [];

    const queued = this.queue.splice(0);
    const planned = resolved.map(({ task, agent, adapter }) => {
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
      this.dispatched.push(run);
      this.tasks.set(id, task);
      this.adapterFor.set(id, adapter);
      return { task, agent, adapter, run };
    });

    try {
      // The intent reaches disk before a harness can start. A crash therefore
      // leaves an explainable dispatched Run rather than an unowned process.
      this.persist();
      for (const { task, agent, adapter, run } of planned) await adapter.dispatch(run, task, agent);
    } catch (error) {
      for (const { adapter, run } of planned)
        if (run.workspace) await adapter.cancel(run).catch(() => undefined);
      const plannedIds = new Set(planned.map(({ run }) => run.id));
      this.dispatched.splice(
        0,
        this.dispatched.length,
        ...this.dispatched.filter((run) => !plannedIds.has(run.id)),
      );
      for (const id of plannedIds) {
        this.tasks.delete(id);
        this.adapterFor.delete(id);
        this.watching.delete(id);
        this.failures.delete(id);
        this.comments.delete(id);
        this.proposals.delete(id);
      }
      this.queue.push(...queued);
      this.persist();
      throw error;
    }

    // Do not watch an early run until the whole one-click batch has launched.
    // Otherwise a fast first process can freeze material that a later launch
    // failure then tries to roll back.
    for (const { adapter, run } of planned) if (adapter.awaitCompletion) this.watch(run, adapter);
    return planned.map(({ run }) => run);
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
          try {
            this.persist();
          } catch (persistenceError) {
            this.failures.set(run.id, `${String(error)}; state was not saved: ${persistenceError}`);
          }
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
        // `collect` may already have signed a terminal failure. A late error —
        // including a rejected retry — cannot rewrite that reason or state.
        if (run.state === "dispatched") {
          run.state = "failed";
          this.failures.set(run.id, String(error));
          try {
            this.persist();
          } catch (persistenceError) {
            this.failures.set(run.id, `${String(error)}; state was not saved: ${persistenceError}`);
          }
        }
      }
    })();

    this.watching.set(run.id, settled);
  }

  private readonly failures = new Map<string, string>();

  private fail(run: Run, reason: string): never {
    if (run.state === "dispatched") run.state = "failed";
    this.failures.set(run.id, reason);
    try {
      this.persist();
    } catch (error) {
      this.failures.set(run.id, `${reason}; state was not saved: ${error}`);
    }
    throw new Error(reason);
  }

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
    const run = this.dispatched.find((candidate) => candidate.id === runId);
    const task = this.tasks.get(runId);
    if (!run || !task) throw new Error(`unknown run ${runId}`);

    // Idempotent across automatic collection, a button press, and a restart.
    const frozen = this.proposals.get(runId);
    if (frozen) return frozen;
    if (run.state !== "dispatched")
      throw new Error(`run ${runId} is already ${run.state}; late material cannot change it`);
    if (!existsSync(run.resultPath)) this.fail(run, `run ${runId} has written no result yet`);

    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(run.resultPath));
    } catch {
      this.fail(run, `run ${runId} wrote invalid UTF-8`);
    }
    const parsed = parseAgentResult(source);
    if (!parsed.ok) this.fail(run, `${parsed.error.code}: ${parsed.error.detail}`);

    const scopes = new Map(task.editScopes.map((scope) => [scope.id, scope]));
    const proposals = parsed.value.replacements.map((replacement) => {
      const scope = scopes.get(replacement.scope);
      if (!scope) this.fail(run, `unknown scope ${replacement.scope} in run ${runId}`);
      return {
        id: `${runId}:${scope.id}`,
        runId,
        baseline: run.baseline,
        scope: { id: scope.id, blockIds: scope.blockIds },
        before: scope.text,
        after: replacement.text,
      } satisfies Proposal;
    });
    const comments = parsed.value.comments.filter((comment) => scopes.has(comment.target));

    // Memo append is idempotent by Run ID. It happens before the snapshot so a
    // crash can safely retry the whole collection without duplicating memory.
    appendMemos(this.root, run.agentId, runId, parsed.value.memos);
    this.comments.set(runId, comments);
    this.proposals.set(runId, proposals);
    run.state = "completed";
    try {
      this.persist();
    } catch (error) {
      run.state = "dispatched";
      this.comments.delete(runId);
      this.proposals.delete(runId);
      throw error;
    }
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
