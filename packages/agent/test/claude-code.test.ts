import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter, type ClaudeCodeConfig } from "../src/claude-code.ts";
import { AgentHost } from "../src/host.ts";
import type { Agent, ReviewTask } from "../src/types.ts";

/**
 * Contract tests for the Claude Code adapter.
 *
 * A stub binary stands in for `claude`, not a mocked class. The thing under
 * test is how this adapter reads a real process's stdout and exit code, and a
 * mock would assert that the code calls itself the way it was written.
 *
 * SPEC 6.5 asks for a real session and a real run before an adapter may claim
 * its tier. That gate belongs to the machine that has Claude Code installed;
 * these tests fix the wire format so a change in the parser fails here first.
 */

const root = join(tmpdir(), "refrain-claude-contract");
const binDir = join(root, "bin");

/** Runs the contract stub through Bun itself, so no platform shell is involved. */
/**
 * A stand-in for the `claude` binary.
 *
 * `writesResult` controls whether it produces a Result Artifact, which is what
 * a real harness does on success. Several tests used to leave it out and still
 * expect the run to survive — they were relying on the Host leaving a
 * result-less run in `dispatched` forever, which was the hang in review #29.
 * Now that such a run fails, a stub that means to succeed has to write one.
 */
const RESULT = '# Agent reply\n\n<agent-result version="1"><memo>done</memo></agent-result>';

