/**
 * What the file layer's IPC surface promises, tested through the handler table
 * rather than through a running window.
 *
 * Two things only show up here and nowhere else:
 *
 * **Degradation.** A machine with no platform binary must keep its editor. The
 * handlers return a tagged failure instead of throwing, and this file is where
 * that is proven — by registering the handlers against a fake `ipcMain` and
 * calling them with a root whose native load will fail.
 *
 * **Absence.** There is no channel that deletes permanently. An invariant of
 * this kind is only worth anything if something fails when it is violated, so
 * the channel list is asserted directly.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** A stand-in for `ipcMain` that records the channel table. */
const collectHandlers = () => {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  };

  // The signatures are Electron's; the test only needs the two methods above.
  registerHandlers(ipc as never, dialog as never);
  return handlers;
};

const handlers = collectHandlers();

const call = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return await handler({}, ...args);
};

test("every file channel the renderer calls is registered", () => {
  for (const channel of [
    "files:scan",
    "files:page",
    "files:search",
    "files:search-directories",
    "files:sort",
    "files:move",
    "files:copy",
    "files:trash",
    "files:link",
    "files:create-directory",
    "files:unique-name",
    "files:admits",
  ]) {
    expect(handlers.has(channel)).toBe(true);
  }
});

test("no channel deletes permanently", () => {
  // The invariant, stated as a test rather than as a comment: a writer's
  // misclick has to stay recoverable through the operating system.
  const channels = [...handlers.keys()];
  const destructive = channels.filter((channel) =>
    /files:(delete|remove|unlink|destroy|purge)/.test(channel),
  );

  expect(destructive).toEqual([]);
  expect(channels).toContain("files:trash");
});

