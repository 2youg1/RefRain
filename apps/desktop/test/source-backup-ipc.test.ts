import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a refused Source Backup reaches the renderer warning path", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-backup-refused-"));
  try {
    writeFileSync(join(root, "01.md"), "无法备份的原文。\n");
    writeFileSync(join(root, ".refrain-source"), "这个名字被普通文件占用。\n");

    const workspace = (await loadWorkspace([root])) as { warnings?: string[] };
    expect(workspace.warnings).toHaveLength(1);
    expect(workspace.warnings?.[0]).toMatch(/无法写入原件副本/);

    const app = readFileSync(new URL("../src/renderer/App.svelte", import.meta.url), "utf8");
    expect(app).toMatch(/workspace\.warnings\?\.length\) say\(workspace\.warnings\.join/);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single-file Root waits for SPEC Q22 rather than inventing backup placement", async () => {
  const folder = mkdtempSync(join(tmpdir(), "refrain-backup-file-root-"));
  const source = join(folder, "only.md");
  try {
    writeFileSync(source, "单文件。\n");

    await expect(loadWorkspace([source])).rejects.toThrow(/ENOTDIR|not a directory/i);
    expect(existsSync(join(folder, ".refrain-source"))).toBe(false);
  } finally {
    closeWorkbenches();
    rmSync(folder, { recursive: true, force: true });
  }
});
