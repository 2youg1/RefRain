import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ReviewTask } from "../src/index.ts";
import { AgentHost, FileChannelAdapter, sendManifest } from "../src/index.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-agent-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1",
  name: "kimi",
  binding: { harness: "file", model: "unspecified", reasoningEffort: "unspecified" },
  ...over,
});

const task = (over: Partial<ReviewTask> = {}): ReviewTask => ({
  id: "t1",
  agentId: "a1",
  baseline: "rev0",
  prompt: "把这段改得更冷。",
  contextScope: [],
  editScopes: [{ id: "s1", blockIds: ["b1"], text: "声音很熟。" }],
  ...over,
});

describe("Agent Host queue", () => {
  test("a task waits in the queue until the author sends it", () => {
    const host = new AgentHost(root);
    host.register(agent());
    host.enqueue(task());

    expect(host.pending()).toHaveLength(1);
    expect(host.runs()).toHaveLength(0);
  });

  test("a restarted host never reuses an existing Run id or workspace", async () => {
    const first = new AgentHost(root);
    first.register(agent()).enqueue(task());
    const [run1] = await first.send();
    writeFileSync(run1!.requestPath, "old request", "utf8");

    const restarted = new AgentHost(root);
    restarted.register(agent()).enqueue(task({ id: "t2" }));
    const [run2] = await restarted.send();

    expect(run2?.id).toBe("run2");
    expect(await Bun.file(run1!.requestPath).text()).toBe("old request");
    expect(run2?.workspace).not.toBe(run1?.workspace);
  });

  test("a dispatch preflight failure preserves the whole queue and starts nothing", async () => {
    const host = new AgentHost(root);
    host.register(agent());
    host.enqueue(task());
    host.enqueue(task({ id: "t2", agentId: "missing" }));

    expect(host.send()).rejects.toThrow(/no agent registered/);
    expect(host.pending().map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(host.runs()).toEqual([]);
  });

  test("the send manifest states run count, binding, scopes, and prompt", () => {
    const host = new AgentHost(root);
    host.register(agent());
    host.enqueue(task());
    host.enqueue(task({ id: "t2" }));

    const manifest = sendManifest(host);

    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ agentName: "kimi", runCount: 2, harness: "file" });
    expect(manifest[0]?.scopes).toEqual(["s1", "s1"]);
  });

  test("the manifest never carries a price or a cost estimate", () => {
    const host = new AgentHost(root);
    host.register(agent());
    host.enqueue(task());

    const serialized = JSON.stringify(sendManifest(host));

    expect(serialized).not.toMatch(/price|cost|usd|dollar|\$/i);
  });

  test("a scope whose text changed while queued is flagged drifted, not cancelled", () => {
    const host = new AgentHost(root);
    host.register(agent());
    host.enqueue(task());
    host.noteManuscriptChange("b1", "声音很熟。作者改过了。");

    expect(sendManifest(host)[0]?.drifted).toEqual(["s1"]);
    expect(host.pending()).toHaveLength(1);
  });

  test("queue, runs, frozen Proposals, and comments survive a restart", async () => {
    const first = new AgentHost(root);
    first.register(agent()).enqueue(task());
    const [run] = await first.send();
    writeFileSync(
      run!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><replacement scope="s1">剑没有松。</replacement><comments><comment target="s1">保留冷意。</comment></comments></agent-result>',
    );
    const frozen = await first.collect(run!.id);
    first.enqueue(task({ id: "t2" }));

    const restarted = new AgentHost(root);

    expect(restarted.pending().map((entry) => entry.id)).toEqual(["t2"]);
    expect(restarted.runs()).toEqual([expect.objectContaining({ id: "run1", state: "completed" })]);
    expect(await restarted.collect("run1")).toEqual(frozen);
    expect(restarted.commentsFor("run1")).toEqual([
      expect.objectContaining({ target: "s1", text: "保留冷意。" }),
    ]);
  });

  test("invalid task and run records are reported without emptying valid HostState", () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(
        join(root, "host.json"),
        JSON.stringify({
          version: 1,
          sequence: 5,
          queue: [
            task({ id: "t2" }),
            { ...task({ id: "bad-task" }), prompt: 42 },
            task({ id: "t3" }),
          ],
          runs: [
            {
              id: "run4",
              state: "completed",
              task: task({ id: "sent-1" }),
              comments: [],
              proposals: [],
            },
            { id: "bad-run", state: "completed" },
            {
              id: "run5",
              state: "failed",
              task: task({ id: "sent-2" }),
              failure: "kept failure",
              comments: [],
              proposals: [],
            },
          ],
          drifted: [],
        }),
        "utf8",
      );

      const restarted = new AgentHost(root);

      expect(restarted.pending().map((entry) => entry.id)).toEqual(["t2", "t3"]);
      expect(restarted.runs().map((entry) => entry.id)).toEqual(["run4", "run5"]);
      expect(restarted.failureFor("run5")).toBe("kept failure");
      expect(warnings).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveBeenNthCalledWith(1, expect.stringContaining("queue[1]"));
      expect(warnings).toHaveBeenNthCalledWith(2, expect.stringContaining("runs[1]"));
    } finally {
      warnings.mockRestore();
    }
  });
});

