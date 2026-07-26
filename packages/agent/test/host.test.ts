import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("token usage from a harness that reports nothing is unknown, never zero", async () => {
    const adapter = new FileChannelAdapter(root);

    expect(adapter.usage()).toEqual({ kind: "unknown" });
    expect(adapter.tier).toBe("L0");
  });
});
