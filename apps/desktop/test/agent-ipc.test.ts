import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";
import { RootAuthority } from "../src/main/root-authority.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const rootAuthority = new RootAuthority();
const handlers = (() => {
  const table = new Map<string, Handler>();
  registerHandlers(
    { handle: (channel: string, handler: Handler) => table.set(channel, handler) } as never,
    {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    } as never,
    rootAuthority,
  );
  return table;
})();

const mainFrame = { isDestroyed: () => false };
const event = {
  sender: { isDestroyed: () => false, mainFrame },
  senderFrame: mainFrame,
};
const adopted = new Set<string>();

const invoke = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return await handler(event, ...args);
};

/** The real renderer adopts its saved roots before it opens collaboration. */
const call = async (channel: string, ...args: unknown[]) => {
  if (channel === "project:load-workspace" && Array.isArray(args[0]))
    for (const path of args[0]) if (typeof path === "string") rootAuthority.approve(path);
  const root = args[0];
  if (
    channel !== "project:load-workspace" &&
    channel !== "project:resolve-drop" &&
    typeof root === "string" &&
    isAbsolute(root) &&
    !adopted.has(normalize(root))
  ) {
    rootAuthority.approve(root);
    await invoke("project:load-workspace", [root]);
    adopted.add(normalize(root));
  }
  return invoke(channel, ...args);
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
      "model-one",
      "high",
    )) as {
      id: string;
      binding: { harness: string; model: string; reasoningEffort: string };
    };
    const second = (await call(
      "agent:add",
      root,
      "审稿人",
      `"${process.execPath}" "${script}" "{request}" "{result}" "第二位的改写。"`,
      "model-two",
      "low",
    )) as {
      id: string;
      binding: { harness: string; model: string; reasoningEffort: string };
    };

    expect(first.binding.harness).not.toBe(second.binding.harness);
    closeWorkbenches();

    const restored = (await call("agent:list", root)) as {
      id: string;
      binding: { model: string; reasoningEffort: string };
    }[];
    expect(
      restored.map((agent) => ({
        model: agent.binding.model,
        reasoningEffort: agent.binding.reasoningEffort,
      })),
    ).toEqual([
      { model: "model-one", reasoningEffort: "high" },
      { model: "model-two", reasoningEffort: "low" },
    ]);

    await call("agent:trust", root, first.id);
    await call("agent:trust", root, second.id);
    await call("agent:enqueue", root, task("t1", first.id));
    await call("agent:enqueue", root, task("t2", second.id));
    const manifest = (await call("agent:manifest", root)) as { harness: string }[];
    expect(manifest.map((entry) => JSON.parse(entry.harness) as string[])).toEqual([
      [process.execPath, script, "{request}", "{result}", "第一位的改写。"],
      [process.execPath, script, "{request}", "{result}", "第二位的改写。"],
    ]);
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