describe("Run completion lifecycle", () => {
  test("the author can cancel an active Run and the terminal state survives restart", async () => {
    const host = new AgentHost(root);
    host.register(agent()).enqueue(task());
    const [run] = await host.send();

    expect(await host.cancel(run!.id)).toBe(true);
    expect(run!.state).toBe("cancelled");
    expect(await host.cancel(run!.id)).toBe(false);

    const restarted = new AgentHost(root);
    expect(restarted.runs()[0]).toMatchObject({ id: run!.id, state: "cancelled" });
    expect(await restarted.cancel(run!.id)).toBe(false);
  });

  test("collect refuses a visible partial result until its producer finishes", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adapter = new (class {
      readonly id = "controlled";
      readonly tier = "L1" as const;
      async dispatch(run: { workspace: string; resultPath: string }): Promise<void> {
        mkdirSync(run.workspace, { recursive: true });
        writeFileSync(run.resultPath, '# Agent reply\n\n<agent-result version="1"><replacement');
      }
      awaitCompletion(): Promise<void> {
        return finished;
      }
      async cancel(): Promise<void> {
        // Nothing to stop; the test controls completion directly.
      }
      usage() {
        return { kind: "unknown" } as const;
      }
      effectiveModel() {
        return { kind: "unknown" } as const;
      }
    })();
    const host = new AgentHost(root, [adapter]);
    host.register(
      agent({
        binding: { harness: "controlled", model: "unspecified", reasoningEffort: "unspecified" },
      }),
    );
    host.enqueue(task());
    const [run] = await host.send();

    await expect(host.collect(run!.id)).rejects.toThrow(/still running/);
    expect(run!.state).toBe("dispatched");
    expect(host.failureFor(run!.id)).toBeUndefined();

    writeFileSync(
      run!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><replacement scope="s1">剑没有松。</replacement></agent-result>',
    );
    finish();
    await host.settled(run!.id);

    expect(run!.state).toBe("completed");
    expect((await host.collect(run!.id))[0]).toMatchObject({ after: "剑没有松。" });
  });

  test("a restarted dispatched Run stays recoverable and visibly requires attention", async () => {
    const first = new AgentHost(root);
    first.register(agent()).enqueue(task());
    const [run] = await first.send();

    const restarted = new AgentHost(root);
    const recovered = restarted.runs()[0];

    expect(recovered).toMatchObject({ id: run!.id, state: "dispatched" });
    expect(restarted.failureFor(run!.id)).toMatch(/restarted.*manual/i);

    writeFileSync(recovered!.resultPath, '# Agent reply\n\n<agent-result version="1"><replacement');
    await expect(restarted.collect(run!.id)).rejects.toThrow(/missing-root/);
    expect(recovered!.state).toBe("dispatched");
    expect(restarted.failureFor(run!.id)).toMatch(/Last collection attempt: missing-root/);

    writeFileSync(
      recovered!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><replacement scope="invented">错误范围。</replacement></agent-result>',
    );
    await expect(restarted.collect(run!.id)).rejects.toThrow(/unknown scope invented/);
    expect(recovered!.state).toBe("dispatched");
    expect(restarted.failureFor(run!.id)).toMatch(
      /Last collection attempt: unknown scope invented/,
    );

    writeFileSync(
      recovered!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><replacement scope="s1">重启后收回。</replacement></agent-result>',
    );
    expect((await restarted.collect(run!.id))[0]).toMatchObject({ after: "重启后收回。" });
    expect(recovered!.state).toBe("completed");
    expect(restarted.failureFor(run!.id)).toBeUndefined();

    const completed = new AgentHost(root);
    expect(completed.runs()[0]).toMatchObject({ id: run!.id, state: "completed" });
    expect(completed.failureFor(run!.id)).toBeUndefined();
  });
});

