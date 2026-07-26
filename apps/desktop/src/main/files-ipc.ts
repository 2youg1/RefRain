import type { Workspace as FileWorkspace, SortOrder } from "@refrain/fs";
import type { IpcMain } from "electron";

/**
 * The file layer's IPC channels.
 *
 * Separated from `ipc.ts` because the file layer degrades differently from
 * everything else in this process: when its platform binary is missing, every
 * channel here returns a tagged unavailability and the editor carries on. That
 * rule is easier to hold — and to review — where it is the only rule in the
 * file.
 *
 * There is deliberately no channel that deletes permanently. `verify-trash-only`
 * asserts the absence, so adding one fails the build rather than review.
 */

/** Success carries its payload; failure carries a reason a person can read. */
export type FileResult<T> = ({ ok: true } & T) | { ok: false; reason: string; detail: string };

/**
 * Resolves the native index for a root, or `undefined` when this platform has
 * no build. The caller owns the lifetime; this module only uses it.
 */
export type FilesFor = (
  root: string,
  options?: Record<string, unknown>,
) => Promise<FileWorkspace | undefined>;

export type FileErrorFor = (root: string) => string | undefined;

export const registerFileHandlers = (
  ipc: IpcMain,
  filesFor: FilesFor,
  fileErrorFor: FileErrorFor,
): void => {
  const unavailable = (root: string) => ({
    ok: false as const,
    reason: "unavailable" as const,
    detail: fileErrorFor(root) ?? "the file layer is not available",
  });

  /**
   * Wraps a call that can be refused by the guard.
   *
   * A refusal is data, not an exception: the renderer greys out a destination
   * or explains why a move was declined, and an exception crossing the bridge
   * would arrive as an opaque string.
   */
  const attempt = <T>(body: () => T): FileResult<{ value: T }> => {
    try {
      return { ok: true, value: body() };
    } catch (error) {
      return { ok: false, reason: "refused", detail: String(error) };
    }
  };

  ipc.handle("files:scan", async (_e, root: string, options?: Record<string, unknown>) => {
    const files = await filesFor(root, options);
    return files ? { ok: true as const, count: files.scan() } : unavailable(root);
  });

  ipc.handle("files:page", async (_e, root: string, offset: number, limit: number) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    return { ok: true as const, entries: files.page(offset, limit), total: files.size };
  });

  ipc.handle("files:search", async (_e, root: string, query: string, limit?: number) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    return { ok: true as const, hits: files.search(query, limit ?? 50) };
  });

  ipc.handle(
    "files:search-directories",
    async (_e, root: string, query: string, limit?: number) => {
      const files = await filesFor(root);
      if (!files) return unavailable(root);
      return { ok: true as const, hits: files.searchDirectories(query, limit ?? 50) };
    },
  );

  ipc.handle("files:sort", async (_e, root: string, order: SortOrder, descending: boolean) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    files.sort(order, descending);
    return { ok: true as const };
  });

  ipc.handle(
    "files:move",
    async (_e, root: string, from: string, to: string, replace?: boolean) => {
      const files = await filesFor(root);
      if (!files) return unavailable(root);
      const outcome = attempt(() => files.move(from, to, replace ?? false));
      if (outcome.ok) files.scan();
      return outcome.ok ? { ok: true as const, path: outcome.value } : outcome;
    },
  );

  ipc.handle(
    "files:copy",
    async (_e, root: string, from: string, to: string, replace?: boolean) => {
      const files = await filesFor(root);
      if (!files) return unavailable(root);
      const outcome = attempt(() => files.copy(from, to, replace ?? false));
      if (outcome.ok) files.scan();
      return outcome.ok ? { ok: true as const, path: outcome.value } : outcome;
    },
  );

  /*
   * Delete goes to the system trash, and nothing here does otherwise. Outcomes
   * are per path: one file locked by another process must not abandon the rest
   * of a selection, and the writer needs to know which chapter is still there.
   */
  ipc.handle("files:trash", async (_e, root: string, targets: string[]) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    const outcomes = files.trashAll(targets);
    files.scan();
    return { ok: true as const, outcomes };
  });

  /**
   * The escape hatch for a volume with no trash (SPEC Q8). Offered by the
   * interface only after `files:trash` reported NO_TRASH_HERE, so the author
   * chooses it rather than having their file quietly moved somewhere else.
   */
  ipc.handle("files:trash-via-home", async (_e, root: string, target: string) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    const outcome = attempt(() => files.trashViaHome(target));
    if (outcome.ok) files.scan();
    return outcome.ok ? { ok: true as const, path: outcome.value } : outcome;
  });

  ipc.handle("files:link", async (_e, root: string, target: string, linkPath: string) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    const outcome = attempt(() => files.link(target, linkPath));
    if (outcome.ok) files.scan();
    return outcome.ok ? { ok: true as const, path: outcome.value } : outcome;
  });

  ipc.handle("files:create-directory", async (_e, root: string, path: string) => {
    const files = await filesFor(root);
    if (!files) return unavailable(root);
    const outcome = attempt(() => files.createDirectory(path));
    if (outcome.ok) files.scan();
    return outcome.ok ? { ok: true as const, path: outcome.value } : outcome;
  });

  ipc.handle("files:unique-name", async (_e, root: string, desired: string) => {
    const files = await filesFor(root);
    return files ? { ok: true as const, path: files.uniqueName(desired) } : unavailable(root);
  });

  /** Whether a destination would be admitted, so the interface can grey it out. */
  ipc.handle("files:admits", async (_e, root: string, path: string) => {
    const files = await filesFor(root);
    return files ? { ok: true as const, admitted: files.admits(path) } : unavailable(root);
  });
};