const stubClaude = (
  stdout: string,
  code = 0,
  delayMs = 0,
  writesResult = true,
): ClaudeCodeConfig => {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, `claude-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(
    path,
    [
      `await Bun.sleep(${delayMs});`,
      // The adapter pipes the request in and names the result path in it, the
      // way it names it to the real binary.
      writesResult
        ? [
            `const asked = await Bun.stdin.text();`,
            `const at = asked.match(/Write your reply to (.+)$/m)?.[1]?.trim();`,
            `if (at) await Bun.write(at, ${JSON.stringify(RESULT)});`,
          ].join("\n")
        : "",
      `process.stdout.write(${JSON.stringify(stdout)});`,
      `process.exit(${code});`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { command: process.execPath, commandArgs: [path] };
};

/** Records three real launches so A -> B -> A can prove which Session was resumed. */
const interleavedClaude = (): {
  readonly config: ClaudeCodeConfig;
  readonly callsPath: string;
} => {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, `claude-interleaved-${Math.random().toString(36).slice(2)}.js`);
  const callsPath = join(root, "claude-interleaved-calls.json");
  writeFileSync(
    path,
    [
      `const callsPath = ${JSON.stringify(callsPath)};`,
      `let calls = [];`,
      `try { calls = JSON.parse(await Bun.file(callsPath).text()); } catch {}`,
      `calls.push(process.argv.slice(2));`,
      `await Bun.write(callsPath, JSON.stringify(calls));`,
      `const asked = await Bun.stdin.text();`,
      `const at = asked.match(/Write your reply to (.+)$/m)?.[1]?.trim();`,
      `if (at) await Bun.write(at, ${JSON.stringify(RESULT)});`,
      `const sessionIds = ["session-a", "session-b", "session-a-next"];`,
      `process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "done", session_id: sessionIds[calls.length - 1] }));`,
    ].join("\n"),
  );
  return { config: { command: process.execPath, commandArgs: [path] }, callsPath };
};

/** A report shaped like Claude Code's `--output-format json`. */
const report = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "done",
    session_id: "session-abc",
    model: "claude-sonnet-4-6",
    total_cost_usd: 0.2136,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 34159,
      cache_read_input_tokens: 512,
      output_tokens: 4,
    },
    ...over,
  });

const agent: Agent = {
  id: "a1",
  name: "线编",
  binding: { harness: "claude-code", model: "sonnet", reasoningEffort: "medium" },
};

const task: ReviewTask = {
  id: "t1",
  agentId: "a1",
  baseline: "rev0",
  prompt: "收紧这一段",
  contextScope: [],
  editScopes: [{ id: "s1", blockIds: ["b1"], text: "声音很熟。" }],
};

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Claude Code adapter", () => {
  test("stays L1 until a real session and compaction signal prove L2", () => {
    expect(new ClaudeCodeAdapter().tier).toBe("L1");
    expect(new ClaudeCodeAdapter().id).toBe("claude-code");
  });

  test("reports unknown usage before anything has run", () => {
    // Not zero. Zero is a number this application would have invented, and a
    // reader cannot tell an invented zero from a real one.
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.usage().kind).toBe("unknown");
    expect(adapter.effectiveModel().kind).toBe("unknown");
  });

  test("relays the four token counts exactly as the harness stated them", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    const usage = adapter.usage();
    expect(usage.kind).toBe("actual");
    if (usage.kind !== "actual") return;

    // Verbatim: no addition, no derivation. A total the harness never stated
    // is a number this layer made up.
    expect(usage.value.currentTurn).toEqual({
      inputOther: 2,
      output: 4,
      inputCacheRead: 512,
      inputCacheCreation: 34159,
    });
  });

  test("never surfaces the cost the harness reports", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    // SPEC 1.3: no billing math, no prices. The field is in the report and must
    // not reach anything the interface can read.
    const serialized = JSON.stringify(adapter.usage());
    expect(serialized).not.toContain("cost");
    expect(serialized).not.toContain("0.2136");
    expect(serialized).not.toContain("usd");
  });

  test("reports the model the harness actually used, not the one requested", async () => {
    // `--fallback-model` and provider routing both substitute a model. Echoing
    // the request back would be a claim this adapter cannot support.
    const adapter = new ClaudeCodeAdapter(stubClaude(report({ model: "claude-opus-4-6" })));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    const model = adapter.effectiveModel();
    expect(model).toEqual({ kind: "actual", value: "claude-opus-4-6" });
  });

  test("carries the session forward, which is what first-round persona relies on", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    expect(adapter.sessionId(agent.id)).toBe("session-abc");
  });

  test("keeps each Agent on its exclusive Session across interleaved runs", async () => {
    const agentB: Agent = { ...agent, id: "b1", name: "结构读者" };
    const { config, callsPath } = interleavedClaude();
    const adapter = new ClaudeCodeAdapter(config);
    const host = new AgentHost(root, [adapter]);
    host.register(agent).register(agentB);

    host.enqueue({ ...task, id: "t-a1", agentId: agent.id });
    const [runA1] = await host.send();
    await adapter.awaitCompletion(runA1!);

    host.enqueue({ ...task, id: "t-b1", agentId: agentB.id });
    const [runB1] = await host.send();
    await adapter.awaitCompletion(runB1!);

    host.enqueue({ ...task, id: "t-a2", agentId: agent.id });
    const [runA2] = await host.send();
    await adapter.awaitCompletion(runA2!);

    const calls = JSON.parse(readFileSync(callsPath, "utf8")) as string[][];
    expect(
      calls.map((argv) => {
        const resume = argv.indexOf("--resume");
        return resume === -1 ? undefined : argv[resume + 1];
      }),
    ).toEqual([undefined, undefined, "session-a"]);
    expect(adapter.sessionId(agent.id)).toBe("session-a-next");
    expect(adapter.sessionId(agentB.id)).toBe("session-b");
  });

  test("never labels a locally accumulated total as actual", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host
      .register(agent)
      .enqueue(task)
      .enqueue({ ...task, id: "t2" });

    const runs = await host.send();
    for (const run of runs) await adapter.awaitCompletion(run).catch(() => undefined);

    const usage = adapter.usage();
    if (usage.kind !== "actual") throw new Error("expected actual usage");

    expect(usage.value.currentTurn?.output).toBe(4);
    expect(usage.value.total).toBeUndefined();
  });

  test("attributes the harness token report to one run", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    expect(adapter.usageFor(run!.id).kind).toBe("actual");
    expect(adapter.usageFor("run-that-never-existed").kind).toBe("unknown");
    expect(adapter.turnsFor(run!.id)).toBe(1);
  });

  test("an error report fails the run and still keeps its usage", async () => {
    // A harness that errored still spent tokens. Dropping the report would
    // understate what the round cost the author.
    const adapter = new ClaudeCodeAdapter(
      stubClaude(report({ is_error: true, result: "rate limited" })),
    );
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();

    await expect(adapter.awaitCompletion(run!)).rejects.toThrow(/rate limited/);
    expect(run!.state).toBe("failed");
    expect(adapter.usage().kind).toBe("actual");
  });

  test("a non-zero exit fails the run", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude("", 4));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();

    await expect(adapter.awaitCompletion(run!)).rejects.toThrow();
    expect(run!.state).toBe("failed");
  });

  test("unparseable stdout costs the usage report, not the run", async () => {
    // A wrapper script or a warning line can put text around the JSON. The
    // Proposal is frozen from the result file, so the run survives.
    const adapter = new ClaudeCodeAdapter(stubClaude("not json at all"));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();

    await adapter.awaitCompletion(run!).catch(() => undefined);
    expect(run!.state).not.toBe("failed");
    expect(adapter.usage().kind).toBe("unknown");
  });

  test("finds the report inside surrounding noise", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(`warning: something\n${report()}\n`));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    expect(adapter.usage().kind).toBe("actual");
  });

  test("a timeout kills the harness and fails the run", async () => {
    const adapter = new ClaudeCodeAdapter({ ...stubClaude("", 0, 30_000), timeoutMs: 40 });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const started = performance.now();
    const [run] = await host.send();
    await expect(adapter.awaitCompletion(run!)).rejects.toThrow(/exceeded/);

    expect(run!.state).toBe("failed");
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("cancelling after completion cannot rewrite the terminal state", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    run!.state = "completed";
    await adapter.cancel(run!);
    expect(run!.state).toBe("completed");
  });

  test("writes a request the agent can answer without the repository", async () => {
    const adapter = new ClaudeCodeAdapter(stubClaude(report()));
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();

    expect(existsSync(run!.requestPath)).toBe(true);
    const request = readFileSync(run!.requestPath, "utf8");
    expect(request).toContain("s1");
    expect(request).toContain("声音很熟。");
    expect(request).toContain("agent-result");
    await adapter.awaitCompletion(run!).catch(() => undefined);
  });

  test("the argv denies every tool it does not name", async () => {
    // A subprocess nobody is watching must never wait on a permission prompt,
    // and this agent has no reason to run a command.
    const adapter = new ClaudeCodeAdapter();
    const argv = (adapter as unknown as { argv(agent: Agent): string[] }).argv(agent);

    expect(argv).toContain("dontAsk");
    expect(argv).toContain("Read,Write");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).not.toContain("Bash");
  });
});
