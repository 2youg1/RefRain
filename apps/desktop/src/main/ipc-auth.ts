import { isAbsolute, normalize } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

type InvokeHandler<Args extends unknown[], Result> = (
  event: IpcMainInvokeEvent,
  ...args: Args
) => Result | Promise<Result>;

export interface IpcAuthority {
  handle<Args extends unknown[], Result>(channel: string, body: InvokeHandler<Args, Result>): void;
  handleRoot<Rest extends unknown[], Result>(
    channel: string,
    body: InvokeHandler<[root: string, ...rest: Rest], Result>,
  ): void;
  handleOpenRoots<Result>(channel: string, body: InvokeHandler<[roots: string[]], Result>): void;
}

const refuse = (channel: string, reason: string): never => {
  throw new Error(`Refused IPC ${channel}: ${reason}`);
};

const assertMainFrame = (event: IpcMainInvokeEvent, channel: string): void => {
  const sender = event?.sender;
  const frame = event?.senderFrame;

  // The RED test proved both a missing frame and a foreign frame reached the
  // dialog body. Keeping this at registration means a later channel cannot
  // repeat that accident by forgetting a local check.
  if (!sender || typeof sender.isDestroyed !== "function" || sender.isDestroyed())
    refuse(channel, "sender is not the live main frame");
  if (!frame || typeof frame.isDestroyed !== "function" || frame.isDestroyed())
    refuse(channel, "sender is not the live main frame");
  if (frame !== sender.mainFrame) refuse(channel, "sender is not the live main frame");
};

const rootPath = (value: unknown, channel: string): string => {
  if (typeof value !== "string") return refuse(channel, "root must be an absolute path string");
  if (!isAbsolute(value)) return refuse(channel, "root must be an absolute path string");
  return normalize(value);
};

const rootList = (value: unknown, channel: string): string[] => {
  if (!Array.isArray(value))
    return refuse(channel, "roots must be an array of absolute path strings");

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !isAbsolute(candidate))
      return refuse(channel, "roots must be an array of absolute path strings");
    const root = normalize(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
};

/**
 * The only authority allowed to register RefRain invoke handlers.
 *
 * Main-frame admission and the opened-root set live in the same closure, so the
 * file module cannot drift from the editor module. Before this wrapper,
 * `files:scan` accepted a temp root the workspace had never opened; every new
 * channel inherited that capability unless its author remembered a check.
 */
export const createIpcAuthority = (ipc: IpcMain): IpcAuthority => {
  const openedRoots = new Set<string>();

  const handle = <Args extends unknown[], Result>(
    channel: string,
    body: InvokeHandler<Args, Result>,
  ): void => {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      assertMainFrame(event, channel);
      return await body(event, ...(args as Args));
    });
  };

  const handleRoot = <Rest extends unknown[], Result>(
    channel: string,
    body: InvokeHandler<[root: string, ...rest: Rest], Result>,
  ): void => {
    handle<[root: unknown, ...rest: Rest], Result>(channel, (event, candidate, ...rest) => {
      const root = rootPath(candidate, channel);
      if (!openedRoots.has(root)) refuse(channel, `root is not an opened root: ${root}`);
      return body(event, root, ...rest);
    });
  };

  const handleOpenRoots = <Result>(
    channel: string,
    body: InvokeHandler<[roots: string[]], Result>,
  ): void => {
    handle<[roots: unknown], Result>(channel, async (event, candidate) => {
      const roots = rootList(candidate, channel);
      const result = await body(event, roots);
      // Open/create/drop only choose candidates in the real renderer flow. The
      // workspace load is the first operation that proves all roots can be
      // described; adopting after it returns avoids half-granted permissions
      // when a later root makes the load throw.
      for (const root of roots) openedRoots.add(root);
      return result;
    });
  };

  return { handle, handleRoot, handleOpenRoots };
};
