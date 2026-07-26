import { mkdirSync, writeFileSync } from "node:fs";
import { scaffold } from "./file-channel.ts";
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
/** Distinguishes a timeout from an exit code, which can also be a number. */
const TIMED_OUT = Symbol("timed-out");

export class CommandAdapter implements HarnessAdapter {
  readonly tier = "L1" as const;
  private readonly running = new Map<string, Bun.Subprocess>();

  constructor(private readonly config: CommandAdapterConfig) {}

  get id(): string {
    return this.config.id;
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

    // `Bun.spawn` throws synchronously when the binary does not exist, which is
    // what lets the Host put the task back on the queue: a run that never
    // started must not leave a workspace or a queue entry behind.
    this.running.set(
      run.id,
      Bun.spawn(argv, {
        cwd: this.config.cwd ?? run.workspace,
        env: { ...process.env, ...this.config.env },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
  }

  /**
   * Resolve when the harness exits, or when it has taken too long.
   *
   * A terminal state is final. A harness that exits non-zero after the author
   * cancelled it has not "failed" — the author stopped it, and rewriting that
   * would lose the distinction between a tool that broke and a decision the
   * writer made.
   */
  async awaitCompletion(run: Run): Promise<void> {
    const child = this.running.get(run.id);
    if (!child) return;

    const timeout = this.config.timeoutMs;
    const exited = timeout
      ? await Promise.race([child.exited, Bun.sleep(timeout).then(() => TIMED_OUT)])
      : await child.exited;

    this.running.delete(run.id);

    if (exited === TIMED_OUT) {
      child.kill();
      if (run.state === "dispatched") run.state = "failed";
      throw new Error(`${this.id} exceeded ${timeout}ms for run ${run.id}`);
    }

    if (run.state !== "dispatched") return;
    // Narrowed by the timeout branch above, but stated so the exit code cannot
    // be a symbol in the message a person reads.
    const code = typeof exited === "number" ? exited : -1;
    if (code !== 0) {
      run.state = "failed";
      throw new Error(`${this.id} exited ${code} for run ${run.id}`);
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
    this.running.get(run.id)?.kill();
    this.running.delete(run.id);
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
