import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_TIMEOUT_MS } from "./command.ts";
import { scaffold } from "./file-channel.ts";
import { type ProcessOutcome, processLifecycle } from "./process-lifecycle.ts";
import { launch } from "./spawn.ts";
import type {
  Agent,
  Capability,
  HarnessAdapter,
  ReviewTask,
  Run,
  SessionUsage,
  TokenUsage,
} from "./types.ts";

/**
 * Command adapter for Claude Code (SPEC 6.1).
 *
 * A command adapter may read fields the CLI happens to report without claiming
 * a trusted session. L2 additionally requires the real-session and compaction
 * evidence in §6.5; until then, these counts are an honest extra capability on
 * an L1 launch path.
 *
 * Claude Code's `--output-format json` returns one object on stdout carrying
 * `usage`, `session_id`, `num_turns`, and `total_cost_usd`. The cost field is
 * read and deliberately discarded: SPEC 1.3 forbids displaying prices, and a
 * number that exists in the code is a number that eventually reaches a screen.
 */

export interface ClaudeCodeConfig {
  /** Path to the `claude` binary. Not searched for: an absent binary must fail loudly. */
  readonly command?: string;
  /** Argv placed immediately after the binary, for launchers such as `bun wrapper.ts`. */
  readonly commandArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Extra argv appended verbatim, for flags this adapter does not model. */
  readonly extraArgs?: readonly string[];
}

/** The shape Claude Code returns under `--output-format json`. */
interface ClaudeResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly session_id?: string;
  readonly num_turns?: number;
  readonly model?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
  /** Present, and never surfaced. See the class comment. */
  readonly total_cost_usd?: number;
}

/**
 * Claude Code reports four token counts. They map onto `TokenUsage` without
 * arithmetic: adding cache reads into the input total would produce a number
 * the harness never stated, which is exactly the invention this layer exists
 * to prevent.
 */