test("an active Run can be cancelled through the public IPC channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-agent-cancel-"));
  try {
    const added = (await call("agent:add", root, "manual", "", "unknown", "unknown")) as {
      id: string;
    };
    await call("agent:enqueue", root, task("cancel-me", added.id));
    const [run] = (await call("agent:send", root)) as { id: string }[];

    expect(await call("agent:cancel", root, run!.id)).toBe(true);
    expect(await call("agent:cancel", root, run!.id)).toBe(false);
    expect(await call("agent:runs", root)).toEqual([
      expect.objectContaining({ id: run!.id, state: "cancelled" }),
    ]);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single-file Root keeps collaboration state and its original in one companion", async () => {
  const parent = mkdtempSync(join(tmpdir(), "refrain-file-root-"));
  const root = join(parent, "essay.md");
  writeFileSync(root, "原稿。\n", "utf8");
  try {
    const workspace = (await call("project:load-workspace", [root])) as {
      roots: { kind: string }[];
      chapters: { id: string }[];
    };
    expect(workspace.roots).toEqual([expect.objectContaining({ kind: "file" })]);
    expect(workspace.chapters.map((chapter) => chapter.id)).toEqual(["essay.md"]);

    await call("agent:add", root, "manual", "", "unknown", "unknown");
    const companion = join(parent, ".essay.md.refrain");
    expect(
      JSON.parse(readFileSync(join(companion, ".refrain", "agents.json"), "utf8")),
    ).toHaveLength(1);
    expect(readFileSync(join(companion, ".refrain-source", "essay.md"), "utf8")).toBe("原稿。\n");

    expect(await call("project:save", root, "essay.md", "改过的正文。")).toMatchObject({
      ok: true,
    });
    expect(readFileSync(root, "utf8")).toBe("改过的正文。\n");
    expect(readFileSync(join(companion, ".refrain-source", "essay.md"), "utf8")).toBe("原稿。\n");
  } finally {
    closeWorkbenches();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a refused Source Backup warns but does not take away an editable folder Root", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-backup-refusal-"));
  const chapter = join(root, "01.md");
  writeFileSync(chapter, "原稿。\n", "utf8");
  writeFileSync(join(root, ".refrain-source"), "这个名字已被文件占用。\n", "utf8");
  try {
    const workspace = (await call("project:load-workspace", [root])) as {
      warnings?: string[];
    };
    expect(workspace.warnings?.join("\n")).toContain("无法写入原件副本");

    expect(await call("project:save", root, "01.md", "仍然可以写。")).toMatchObject({ ok: true });
    expect(readFileSync(chapter, "utf8")).toBe("仍然可以写。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed command line is refused before the roster changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-agent-command-"));
  try {
    await expect(
      call("agent:add", root, "broken", '"unterminated', "model", "default"),
    ).rejects.toThrow(/unterminated/i);
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
    const kept = (await call("agent:add", root, "kept", "", "unknown", "unknown")) as {
      id: string;
    };
    const before = readFileSync(join(stateDir, "agents.json"), "utf8");
    mkdirSync(join(stateDir, "agents.json.writing"));

    await expect(call("agent:add", root, "not saved", "", "unknown", "unknown")).rejects.toThrow();
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
  const agent = (await call("agent:add", root, "file", "", "unknown", "unknown")) as {
    id: string;
  };
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
    expect(await call("ledger:all", root)).toEqual({ ok: true, verdicts: [] });

    rmSync(`${path}.writing`, { recursive: true });
    expect(await call("review:commit", root, payload)).toMatchObject({ ok: true });
    expect(readFileSync(path, "utf8")).toBe("新的正文。\n");
    expect(((await call("ledger:all", root)) as { verdicts: unknown[] }).verdicts).toHaveLength(
      payload.verdicts.length,
    );
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
    expect(await call("ledger:all", root)).toEqual({ ok: true, verdicts: [] });
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * A ledger that will not open is a lost capability, not a lost project.
 *
 * Opening a project used to require opening SQLite first, and the constructor
 * throws for two ordinary conditions: a state directory that cannot be written,
 * and a `verdicts.db` left truncated by an earlier crash or duplicated by a
 * syncing client. Nineteen of twenty-seven channels pass through that function
 * and neither side caught the exception, so a damaged database turned opening,
 * saving and judging into clicks that produced nothing at all.
 */
test("a corrupt ledger does not stop the project from opening", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ledger-corrupt-"));
  try {
    mkdirSync(join(root, ".refrain"), { recursive: true });
    writeFileSync(join(root, ".refrain", "verdicts.db"), "这不是一个数据库。\n", "utf8");
    writeFileSync(join(root, "01.md"), "原文。\n", "utf8");

    const workspace = (await call("project:load-workspace", [root])) as {
      chapters: { id: string }[];
    };
    expect(workspace.chapters.map((chapter) => chapter.id)).toEqual(["01.md"]);

    const saved = await call("project:save", root, "01.md", "改过的正文。");
    expect(saved).toMatchObject({ ok: true });
    expect(readFileSync(join(root, "01.md"), "utf8")).toBe("改过的正文。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable ledger says so rather than reading as empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ledger-says-"));
  try {
    mkdirSync(join(root, ".refrain"), { recursive: true });
    writeFileSync(join(root, ".refrain", "verdicts.db"), "坏掉的文件\n", "utf8");
    writeFileSync(join(root, "01.md"), "原文。\n", "utf8");

    const answer = (await call("ledger:all", root)) as { ok: boolean; detail?: string };
    expect(answer.ok).toBe(false);
    expect(answer.detail ?? "").not.toBe("");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * `agents.json` arrives with the project. Registering its command adapter on
 * restore meant a probe — which runs the binary — was one screen away from
 * anyone who opened a folder someone else had prepared.
 */
test("a command restored from the project file cannot run until it is trusted", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-trust-"));
  try {
    mkdirSync(join(root, ".refrain"), { recursive: true });
    writeFileSync(
      join(root, ".refrain", "agents.json"),
      JSON.stringify([
        {
          id: "a1",
          name: "别人的",
          harness: "command:a1",
          model: "unknown",
          reasoningEffort: "unknown",
          template: ["refrain-not-a-real-binary", "--version"],
          // An untrusted project cannot grant itself permission by writing this.
          trusted: true,
        },
      ]),
      "utf8",
    );

    const listed = (await call("agent:list", root)) as {
      id: string;
      trusted: boolean;
      command: string;
    }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.trusted).toBe(false);
    expect(JSON.parse(listed[0]?.command ?? "[]")).toEqual([
      "refrain-not-a-real-binary",
      "--version",
    ]);

    expect(await call("agent:probe", root, "a1")).toMatchObject({
      ok: false,
      reason: "untrusted",
    });

    expect(await call("agent:trust", root, "a1")).toBe(true);
    expect(((await call("agent:list", root)) as { trusted: boolean }[])[0]?.trusted).toBe(true);

    // Consent does not survive a reopen: persisting it in this same untrusted
    // project file would let the project authorize its own command.
    closeWorkbenches();
    expect(((await call("agent:list", root)) as { trusted: boolean }[])[0]?.trusted).toBe(false);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});