describe("L0 file channel", () => {
  test("dispatching writes a Result Artifact scaffold the agent completes", async () => {
    const adapter = new FileChannelAdapter(root);
    const host = new AgentHost(root, [adapter]);
    host.register(agent());
    host.enqueue(task());

    const [run] = await host.send();

    const scaffold = await Bun.file(run!.requestPath).text();
    expect(scaffold).toContain("# Before");
    expect(scaffold).toContain("声音很熟。");
    expect(scaffold).toContain("# Request");
    expect(scaffold).toContain("把这段改得更冷。");
    expect(scaffold).toContain("# Agent reply");
  });

  test("a completed artifact freezes into an immutable Proposal", async () => {
    const adapter = new FileChannelAdapter(root);
    const host = new AgentHost(root, [adapter]);
    host.register(agent());
    host.enqueue(task());
    const [run] = await host.send();

    writeFileSync(
      run!.resultPath,
      `# Agent reply\n\n<agent-result version="1"><replacement scope="s1"><![CDATA[剑没有松。]]></replacement></agent-result>`,
    );

    const proposals = await host.collect(run!.id);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      before: "声音很熟。",
      after: "剑没有松。",
      runId: run!.id,
    });
  });

  test("a comment-only result produces no Proposal", async () => {
    const adapter = new FileChannelAdapter(root);
    const host = new AgentHost(root, [adapter]);
    host.register(agent());
    host.enqueue(task());
    const [run] = await host.send();

    writeFileSync(
      run!.resultPath,
      `# Agent reply\n\n<agent-result version="1"><comments><comment target="s1"><![CDATA[节奏偏慢。]]></comment></comments></agent-result>`,
    );

    expect(await host.collect(run!.id)).toHaveLength(0);
    expect(host.commentsFor(run!.id)).toHaveLength(1);
  });

  test("a replacement for an invented scope fails instead of disappearing", async () => {
    const host = new AgentHost(root, [new FileChannelAdapter(root)]);
    host.register(agent()).enqueue(task());
    const [run] = await host.send();

    writeFileSync(
      run!.resultPath,
      `# Agent reply\n\n<agent-result version="1"><replacement scope="invented">甲</replacement></agent-result>`,
    );

    expect(host.collect(run!.id)).rejects.toThrow(/unknown scope invented/);
    expect(run!.state).toBe("failed");
  });

  test("an invented comment target is discarded without destroying a valid Proposal", async () => {
    const host = new AgentHost(root, [new FileChannelAdapter(root)]);
    host.register(agent()).enqueue(task());
    const [run] = await host.send();

    writeFileSync(
      run!.resultPath,
      `# Agent reply\n\n<agent-result version="1"><replacement scope="s1">乙</replacement><comments><comment target="invented">不属于任何边界</comment></comments></agent-result>`,
    );

    expect(await host.collect(run!.id)).toHaveLength(1);
    expect(host.commentsFor(run!.id)).toEqual([]);
    expect(run!.state).toBe("completed");
  });

  test("invalid UTF-8 is rejected before a Proposal can freeze", async () => {
    const host = new AgentHost(root);
    host.register(agent()).enqueue(task());
    const [run] = await host.send();
    const prefix = Buffer.from(
      '# Agent reply\n\n<agent-result version="1"><replacement scope="s1">',
      "utf8",
    );
    const suffix = Buffer.from("</replacement></agent-result>", "utf8");
    writeFileSync(run!.resultPath, Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]));

    expect(host.collect(run!.id)).rejects.toThrow(/invalid UTF-8/);
    expect(run!.state).toBe("failed");
  });

  test("an invalid artifact is refused and kept for diagnosis", async () => {
    const adapter = new FileChannelAdapter(root);
    const host = new AgentHost(root, [adapter]);
    host.register(agent());
    host.enqueue(task());
    const [run] = await host.send();

    writeFileSync(run!.resultPath, `# Agent reply\n\n<!DOCTYPE x><agent-result version="1"/>`);

    expect(host.collect(run!.id)).rejects.toThrow(/dtd-forbidden/);
    expect(host.runs()[0]?.state).not.toBe("completed");
  });

  test("L0 cancellation cannot rewrite a completed Run", async () => {
    const adapter = new FileChannelAdapter(root);
    const host = new AgentHost(root, [adapter]);
    host.register(agent()).enqueue(task());
    const [run] = await host.send();
    writeFileSync(
      run!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><memo>done</memo></agent-result>',
    );
    await host.collect(run!.id);

    await adapter.cancel(run!);

    expect(run!.state).toBe("completed");
  });

  /**
   * A harness can exit 0 without writing anything — a wrapper that swallowed an
   * error, a command whose flags were wrong, a model that replied in chat and
   * never touched the file. The Host recorded why it could not collect but left
   * the run in `dispatched`, so it sat in flight forever: never finished, never
   * failed, nothing for the author to press.
   */
  test("a harness that exits cleanly without a result fails the run, not hangs it", async () => {
    const adapter = new (class {
      readonly id = "silent";
      readonly tier = "L1" as const;
      async dispatch(): Promise<void> {
        // Writes no result, which is the whole point.
      }
      async awaitCompletion(): Promise<void> {
        // Exits cleanly.
      }
      async cancel(): Promise<void> {
        // Nothing to stop; the contract still requires the method.
      }
      usage() {
        return { kind: "unknown" } as const;
      }
      effectiveModel() {
        return { kind: "unknown" } as const;
      }
    })();

    const host = new AgentHost(root, [adapter]);
    host.register({
      id: "a1",
      name: "silent",
      binding: { harness: "silent", model: "m", reasoningEffort: "e" },
    });
    host.enqueue({ ...task(), agentId: "a1" });

    const [run] = await host.send();
    await host.settled(run!.id);

    expect(run!.state).toBe("failed");
    // And the reason is kept, so the interface can say what went wrong.
    const failure = host.failureFor(run!.id);
    expect(failure).toContain("no result");

    mkdirSync(run!.workspace, { recursive: true });
    writeFileSync(
      run!.resultPath,
      '# Agent reply\n\n<agent-result version="1"><replacement scope="s1">迟到的正文。</replacement></agent-result>',
    );
    await expect(host.collect(run!.id)).rejects.toThrow(/already failed/);
    expect(run!.state).toBe("failed");
    expect(host.failureFor(run!.id)).toBe(failure);

    const restarted = new AgentHost(root);
    expect(restarted.runs()).toEqual([expect.objectContaining({ id: run!.id, state: "failed" })]);
    expect(restarted.failureFor(run!.id)).toContain("no result");
  });

  test("token usage from a harness that reports nothing is unknown, never zero", async () => {
    const adapter = new FileChannelAdapter(root);

    expect(adapter.usage()).toEqual({ kind: "unknown" });
    expect(adapter.tier).toBe("L0");
  });
});
