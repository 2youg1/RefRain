import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";
import { RootAuthority } from "../src/main/root-authority.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

interface FakeFrame {
  isDestroyed(): boolean;
}

const mainFrame: FakeFrame = { isDestroyed: () => false };
const sender = { isDestroyed: () => false, mainFrame };
const trustedEvent = { sender, senderFrame: mainFrame };
const noFrameEvent = { sender, senderFrame: null };
const foreignFrameEvent = { sender, senderFrame: { isDestroyed: () => false } };

const authorities = new WeakMap<Map<string, Handler>, RootAuthority>();

const collectHandlers = (dialog?: {
  showOpenDialog?: () => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog?: () => Promise<{ canceled: boolean; filePath?: string }>;
}) => {
  const handlers = new Map<string, Handler>();
  const rootAuthority = new RootAuthority();
  registerHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    {
      showOpenDialog: dialog?.showOpenDialog ?? (async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog:
        dialog?.showSaveDialog ?? (async () => ({ canceled: true, filePath: undefined })),
    } as never,
    rootAuthority,
  );
  authorities.set(handlers, rootAuthority);
  return handlers;
};

const approve = (handlers: Map<string, Handler>, path: string): void => {
  if (!authorities.get(handlers)?.approve(path)) throw new Error(`could not approve ${path}`);
};

const invoke = async (
  handlers: Map<string, Handler>,
  event: unknown,
  channel: string,
  ...args: unknown[]
) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return await handler(event, ...args);
};

test("an invoke with no sender frame is rejected before the dialog body", async () => {
  let opened = 0;
  const handlers = collectHandlers({
    showOpenDialog: async () => {
      opened += 1;
      return { canceled: true, filePaths: [] };
    },
  });

  await expect(invoke(handlers, noFrameEvent, "project:open")).rejects.toThrow(/main frame/i);
  expect(opened).toBe(0);
});

test("a foreign or child frame is rejected before the dialog body", async () => {
  let created = 0;
  const handlers = collectHandlers({
    showSaveDialog: async () => {
      created += 1;
      return { canceled: true, filePath: undefined };
    },
  });

  await expect(invoke(handlers, foreignFrameEvent, "project:create")).rejects.toThrow(
    /main frame/i,
  );
  expect(created).toBe(0);
});