const readUsage = (usage: ClaudeResult["usage"]): TokenUsage | undefined => {
  if (!usage) return undefined;
  return {
    inputOther: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    inputCacheRead: usage.cache_read_input_tokens ?? 0,
    inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
};

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  // Usage parsing is implemented, but §6.5 requires a real session and a
  // compaction signal before this adapter may claim L2.
  readonly tier = "L1" as const;

  private readonly processes = processLifecycle();
  private readonly reports = new Map<string, ClaudeResult>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly config: ClaudeCodeConfig = {}) {}

  /**
   * Argv, not a shell string.
   *
   * A prompt is author text: it will contain quotes, semicolons, and newlines,
   * and none of them may become a command. `dontAsk` makes every capability
   * outside the scoped allow rules fail closed rather than prompt in a
   * subprocess nobody is watching.
   *
   * Claude Code anchors `/` rules from inline settings at the launch directory,
   * which is always this run's Task Workspace. `Edit` is the permission rule
   * for every built-in file-writing tool; `Write(path)` is accepted by recent
   * CLIs but never matched. The tools list removes Bash, web, and every other
   * capability before the model can ask for them.
   *
   * Hooks stay on. Disabling them switched off protections the author had
   * configured for themselves, in their own harness, without telling them.
   */
  private argv(agent: Agent): string[] {
    const binary = this.config.command ?? "claude";
    const session = this.sessions.get(agent.id);
    const permissions = JSON.stringify({
      permissions: { allow: ["Read(/**)", "Edit(/**)"] },
    });

    return [
      binary,
      ...(this.config.commandArgs ?? []),
      "-p",
      "--output-format",
      "json",
      "--model",
      agent.binding.model,
      "--effort",
      agent.binding.reasoningEffort,
      "--permission-mode",
      "dontAsk",
      // The agent reads its request and writes its result. It has no reason to
      // run commands, browse, or load project integrations.
      "--tools",
      "Read,Edit,Write",
      "--settings",
      permissions,
      // Bare `{}` crashes the CLI from 2.1.59 onwards; the key must be present.
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
      "--disable-slash-commands",
      ...(session ? ["--resume", session] : []),
      ...(this.config.extraArgs ?? []),
    ];
  }

  async dispatch(run: Run, task: ReviewTask, agent: Agent): Promise<void> {
    mkdirSync(run.workspace, { recursive: true });
    writeFileSync(run.requestPath, scaffold(task), "utf8");

    const child = launch({
      argv: this.argv(agent),
      cwd: run.workspace,
      env: this.config.env,
      input: `${readFileSync(run.requestPath, "utf8")}\n\nWrite your reply to ${run.resultPath}`,
    });

    this.processes.start(run.id, child, this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  /**
   * Wait for the harness, once.
   *
   * The Host follows every launched run automatically and a caller may await
   * the same run again. A process's stdout is a stream that can be read only
   * once, so a second reader used to receive "ReadableStream has already been
   * used" instead of the outcome. The work happens once and every later caller
   * replays the same settled promise — including its rejection.
   */
  awaitCompletion(run: Run): Promise<void> {
    return this.processes.complete(run.id, (outcome) => this.finish(run, outcome));
  }

  private finish(run: Run, outcome: ProcessOutcome): void {
    const timeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (outcome.reason === "timed-out") {
      if (run.state === "dispatched") run.state = "failed";
      throw new Error(`claude-code exceeded ${timeout}ms for run ${run.id}`);
    }

    // The report is kept even on a failed run: a harness that errored still
    // spent tokens, and hiding that would understate what the round cost.
    const report = this.parse(outcome.stdout);
    if (report) {
      this.reports.set(run.id, report);
      if (report.session_id) this.sessions.set(run.agentId, report.session_id);
    }

    if (run.state !== "dispatched") return;

    if (outcome.code !== 0 || report?.is_error) {
      run.state = "failed";
      throw new Error(
        `claude-code failed for run ${run.id}: ${report?.result ?? `exit ${outcome.code}`}`,
      );
    }
  }

  /**
   * Claude Code prints one JSON object, but a wrapper script or a warning can
   * put text around it. Unparseable output costs the usage report, not the
   * run — the result file is what the Proposal is frozen from.
   */
  private parse(stdout: string): ClaudeResult | undefined {
    const trimmed = stdout.trim();
    if (trimmed === "") return undefined;

    try {
      return JSON.parse(trimmed) as ClaudeResult;
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start === -1 || end <= start) return undefined;
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as ClaudeResult;
      } catch {
        return undefined;
      }
    }
  }

  async cancel(run: Run): Promise<void> {
    if (run.state !== "dispatched") return;
    run.state = "cancelled";
    await this.processes.cancel(run.id);
    await this.awaitCompletion(run).catch(() => undefined);
  }

  /**
   * What the harness said, tagged `actual`.
   *
   * `unknown` until a run has reported. Reporting zero before anything has run
   * would be a number this application invented, and SPEC 1.3 says an absent
   * count displays as unknown rather than as nothing spent.
   */
  usage(): Capability<SessionUsage> {
    const latest = [...this.reports.values()].at(-1);
    const turn = readUsage(latest?.usage);
    return turn ? { kind: "actual", value: { currentTurn: turn } } : { kind: "unknown" };
  }

  /** Usage for one run, so a Proposal can carry its harness token report. */
  usageFor(runId: string): Capability<SessionUsage> {
    const turn = readUsage(this.reports.get(runId)?.usage);
    return turn ? { kind: "actual", value: { currentTurn: turn } } : { kind: "unknown" };
  }

  /**
   * The model the harness actually used, which is not always the one requested:
   * `--fallback-model` and provider routing can substitute one.
   */
  effectiveModel(): Capability<string> {
    const reported = [...this.reports.values()].at(-1)?.model;
    return reported ? { kind: "actual", value: reported } : { kind: "unknown" };
  }

  /** Session continuity, which is what `personaCarry: "first-round"` relies on. */
  sessionId(agentId: string): string | undefined {
    return this.sessions.get(agentId);
  }

  /** Turns the harness reported, for a manifest that says what a round took. */
  turnsFor(runId: string): number | undefined {
    return this.reports.get(runId)?.num_turns;
  }
}
