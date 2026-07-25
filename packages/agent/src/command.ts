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

  /** Resolves when the harness exits. A non-zero exit fails the run loudly. */
  async awaitCompletion(run: Run): Promise<void> {
    const child = this.running.get(run.id);
    if (!child) return;

    const code = await child.exited;
    this.running.delete(run.id);

    if (run.state === "cancelled") return;
    if (code !== 0) {
      run.state = "failed";
      throw new Error(`${this.id} exited ${code} for run ${run.id}`);
    }
  }

  async cancel(run: Run): Promise<void> {
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