test("a scan reports a count or an explained unavailability, never a throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-"));
  try {
    const result = (await call("files:scan", root)) as {
      ok: boolean;
      count?: number;
      detail?: string;
    };

    if (result.ok) {
      expect(typeof result.count).toBe("number");
    } else {
      // The failure has to say what is missing. An empty tree with no
      // explanation reads as a broken project rather than an unbuilt binary.
      expect(result.detail).toBeTruthy();
    }
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mutating call on an unavailable layer changes nothing and says why", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-"));
  try {
    const outcome = (await call("files:move", root, join(root, "a.md"), join(root, "b.md"))) as {
      ok: boolean;
      detail?: string;
    };

    // Either the move was refused because the file does not exist, or the layer
    // is unavailable. Both are tagged results; neither is an exception crossing
    // the bridge.
    expect(typeof outcome.ok).toBe("boolean");
    if (!outcome.ok) expect(outcome.detail).toBeTruthy();
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("loading through IPC remembers enough to refuse an external overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-save-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "盘上的第一版。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "另一个编辑器写下了更长的第二版。\n", "utf8");

    const outcome = (await call("project:save", root, "01.md", "RefRain 里的版本。")) as {
      ok: boolean;
      reason?: string;
      onDisk?: string;
    };

    expect(outcome).toMatchObject({
      ok: false,
      reason: "changed-underneath",
      onDisk: "另一个编辑器写下了更长的第二版。\n",
    });
    expect(readFileSync(path, "utf8")).toBe("另一个编辑器写下了更长的第二版。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interrupted write is reported without replacing either file", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-interrupted-"));
  const path = join(root, "01.md");
  const temporary = `${path}.writing`;
  try {
    writeFileSync(path, "权威正文。\n", "utf8");
    writeFileSync(temporary, "强杀前同步完的候选正文。\n", "utf8");
    await call("project:load", root);

    await expect(call("project:save", root, "01.md", "窗口里的未保存正文。")).rejects.toThrow();

    expect(readFileSync(path, "utf8")).toBe("权威正文。\n");
    expect(readFileSync(temporary, "utf8")).toBe("强杀前同步完的候选正文。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a newly created chapter becomes protected after its first save", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-new-"));
  const path = join(root, "新章.md");
  try {
    expect(await call("project:save", root, "新章.md", "第一版。")).toMatchObject({ ok: true });
    writeFileSync(path, "另一个编辑器接着写了第二版。\n", "utf8");

    const outcome = (await call("project:save", root, "新章.md", "RefRain 里的第三版。")) as {
      ok: boolean;
      reason?: string;
      onDisk?: string;
    };

    expect(outcome).toMatchObject({
      ok: false,
      reason: "changed-underneath",
      onDisk: "另一个编辑器接着写了第二版。\n",
    });
    expect(readFileSync(path, "utf8")).toBe("另一个编辑器接着写了第二版。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conflict choice cannot overwrite a newer disk version the author never saw", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-conflict-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "最初版本。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "冲突框展示的版本。\n", "utf8");
    await call("project:save", root, "01.md", "我保留的版本。");
    writeFileSync(path, "冲突框出现后写入的新版本。\n", "utf8");

    const outcome = (await call("project:resolve-conflict", root, "01.md", "mine")) as {
      ok: boolean;
      reason?: string;
      onDisk?: string;
    };

    expect(outcome).toMatchObject({
      ok: false,
      reason: "changed-underneath",
      onDisk: "冲突框出现后写入的新版本。\n",
    });
    expect(readFileSync(path, "utf8")).toBe("冲突框出现后写入的新版本。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeping the displayed local version commits it once when the disk stays put", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-keep-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "最初版本。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "冲突框展示的磁盘版本。\n", "utf8");
    await call("project:save", root, "01.md", "我明确保留的版本。");

    const outcome = (await call("project:resolve-conflict", root, "01.md", "mine")) as {
      ok: boolean;
      text?: string;
    };

    expect(outcome).toMatchObject({
      ok: true,
      text: "我明确保留的版本。",
      edits: [{ kind: "replace", before: "最初版本。", after: "我明确保留的版本。" }],
    });
    expect(readFileSync(path, "utf8")).toBe("我明确保留的版本。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("taking the displayed disk version changes no file bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-take-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "最初版本。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "冲突框展示的磁盘版本。\n", "utf8");
    await call("project:save", root, "01.md", "未采用的本地版本。");

    const outcome = (await call("project:resolve-conflict", root, "01.md", "disk")) as {
      ok: boolean;
      text?: string;
    };

    expect(outcome).toEqual({ ok: true, text: "冲突框展示的磁盘版本。\n" });
    expect(readFileSync(path, "utf8")).toBe("冲突框展示的磁盘版本。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("taking disk also refuses a newer version the conflict dialog never showed", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-retake-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "最初版本。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "冲突框展示的版本。\n", "utf8");
    await call("project:save", root, "01.md", "未采用的本地版本。");
    writeFileSync(path, "冲突框出现后写入的新版本。\n", "utf8");

    const outcome = (await call("project:resolve-conflict", root, "01.md", "disk")) as {
      ok: boolean;
      reason?: string;
      onDisk?: string;
    };

    expect(outcome).toMatchObject({
      ok: false,
      reason: "changed-underneath",
      onDisk: "冲突框出现后写入的新版本。\n",
    });
    expect(readFileSync(path, "utf8")).toBe("冲突框出现后写入的新版本。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown conflict choice is rejected instead of being treated as keep-mine", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-choice-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "最初版本。\n", "utf8");
    await call("project:load", root);
    writeFileSync(path, "另一个编辑器的版本。\n", "utf8");
    await call("project:save", root, "01.md", "本地版本。");

    const outcome = (await call("project:resolve-conflict", root, "01.md", "anything")) as {
      ok: boolean;
      reason?: string;
    };

    expect(outcome).toEqual({ ok: false, reason: "invalid conflict choice" });
    expect(readFileSync(path, "utf8")).toBe("另一个编辑器的版本。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-stem chapters keep distinct portable identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-identity-"));
  const markdown = join(root, "same.md");
  const text = join(root, "same.txt");
  try {
    writeFileSync(markdown, "Markdown 版本。\n", "utf8");
    writeFileSync(text, "Text 版本。\n", "utf8");

    const chapters = (await call("project:load", root)) as { id: string; path: string }[];
    expect(chapters.map((chapter) => chapter.id).sort()).toEqual(["same.md", "same.txt"]);

    expect(await call("project:save", root, "same.txt", "只改 Text。")).toMatchObject({ ok: true });
    expect(readFileSync(markdown, "utf8")).toBe("Markdown 版本。\n");
    expect(readFileSync(text, "utf8")).toBe("只改 Text。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reverting a removed middle paragraph through IPC restores its original position", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-revert-"));
  const path = join(root, "01.md");
  const before = "甲。\n\n乙。\n\n丙。";
  try {
    writeFileSync(path, `${before}\n`, "utf8");
    await call("project:load", root);

    const saved = (await call("project:save", root, "01.md", "甲。\n\n丙。")) as {
      ok: boolean;
      edits?: { id: string; kind: string; blockId: string; at: string }[];
    };
    const removed = saved.edits?.find((edit) => edit.kind === "remove");

    expect(removed).toBeDefined();
    expect(await call("edits:revert", root, "01.md", removed)).toBe(before);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later disjoint insertion does not move where an earlier removal is restored", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-lineage-"));
  const path = join(root, "01.md");
  try {
    writeFileSync(path, "甲。\n\n乙。\n\n丙。\n", "utf8");
    await call("project:load", root);
    const first = (await call("project:save", root, "01.md", "甲。\n\n丙。")) as {
      edits: { id: string; kind: string; blockId: string; at: string }[];
    };
    await call("project:save", root, "01.md", "前。\n\n甲。\n\n丙。");

    const removed = first.edits.find((edit) => edit.kind === "remove");
    expect(await call("edits:revert", root, "01.md", removed)).toBe("前。\n\n甲。\n\n乙。\n\n丙。");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one save may insert adjacent paragraphs without losing their lineage", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-adjacent-"));
  const path = join(root, "01.md");
  const after = "甲。\n\n乙一。\n\n乙二。\n\n丙。";
  try {
    writeFileSync(path, "甲。\n\n丙。\n", "utf8");
    await call("project:load", root);

    const saved = (await call("project:save", root, "01.md", after)) as {
      ok: boolean;
      edits: { kind: string; after?: string }[];
    };

    expect(saved.ok).toBe(true);
    expect(saved.edits.filter((edit) => edit.kind === "insert").map((edit) => edit.after)).toEqual([
      "乙一。",
      "乙二。",
    ]);
    expect(readFileSync(path, "utf8")).toBe(`${after}\n`);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an external edit has one atomic resolution channel", () => {
  expect(handlers.has("project:resolve-conflict")).toBe(true);
  expect(handlers.has("project:reload-chapter")).toBe(false);
});

test("the editor channels do not depend on the file layer", () => {
  // The ordinary path stays whole when the fast path is absent: opening,
  // loading, and saving a chapter are registered independently.
  for (const channel of ["project:load", "project:save", "edits:revert", "review:commit"]) {
    expect(handlers.has(channel)).toBe(true);
  }
});