test("an unopened root cannot enter files:scan or project:save", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-unopened-"));
  try {
    await expect(invoke(handlers, trustedEvent, "files:scan", root)).rejects.toThrow(
      /opened root/i,
    );
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "not authorised"),
    ).rejects.toThrow(/opened root/i);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderer-supplied workspace paths cannot grant their own Root authority", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-self-sign-"));
  try {
    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [root])) as {
      roots: unknown[];
      warnings?: string[];
    };

    expect(workspace.roots).toEqual([]);
    expect(workspace.warnings?.join("\n")).toMatch(/重新选择/);
    expect(existsSync(join(root, ".refrain"))).toBe(false);
    expect(existsSync(join(root, ".refrain-source"))).toBe(false);
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "not authorised"),
    ).rejects.toThrow(/opened root/i);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced Root is refused before workspace loading can mutate it", async () => {
  const handlers = collectHandlers();
  const parent = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-replaced-parent-"));
  const root = join(parent, "work");
  mkdirSync(root);
  try {
    approve(handlers, root);
    rmSync(root, { recursive: true });
    mkdirSync(root);

    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [root])) as {
      roots: unknown[];
      warnings?: string[];
    };

    expect(workspace.roots).toEqual([]);
    expect(workspace.warnings?.join("\n")).toMatch(/身份已改变/);
    expect(existsSync(join(root, ".refrain"))).toBe(false);
    expect(existsSync(join(root, ".refrain-source"))).toBe(false);
  } finally {
    closeWorkbenches();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a permitted missing Root stays visible without a refusal warning", async () => {
  const handlers = collectHandlers();
  const parent = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-missing-parent-"));
  const root = join(parent, "work");
  mkdirSync(root);
  try {
    approve(handlers, root);
    rmSync(root, { recursive: true });

    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [root])) as {
      roots: { path: string; missing?: boolean }[];
      warnings?: string[];
    };

    expect(workspace.roots).toEqual([expect.objectContaining({ path: root, missing: true })]);
    expect(workspace.warnings ?? []).toEqual([]);
  } finally {
    closeWorkbenches();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("load-workspace normalizes and deduplicates roots before admitting later calls", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-opened-"));
  try {
    approve(handlers, root);
    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [
      root,
      `${root}${sep}.`,
    ])) as { roots: { path: string }[] };

    expect(workspace.roots).toEqual([expect.objectContaining({ path: root })]);
    await expect(invoke(handlers, trustedEvent, "files:scan", root)).resolves.toMatchObject({
      ok: expect.any(Boolean),
    });
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "author text"),
    ).resolves.toMatchObject({ ok: true });
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("loading a new workspace revokes a Root the author removed", async () => {
  const handlers = collectHandlers();
  const first = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-first-"));
  const second = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-second-"));
  try {
    approve(handlers, first);
    approve(handlers, second);
    await invoke(handlers, trustedEvent, "project:load-workspace", [first]);
    await expect(invoke(handlers, trustedEvent, "files:scan", first)).resolves.toBeDefined();

    await invoke(handlers, trustedEvent, "project:load-workspace", [second]);

    await expect(invoke(handlers, trustedEvent, "files:scan", first)).rejects.toThrow(
      /opened root/i,
    );
    await expect(invoke(handlers, trustedEvent, "files:scan", second)).resolves.toBeDefined();
  } finally {
    closeWorkbenches();
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("retargeting an approved symlink revokes its Root authority", async () => {
  const handlers = collectHandlers();
  const parent = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-symlink-"));
  const first = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-target-a-"));
  const second = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-target-b-"));
  const root = join(parent, "root");
  try {
    symlinkSync(first, root, process.platform === "win32" ? "junction" : "dir");
    approve(handlers, root);
    await invoke(handlers, trustedEvent, "project:load-workspace", [root]);

    rmSync(root);
    symlinkSync(second, root, process.platform === "win32" ? "junction" : "dir");
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "must not cross"),
    ).rejects.toThrow(/opened root/i);
    expect(existsSync(join(second, "new.md"))).toBe(false);
  } finally {
    closeWorkbenches();
    rmSync(parent, { recursive: true, force: true });
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("load-workspace rejects malformed root lists without partially admitting them", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-shape-"));
  try {
    await expect(
      invoke(handlers, trustedEvent, "project:load-workspace", [root, 7]),
    ).rejects.toThrow(/argument.*string/i);
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "not authorised"),
    ).rejects.toThrow(/opened root/i);
    await expect(
      invoke(handlers, trustedEvent, "project:load-workspace", ["relative/root"]),
    ).rejects.toThrow(/argument.*absolute path/i);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a main-owned path choice grants a candidate, and workspace load makes it active", async () => {
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-candidate-"));
  const handlers = collectHandlers({
    showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
    showSaveDialog: async () => ({ canceled: false, filePath: root }),
  });
  try {
    expect(await invoke(handlers, trustedEvent, "project:open")).toBe(root);
    expect(await invoke(handlers, trustedEvent, "project:create")).toBe(root);
    expect(await invoke(handlers, trustedEvent, "project:resolve-drop", root)).toEqual({
      ok: true,
      path: root,
    });
    await expect(invoke(handlers, trustedEvent, "project:load", root)).rejects.toThrow(
      /opened root/i,
    );

    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [root])) as {
      roots: { path: string }[];
    };
    expect(workspace.roots.map((entry) => entry.path)).toEqual([root]);
    await expect(
      invoke(handlers, trustedEvent, "project:save", root, "new.md", "authorised"),
    ).resolves.toMatchObject({ ok: true });
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file picker grants a single-file Root before workspace adoption", async () => {
  const parent = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-file-picker-"));
  const root = join(parent, "essay.md");
  writeFileSync(root, "原文。\n");
  const handlers = collectHandlers({
    showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
  });
  try {
    expect(await invoke(handlers, trustedEvent, "project:open-file")).toBe(root);
    const workspace = (await invoke(handlers, trustedEvent, "project:load-workspace", [root])) as {
      roots: { path: string; kind: string }[];
    };
    expect(workspace.roots).toEqual([expect.objectContaining({ path: root, kind: "file" })]);
  } finally {
    closeWorkbenches();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("payloads are validated before a handler can act", async () => {
  let opened = 0;
  const handlers = collectHandlers({
    showOpenDialog: async () => {
      opened += 1;
      return { canceled: true, filePaths: [] };
    },
  });

  await expect(invoke(handlers, trustedEvent, "project:open", "surplus")).rejects.toThrow(
    /argument/i,
  );
  expect(opened).toBe(0);

  await expect(
    invoke(handlers, trustedEvent, "edits:describe", [{ id: "not-an-edit" }]),
  ).rejects.toThrow(/argument/i);
});

test("a malformed Review Task never enters the Agent Host", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-task-"));
  try {
    approve(handlers, root);
    await invoke(handlers, trustedEvent, "project:load-workspace", [root]);

    await expect(
      invoke(handlers, trustedEvent, "agent:enqueue", root, {
        id: "task",
        agentId: 7,
        baseline: "revision",
        prompt: "read",
        contextScope: [],
        editScopes: [],
      }),
    ).rejects.toThrow(/argument/i);
    await expect(invoke(handlers, trustedEvent, "agent:manifest", root)).resolves.toEqual([]);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file path outside its opened Root is rejected before the native layer", async () => {
  const handlers = collectHandlers();
  const root = mkdtempSync(join(tmpdir(), "refrain-ipc-auth-path-"));
  try {
    approve(handlers, root);
    await invoke(handlers, trustedEvent, "project:load-workspace", [root]);

    await expect(
      invoke(
        handlers,
        trustedEvent,
        "files:move",
        root,
        join(root, "..", "outside.md"),
        join(root, "inside.md"),
        false,
      ),
    ).rejects.toThrow(/argument|Root/i);
  } finally {
    closeWorkbenches();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every invoke handler registers exclusively through the shared authority", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of ["ipc.ts", "files-ipc.ts", "main.ts"]) {
    const source = readFileSync(join(here, "../src/main", name), "utf8");
    expect(source).not.toMatch(/\bipc(?:Main)?\.handle\s*\(/);
    if (name === "main.ts") {
      expect(source).toContain('handlers.handle("window:fullscreen"');
      expect(source).toContain('handlers.handle("display:profile"');
    }
  }
});
