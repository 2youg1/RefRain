/**
 * A workbench outlives its Root only until the next workspace load.
 *
 * F-10: removing a single Root closed nothing. `closeWorkbenches` clears the
 * whole map at quit, and nothing paired an individual removal, so the dropped
 * Root kept its Verdict Ledger handle open and its native file index resident
 * for the rest of the session. Opening and closing Roots is ordinary work in a
 * multi-root workspace, so the leak grew with use rather than with size.
 *
 * The reaping is observed through the file index because that is the part of a
 * workbench a test can watch being built: a workbench that survived returns its
 * cached `Workspace`, a workbench that was reaped has to construct a new one.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setWorkspaceLoader, closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";
import { RootAuthority } from "../src/main/root-authority.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const rootAuthority = new RootAuthority();
const handlers = new Map<string, Handler>();
const ipc = {
  handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  removeHandler: (channel: string) => handlers.delete(channel),
};
const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
};
registerHandlers(ipc as never, dialog as never, rootAuthority);

const mainFrame = { isDestroyed: () => false };
const event = { sender: { isDestroyed: () => false, mainFrame }, senderFrame: mainFrame };

const invoke = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return await handler(event, ...args);
};

/** The renderer's own sequence: authorise, then load, then use. */
const loadWorkspace = async (roots: string[]) => {
  for (const root of roots) rootAuthority.approve(root);
  return await invoke("project:load-workspace", roots);
};

test("a Root dropped from the workspace loses its workbench", async () => {
  const kept = mkdtempSync(join(tmpdir(), "refrain-kept-"));
  const dropped = mkdtempSync(join(tmpdir(), "refrain-dropped-"));

  // One construction per live file index, counted so a cached index and a
  // rebuilt one can be told apart.
  const built: string[][] = [];
  __setWorkspaceLoader(
    async () =>
      ({
        Workspace: class {
          constructor(roots: string[]) {
            built.push(roots);
          }
          scan = () => 1;
        },
      }) as never,
  );

  try {
    await loadWorkspace([kept, dropped]);
    await invoke("files:scan", kept);
    await invoke("files:scan", dropped);
    expect(built.length).toBe(2);

    // The author removes one Root; the renderer reloads with what is left.
    await loadWorkspace([kept]);

    // Reopening the dropped Root must build a fresh index. A third build only
    // happens if the workbench — and with it the ledger handle — was released.
    await loadWorkspace([kept, dropped]);
    await invoke("files:scan", dropped);
    expect(built.length).toBe(3);

    // The surviving Root was not disturbed: its index is still the cached one.
    await invoke("files:scan", kept);
    expect(built.length).toBe(3);
  } finally {
    __setWorkspaceLoader(undefined);
    closeWorkbenches();
    rmSync(kept, { recursive: true, force: true });
    rmSync(dropped, { recursive: true, force: true });
  }
});

test("a Verdict Ledger handle is closed and replaced, never closed in place", async () => {
  const kept = mkdtempSync(join(tmpdir(), "refrain-ledger-kept-"));
  const dropped = mkdtempSync(join(tmpdir(), "refrain-ledger-drop-"));

  try {
    await loadWorkspace([kept, dropped]);

    // The ledger is open before the Root is dropped, so the reap has a real
    // handle to release.
    const before = (await invoke("ledger:all", dropped)) as { ok: boolean };
    expect(before.ok).toBe(true);

    await loadWorkspace([kept]);
    await loadWorkspace([kept, dropped]);

    // The other half of the pairing. Closing the ledger while leaving the
    // workbench mapped hands the next caller a closed database — which reads
    // as `ledger-unavailable` to the interface even though the file is fine.
    const after = (await invoke("ledger:all", dropped)) as { ok: boolean; detail?: string };
    expect(after.ok).toBe(true);

    // The Root that stayed is untouched by a neighbour leaving.
    const survivor = (await invoke("ledger:all", kept)) as { ok: boolean };
    expect(survivor.ok).toBe(true);
  } finally {
    closeWorkbenches();
    rmSync(kept, { recursive: true, force: true });
    rmSync(dropped, { recursive: true, force: true });
  }
});
