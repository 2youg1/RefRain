import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = (() => {
  const table = new Map<string, Handler>();
  registerHandlers(
    { handle: (channel: string, handler: Handler) => table.set(channel, handler) } as never,
    {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    } as never,
  );
  return table;
})();

const call = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return await handler({}, ...args);
};

const task = (id: string, agentId: string) => ({
  id,
  agentId,
  baseline: "01.md@current",
  prompt: "改写这一段。",
  contextScope: [],
  editScopes: [{ id: "s1", blockIds: ["01.md:b0"], text: "原文。" }],
});

const waitForRuns = async (root: string, count: number) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const runs = (await call("agent:runs", root)) as { id: string; state: string }[];
    if (runs.length === count && runs.every((run) => run.state !== "dispatched")) return runs;
    await Bun.sleep(20);
  }
  throw new Error("runs did not settle");
};

test("same-name command agents keep distinct argv and still run after a restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-agent-ipc-"));
  const script = join(root, "worker with spaces.mjs");
  writeFileSync(
    script,
    [
      'import { writeFileSync } from "node:fs";',
      "const [, , request, result, answer] = process.argv;",
      "if (!request || !result || !answer) throw new Error('missing argv');",
      "writeFileSync(result, '<agent-result version=\"1\"><replacement scope=\"s1\">' + answer + '</replacement></agent-result>');",
    ].join("\n"),
    "utf8",
  );

  try {
    const first = (await call(
      "agent:add",
      root,
      "审稿人",
      `"${process.execPath}" "${script}" "{request}" "{result}" "第一位的改写。"`,
    )) as { id: string; binding: { harness: string } };
    const second = (await call(
      "agent:add",
      root,
      "审稿人",
      `"${process.execPath}" "${script}" "{request}" "{result}" "第二位的改写。"`,
    )) as { id: string; binding: { harness: string } };

    expect(first.binding.harness).not.toBe(second.binding.harness);
    closeWorkbenches();

    await call("agent:enqueue", root, task("t1", first.id));
    await call("agent:enqueue", root, task("t2", second.id));
    await call("agent:send", root);

    const runs = await waitForRuns(root, 2);
    expect(runs.map((run) => run.state)).toEqual(["completed", "completed"]);
    const collected = await Promise.all(
      runs.map(
        (run) => call("agent:collect", root, run.id) as Promise<{ proposals: { after: string }[] }>,
      ),
    );
    expect(collected.map((result) => result.proposals[0]?.after)).toEqual([
      "第一位的改写。",
      "第二位的改写。",
    ]);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed command line is refused before the roster changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-agent-command-"));
  try {
    await expect(call("agent:add", root, "broken", '"unterminated')).rejects.toThrow(
      /unterminated/i,
    );
    expect(await call("agent:list", root)).toEqual([]);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a roster write failure changes neither memory nor the canonical file", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-agent-transaction-"));
  const stateDir = join(root, ".refrain");
  try {
    const kept = (await call("agent:add", root, "kept", "")) as { id: string };
    const before = readFileSync(join(stateDir, "agents.json"), "utf8");
    mkdirSync(join(stateDir, "agents.json.writing"));

    await expect(call("agent:add", root, "not saved", "")).rejects.toThrow();
    expect((await call("agent:list", root)) as { id: string }[]).toEqual([
      expect.objectContaining({ id: kept.id }),
    ]);
    expect(readFileSync(join(stateDir, "agents.json"), "utf8")).toBe(before);

    await expect(call("agent:remove", root, kept.id)).rejects.toThrow();
    expect((await call("agent:list", root)) as { id: string }[]).toEqual([
      expect.objectContaining({ id: kept.id }),
    ]);
    expect(readFileSync(join(stateDir, "agents.json"), "utf8")).toBe(before);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

const preparedDecision = async (root: string) => {
  const path = join(root, "01.md");
  writeFileSync(path, "原文。\n", "utf8");
  await call("project:load", root);
  const agent = (await call("agent:add", root, "file", "")) as { id: string };
  await call("agent:enqueue", root, task("decision", agent.id));
  const [run] = (await call("agent:send", root)) as { id: string; resultPath: string }[];
  if (!run) throw new Error("no run");
  writeFileSync(
    run.resultPath,
    '<agent-result version="1"><replacement scope="s1">新的正文。</replacement></agent-result>',
    "utf8",
  );
  const collected = (await call("agent:collect", root, run.id)) as {
    proposals: {
      id: string;
      baseline: string;
      slices: { id: string; kind: string }[];
    }[];
  };
  const proposal = collected.proposals[0];
  if (!proposal) throw new Error("no proposal");
  return {
    path,
    payload: {
      chapter: "01.md",
      verdicts: proposal.slices
        .filter((slice) => slice.kind !== "same")
        .map((slice, index) => ({
          id: `v${index}`,
          proposalId: proposal.id,
          sliceId: slice.id,
          kind: "accept",
          baseline: proposal.baseline,
          decidedAt: "2026-07-27T00:00:00.000Z",
        })),
    },
  };
};

test("a rejected manuscript write records no Verdict and can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-decision-write-"));
  try {
    const { path, payload } = await preparedDecision(root);
    mkdirSync(`${path}.writing`);

    await expect(call("review:commit", root, payload)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("原文。\n");
    expect(await call("ledger:all", root)).toEqual([]);

    rmSync(`${path}.writing`, { recursive: true });
    expect(await call("review:commit", root, payload)).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("新的正文。\n");
    expect((await call("ledger:all", root)) as unknown[]).toHaveLength(payload.verdicts.length);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Decision Batch cannot overwrite an external edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-decision-conflict-"));
  try {
    const { path, payload } = await preparedDecision(root);
    writeFileSync(path, "另一个编辑器的新正文。\n", "utf8");

    expect(await call("review:commit", root, payload)).toMatchObject({
      ok: false,
      reason: "changed-underneath",
    });
    expect(readFileSync(path, "utf8")).toBe("另一个编辑器的新正文。\n");
    expect(await call("ledger:all", root)).toEqual([]);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});
