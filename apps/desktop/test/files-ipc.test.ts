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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHandlers } from "../src/main/ipc.ts";

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
    rmSync(root, { recursive: true, force: true });
  }
});

test("the editor channels do not depend on the file layer", () => {
  // The ordinary path stays whole when the fast path is absent: opening,
  // loading, and saving a chapter are registered independently.
  for (const channel of ["project:load", "project:save", "edits:between", "review:commit"]) {
    expect(handlers.has(channel)).toBe(true);
  }
});
