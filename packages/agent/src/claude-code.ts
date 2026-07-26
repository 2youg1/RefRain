import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { scaffold } from "./file-channel.ts";
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
 * L2 adapter for Claude Code (SPEC 6.1).
 *
 * L1 launches a command and learns nothing about what it cost. L2 reads the
 * harness's own report, which is the difference between "we do not lie about
 * tokens" and "we tell you what the harness told us" — the second half of the
 * transparency this application promises.
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
  readonly cwd?: string;
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

const TIMED_OUT = Symbol("timed-out");

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
  readonly tier = "L2" as const;

  private readonly running = new Map<string, Bun.Subprocess>();
  private readonly reports = new Map<string, ClaudeResult>();
  /** One settled outcome per run, replayed to every later caller. */
  private readonly settled = new Map<string, Promise<void>>();
  private lastSession: string | undefined;

  constructor(private readonly config: ClaudeCodeConfig = {}) {}

  /**
   * Argv, not a shell string.
   *
   * A prompt is author text: it will contain quotes, semicolons, and newlines,
   * and none of them may become a command. `--permission-mode dontAsk` with an
   * explicit allowlist means anything not named here is denied rather than
   * prompted — a prompt in a subprocess nobody is watching hangs forever.
   */
  private argv(agent: Agent): string[] {
    const binary = this.config.command ?? "claude";

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
      // run commands, and this application never lets one merge anything.
      "--allowedTools",
      "Read,Write",
      "--settings",
      '{"disableAllHooks": true}',
      // Bare `{}` crashes the CLI from 2.1.59 onwards; the key must be present.
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
      "--disable-slash-commands",
      ...(this.lastSession ? ["--resume", this.lastSession] : []),
      ...(this.config.extraArgs ?? []),
    ];
  }

  async dispatch(run: Run, task: ReviewTask, agent: Agent): Promise<void> {
    mkdirSync(run.workspace, { recursive: true });
    writeFileSync(run.requestPath, scaffold(task), "utf8");

    const child = Bun.spawn(this.argv(agent), {
      cwd: this.config.cwd ?? run.workspace,
      env: { ...process.env, ...this.config.env },
      stdin: new Response(
        `${readFileSync(run.requestPath, "utf8")}\n\nWrite your reply to ${run.resultPath}`,
      ),
      stdout: "pipe",
      stderr: "pipe",
    });

    this.running.set(run.id, child);
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
    const existing = this.settled.get(run.id);
    if (existing) return existing;

    const settling = this.settle(run);
    // Attach a sink so a rejection nobody awaits cannot become an unhandled
    // rejection, which in Electron's main process takes the window with it.
    settling.catch(() => undefined);
    this.settled.set(run.id, settling);
    return settling;
  }

  private async settle(run: Run): Promise<void> {
    const child = this.running.get(run.id);
    if (!child) return;

    const timeout = this.config.timeoutMs;
    const exited = timeout
      ? await Promise.race([child.exited, Bun.sleep(timeout).then(() => TIMED_OUT)])
      : await child.exited;

    if (exited === TIMED_OUT) {
      child.kill();
      await child.exited;
      this.running.delete(run.id);
      if (run.state === "dispatched") run.state = "failed";
      throw new Error(`claude-code exceeded ${timeout}ms for run ${run.id}`);
    }

    // `stdout` is a stream only because dispatch asked for a pipe; the type
    // also admits a file descriptor, so the narrowing is stated rather than
    // assumed.
    const stdout =
      child.stdout instanceof ReadableStream ? await new Response(child.stdout).text() : "";
    this.running.delete(run.id);

    // The report is kept even on a failed run: a harness that errored still
    // spent tokens, and hiding that would understate what the round cost.
    const report = this.parse(stdout);
    if (report) {
      this.reports.set(run.id, report);
      if (report.session_id) this.lastSession = report.session_id;
    }

    if (run.state !== "dispatched") return;

    const code = typeof exited === "number" ? exited : -1;
    if (code !== 0 || report?.is_error) {
      run.state = "failed";
      throw new Error(`claude-code failed for run ${run.id}: ${report?.result ?? `exit ${code}`}`);
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
    this.running.get(run.id)?.kill();
    this.running.delete(run.id);
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
    if (!turn) return { kind: "unknown" };

    const total = [...this.reports.values()].reduce<TokenUsage>(
      (running, report) => {
        const each = readUsage(report.usage);
        if (!each) return running;
        return {
          inputOther: running.inputOther + each.inputOther,
          output: running.output + each.output,
          inputCacheRead: running.inputCacheRead + each.inputCacheRead,
          inputCacheCreation: running.inputCacheCreation + each.inputCacheCreation,
        };
      },
      { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    );

    return { kind: "actual", value: { currentTurn: turn, total } };
  }

  /** Usage for one run, so the interface can attribute a cost to its proposal. */
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
  sessionId(): string | undefined {
    return this.lastSession;
  }

  /** Turns the harness reported, for a manifest that says what a round took. */
  turnsFor(runId: string): number | undefined {
    return this.reports.get(runId)?.num_turns;
  }
}
