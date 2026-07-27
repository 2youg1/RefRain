import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ReviewTask } from "../src/index.ts";
import { AgentHost, CommandAdapter, DEFAULT_TIMEOUT_MS } from "../src/index.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "refrain-cmd-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const agent: Agent = {
  id: "a1",
  name: "local-cli",
  binding: { harness: "command", model: "unspecified", reasoningEffort: "unspecified" },
};

const task: ReviewTask = {
  id: "t1",
  agentId: "a1",
  baseline: "rev0",
  prompt: "改冷一点。",
  contextScope: [],
  editScopes: [{ id: "s1", blockIds: ["b1"], text: "声音很熟。" }],
};

describe("command adapter", () => {
  test("the launch template receives the request and result paths", async () => {
    // A shell that copies a canned reply into the result path stands in for a
    // real harness: what matters is that the app hands over the two paths.
    const adapter = new CommandAdapter({
      id: "command",
      template: ["sh", "-c", 'printf \'%s\' "$REPLY" > "{result}" && test -f "{request}"'],
      env: {
        REPLY:
          '# Agent reply\n\n<agent-result version="1"><replacement scope="s1"><![CDATA[剑没有松。]]></replacement></agent-result>',
      },
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    await adapter.awaitCompletion(run!);

    expect((await host.collect(run!.id))[0]).toMatchObject({ after: "剑没有松。" });
  });

  test("the host observes command completion without an adapter-specific call", async () => {
    const adapter = new CommandAdapter({
      id: "command",
      template: ["sh", "-c", 'printf \'%s\' "$REPLY" > "{result}"'],
      env: {
        REPLY:
          '# Agent reply\n\n<agent-result version="1"><replacement scope="s1"><![CDATA[剑没有松。]]></replacement></agent-result>',
      },
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    for (let attempt = 0; attempt < 100 && run?.state === "dispatched"; attempt++)
      await Bun.sleep(5);

    expect(run?.state).toBe("completed");
    expect((await host.collect(run!.id))[0]).toMatchObject({ after: "剑没有松。" });
  });

  test("a failing command marks the run failed rather than silently dropping it", async () => {
    const adapter = new CommandAdapter({ id: "command", template: ["sh", "-c", "exit 3"] });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    expect(run!.state).toBe("failed");
  });

  test("an adapter with no configured timeout still has one", () => {
    // Every construction site — `ipc.ts` has three — omits `timeoutMs`, so a
    // harness that hangs held its Run in `dispatched` forever. The author could
    // cancel it by hand, but nothing else ever would, and a Run that never
    // settles is a Run whose Proposals never arrive.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(new CommandAdapter({ id: "command", template: ["true"] }).timeoutMs).toBe(
      DEFAULT_TIMEOUT_MS,
    );
    expect(new CommandAdapter({ id: "command", template: ["true"], timeoutMs: 30 }).timeoutMs).toBe(
      30,
    );
  });

  test("a timed-out harness is killed and reaches failed", async () => {
    const adapter = new CommandAdapter({
      id: "command",
      template: ["sh", "-c", "sleep 5"],
      timeoutMs: 30,
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const started = performance.now();
    const [run] = await host.send();
    for (let attempt = 0; attempt < 100 && run?.state === "dispatched"; attempt++)
      await Bun.sleep(5);

    expect(run?.state).toBe("failed");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("cancellation resolves only after the harness has exited", async () => {
    const ready = join(root, "ready");
    const exited = join(root, "exited");
    const adapter = new CommandAdapter({
      id: "command",
      template: [
        "sh",
        "-c",
        'trap \'sleep 0.1; printf exited > "$EXITED"; exit 0\' TERM; printf ready > "$READY"; while :; do :; done',
      ],
      env: { READY: ready, EXITED: exited },
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await Bun.sleep(5);
    expect(existsSync(ready)).toBe(true);
    await adapter.cancel(run!);

    expect(run!.state).toBe("cancelled");
    expect(existsSync(exited)).toBe(true);
  });

  test("cancelling after completion cannot rewrite the terminal state", async () => {
    const adapter = new CommandAdapter({
      id: "command",
      template: ["sh", "-c", 'printf \'%s\' "$REPLY" > "{result}"'],
      env: { REPLY: '# Agent reply\n\n<agent-result version="1"><memo>done</memo></agent-result>' },
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);
    const [run] = await host.send();
    for (let attempt = 0; attempt < 100 && run?.state === "dispatched"; attempt++)
      await Bun.sleep(5);

    expect(run?.state).toBe("completed");
    await adapter.cancel(run!);
    expect(run?.state).toBe("completed");
  });

  test("a command that cannot launch returns its task to the pending queue", async () => {
    const adapter = new CommandAdapter({
      id: "command",
      template: ["refrain-command-does-not-exist"],
    });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    expect(host.send()).rejects.toThrow();
    expect(host.pending().map((entry) => entry.id)).toEqual(["t1"]);
    expect(host.runs()).toEqual([]);
  });

  test("a harness that reports no usage says unknown", () => {
    const adapter = new CommandAdapter({ id: "command", template: ["true"] });

    expect(adapter.usage()).toEqual({ kind: "unknown" });
    expect(adapter.tier).toBe("L1");
  });
});
