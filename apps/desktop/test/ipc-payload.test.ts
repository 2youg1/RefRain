import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  IPC_CHANNELS,
  type IpcArgs,
  type IpcChannel,
  parseIpcArgs,
} from "../src/main/ipc-payload.ts";

const root = resolve(".ipc-payload-root");
const inside = join(root, "chapter.md");
const edit = {
  id: "e1",
  kind: "replace" as const,
  blockId: "b1",
  before: "before",
  after: "after",
  at: "2026-07-27T00:00:00.000Z",
};
const task = {
  id: "task-1",
  agentId: "agent-1",
  baseline: "revision-1",
  prompt: "Read this.",
  contextScope: ["chapter.md"],
  editScopes: [{ id: "scope-1", blockIds: ["b1"], text: "before" }],
};
const verdict = {
  id: "verdict-1",
  proposalId: "proposal-1",
  sliceId: "proposal-1.s0",
  kind: "accept-modified" as const,
  finalText: "final",
  reason: "author chose it",
  baseline: "revision-1",
  decidedAt: "2026-07-27T00:00:00.000Z",
};

const valid: { [C in IpcChannel]: IpcArgs<C> } = {
  "project:open": [],
  "project:open-file": [],
  "project:create": [],
  "project:resolve-drop": [inside],
  "project:load-workspace": [[root]],
  "project:load": [root],
  "project:save": [root, "chapter.md", "text"],
  "project:resolve-conflict": [root, "chapter.md", "mine"],
  "edits:revert": [root, "chapter.md", edit],
  "edits:revert-all": [root, "chapter.md", [edit]],
  "edits:describe": [[edit]],
  "fonts:list": [],
  "shell:open-project-url": ["https://github.com/kaile9/RefRain"],
  "agent:list": [root],
  "agent:trust": [root, "agent-1"],
  "agent:probe": [root, "agent-1"],
  "agent:remove": [root, "agent-1"],
  "agent:add": [root, "Reader", "reader --stdio", "gpt-5", "high"],
  "agent:enqueue": [root, task],
  "agent:manifest": [root],
  "agent:send": [root],
  "agent:cancel": [root, "run-1"],
  "agent:runs": [root],
  "agent:collect": [root, "run-1"],
  "review:commit": [root, { chapter: "chapter.md", verdicts: [verdict] }],
  "ledger:all": [root],
  "ledger:reply": [root, "proposal-1"],
  "ledger:search": [root, "reason"],
  "ledger:note": [root, { text: "查一下会议记录的日期", chapterId: "03.md", blockId: "03.md:b7" }],
  "ledger:notes": [root],
  "ledger:drop-note": [root, "note-1"],
  "files:scan": [root, { followSymlinks: false, maxDepth: 8, manuscriptsOnly: true }],
  "files:page": [root, 0, 50],
  "files:search": [root, "chapter", 50],
  "files:search-directories": [root, "notes", 50],
  "files:sort": [root, "name", false],
  "files:move": [root, inside, join(root, "moved.md"), false],
  "files:copy": [root, inside, join(root, "copy.md"), false],
  "files:trash": [root, [inside]],
  "files:trash-via-home": [root, inside],
  "files:link": [root, inside, join(root, "linked.md")],
  "files:create-directory": [root, join(root, "notes")],
  "files:admits": [root, inside],
  "window:fullscreen": [true],
  "display:profile": [],
};

test("every invoke channel parses one complete wire tuple and rejects surplus values", () => {
  expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length);
  expect(new Set(IPC_CHANNELS)).toEqual(new Set(Object.keys(valid)));

  for (const channel of IPC_CHANNELS) {
    const args: unknown[] = [...valid[channel]];
    expect(() => parseIpcArgs(channel, args), channel).not.toThrow();
    expect(() => parseIpcArgs(channel, [...args, "surplus"]), channel).toThrow(/argument/i);
  }
});

test("domain payloads reject unknown fields and missing conditional text", () => {
  expect(() => parseIpcArgs("files:scan", [root, { maxDepth: 2, invented: true }])).toThrow(
    /invented/,
  );
  expect(() =>
    parseIpcArgs("review:commit", [
      root,
      {
        chapter: "chapter.md",
        verdicts: [{ ...verdict, finalText: undefined }],
      },
    ]),
  ).toThrow(/finalText/);
  expect(() => parseIpcArgs("edits:revert", [root, "chapter.md", { ...edit, after: 7 }])).toThrow(
    /after/,
  );
  expect(() => parseIpcArgs("project:save", [root, "../outside.md", "text"])).toThrow(/Root/i);
  expect(() => parseIpcArgs("files:admits", [root, join(root, "..", "outside.md")])).toThrow(
    /Root/i,
  );
});

test("Review Tasks reject ambiguous or empty identities at the IPC boundary", () => {
  expect(() =>
    parseIpcArgs("agent:enqueue", [root, { ...task, contextScope: ["chapter.md", "chapter.md"] }]),
  ).toThrow(/unique/);
  expect(() =>
    parseIpcArgs("agent:enqueue", [
      root,
      {
        ...task,
        editScopes: [
          { id: "same", blockIds: ["b1"], text: "one" },
          { id: "same", blockIds: ["b2"], text: "two" },
        ],
      },
    ]),
  ).toThrow(/scope ids/);
  expect(() =>
    parseIpcArgs("agent:enqueue", [
      root,
      { ...task, editScopes: [{ id: "scope", blockIds: ["b1", "b1"], text: "before" }] },
    ]),
  ).toThrow(/unique/);
  expect(() => parseIpcArgs("agent:enqueue", [root, { ...task, agentId: " " }])).toThrow(
    /non-empty/,
  );
});

test("list decoders reject sparse arrays instead of persisting their holes as null", () => {
  const sparse = Array(1);

  expect(() => parseIpcArgs("agent:enqueue", [root, { ...task, contextScope: sparse }])).toThrow(
    /contextScope\[0\]/,
  );
  expect(() =>
    parseIpcArgs("review:commit", [root, { chapter: "chapter.md", verdicts: sparse }]),
  ).toThrow(/verdicts\[0\]/);
  expect(() => parseIpcArgs("files:trash", [root, sparse])).toThrow(/files:trash\[1\]\[0\]/);
});
