import { mkdirSync, writeFileSync } from "node:fs";
import { scaffold } from "./file-channel.ts";
import { type ProcessOutcome, processLifecycle } from "./process-lifecycle.ts";
import { launch } from "./spawn.ts";
import type { Agent, Capability, HarnessAdapter, ReviewTask, Run, SessionUsage } from "./types.ts";

export interface CommandAdapterConfig {
  readonly id: string;
  /**
   * Argv template. `{request}` and `{result}` are substituted with absolute
   * paths; `{prompt}` with the task prompt. Argv rather than a shell string:
   * a prompt containing a quote or a semicolon must never become a command.
   */
  readonly template: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * L1 adapter for any harness with a command-line entry point (SPEC 6.1).
 *
 * One generic adapter covers every CLI harness a user already has, which is
 * what makes the compatibility claim affordable: an L2 adapter reads a
 * harness's native event stream, but reaching L1 costs a template.
 */
/**
 * How long a harness may run before RefRain stops waiting for it.
 *
 * `timeoutMs` was optional and every construction site left it out, so an
 * adapter shipped with no timeout at all: a harness that hung held its Run in
 * `dispatched` forever, and a Run that never settles is a Run whose Proposals
 * never arrive. Twenty minutes is long enough for a slow model on a long
 * chapter and short enough that a wedged process does not outlive the session.
 * A configuration may still say otherwise.
 */
export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000;

export class CommandAdapter implements HarnessAdapter {
  readonly tier = "L1" as const;
  private readonly processes = processLifecycle();

  constructor(private readonly config: CommandAdapterConfig) {}

  get id(): string {
    return this.config.id;
  }

  get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async dispatch(run: Run, task: ReviewTask, _agent: Agent): Promise<void> {
    mkdirSync(run.workspace, { recursive: true });
    writeFileSync(run.requestPath, scaffold(task), "utf8");

    const argv = this.config.template.map((part) =>
      part
        .replaceAll("{request}", run.requestPath)
        .replaceAll("{result}", run.resultPath)
        .replaceAll("{prompt}", task.prompt),
    );

    // Output is drained from the moment the process starts. A harness that
    // writes past the pipe buffer before anyone reads blocks on its own write,
    // and the parent then waits forever for an exit that cannot come.
    const child = launch({
      argv,
      cwd: this.config.cwd ?? run.workspace,
      env: this.config.env,
    });
    this.processes.start(run.id, child, this.timeoutMs);
  }

  /**
   * Resolve when the harness exits, or when it has taken too long.
   *
   * A terminal state is final. A harness that exits non-zero after the author
   * cancelled it has not "failed" — the author stopped it, and rewriting that
   * would lose the distinction between a tool that broke and a decision the
   * writer made.
   */
  awaitCompletion(run: Run): Promise<void> {
    return this.processes.complete(run.id, (outcome) => this.finish(run, outcome));
  }

  private finish(run: Run, outcome: ProcessOutcome): void {
    if (outcome.reason === "timed-out") {
      if (run.state === "dispatched") run.state = "failed";
      throw new Error(`${this.id} exceeded ${this.timeoutMs}ms for run ${run.id}`);
    }

    if (run.state !== "dispatched") return;
    if (outcome.code !== 0) {
      run.state = "failed";
      throw new Error(`${this.id} exited ${outcome.code} for run ${run.id}`);
    }
  }

  /**
   * Stop a run the author no longer wants.
   *
   * Only a run still in flight can be cancelled. Cancelling one that already
   * completed would erase a result the author can see, so a finished run keeps
   * the state it earned.
   */
  async cancel(run: Run): Promise<void> {
    if (run.state !== "dispatched") return;
    run.state = "cancelled";
    await this.processes.cancel(run.id);
    await this.awaitCompletion(run).catch(() => undefined);
  }

  /**
   * A command-line harness reports no usage through this channel. Saying
   * unknown keeps the display honest; an L2 adapter reads the real numbers.
   */
  usage(): Capability<SessionUsage> {
    return { kind: "unknown" };
  }

  effectiveModel(): Capability<string> {
    return { kind: "unknown" };
  }
}
