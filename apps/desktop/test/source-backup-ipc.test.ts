import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interruptedWriteMarkerPath } from "@refrain/core";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const mainFrame = { isDestroyed: () => false };
const sender = { isDestroyed: () => false, mainFrame };
const event = { sender, senderFrame: mainFrame };

const loadWorkspace = async (roots: string[]): Promise<unknown> => {
  const handlers = new Map<string, Handler>();
  registerHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    } as never,
  );
  const handler = handlers.get("project:load-workspace");
  if (!handler) throw new Error("project:load-workspace was not registered");
  return await handler(event, roots);
};

test("adopting an existing folder takes its Source Backup through the real IPC path", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-backup-ipc-"));
  const source = join(root, "01.md");
  const backup = join(root, ".refrain-source", "01.md");
  try {
    writeFileSync(source, "打开前原文。\n");

    await loadWorkspace([root]);
    expect(readFileSync(backup, "utf8")).toBe("打开前原文。\n");

    writeFileSync(source, "打开后正文。\n");
    await loadWorkspace([root]);
    expect(readFileSync(backup, "utf8")).toBe("打开前原文。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused Source Backup reaches the workspace IPC warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-backup-refused-"));
  try {
    writeFileSync(join(root, "01.md"), "无法备份的原文。\n");
    writeFileSync(join(root, ".refrain-source"), "这个名字被普通文件占用。\n");

    const workspace = (await loadWorkspace([root])) as { warnings?: string[] };
    expect(workspace.warnings).toHaveLength(1);
    expect(workspace.warnings?.[0]).toMatch(/无法写入原件副本/);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single-file Root takes its original without adopting the parent folder", async () => {
  const folder = mkdtempSync(join(tmpdir(), "refrain-backup-file-root-"));
  const source = join(folder, "only.md");
  const neighbour = join(folder, "neighbour.md");
  try {
    writeFileSync(source, "单文件。\n");
    writeFileSync(neighbour, "邻稿。\n");

    const workspace = (await loadWorkspace([source])) as { chapters: { path: string }[] };
    const companion = join(folder, ".only.md.refrain");
    expect(workspace.chapters.map((chapter) => chapter.path)).toEqual([source]);
    expect(readFileSync(join(companion, ".refrain-source", "only.md"), "utf8")).toBe("单文件。\n");
    expect(existsSync(join(companion, ".refrain-source", "neighbour.md"))).toBe(false);
  } finally {
    closeWorkbenches();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("startup recovery evidence reaches the renderer through the real workspace IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-recovery-ipc-"));
  const source = join(root, "01.md");
  try {
    writeFileSync(source, "权威正文。\n");
    writeFileSync(`${source}.writing`, "中断候选稿。\n");
    writeFileSync(interruptedWriteMarkerPath(source), "refrain-atomic-write-v1\n");

    const workspace = (await loadWorkspace([root])) as { recoveryEvidencePaths?: string[] };
    const evidence = workspace.recoveryEvidencePaths?.[0];

    expect(typeof evidence).toBe("string");
    expect(readFileSync(evidence ?? "", "utf8")).toBe("中断候选稿。\n");
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});
