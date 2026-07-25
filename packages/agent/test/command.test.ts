import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, ReviewTask } from "../src/index.ts";
import { AgentHost, CommandAdapter } from "../src/index.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "recension-cmd-"));
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
      // biome-ignore lint/suspicious/noTemplateCurlyInString: adapter placeholders
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

  test("a failing command marks the run failed rather than silently dropping it", async () => {
    const adapter = new CommandAdapter({ id: "command", template: ["sh", "-c", "exit 3"] });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    await adapter.awaitCompletion(run!).catch(() => undefined);

    expect(run!.state).toBe("failed");
  });

  test("cancellation reaches a terminal state", async () => {
    const adapter = new CommandAdapter({ id: "command", template: ["sh", "-c", "sleep 30"] });
    const host = new AgentHost(root, [adapter]);
    host.register(agent).enqueue(task);

    const [run] = await host.send();
    await adapter.cancel(run!);

    expect(run!.state).toBe("cancelled");
  });

  test("a harness that reports no usage says unknown", () => {
    const adapter = new CommandAdapter({ id: "command", template: ["true"] });

    expect(adapter.usage()).toEqual({ kind: "unknown" });
    expect(adapter.tier).toBe("L1");
  });
});
