import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { type IpcArgs, type IpcChannel, parseIpcArgs, type RootIpcChannel } from "./ipc-payload.ts";

type InvokeHandler<Args extends unknown[], Result> = (
  event: IpcMainInvokeEvent,
  ...args: Args
) => Result | Promise<Result>;

export interface IpcAuthority {
  handle<C extends IpcChannel, Result>(channel: C, body: InvokeHandler<IpcArgs<C>, Result>): void;
  handleRoot<C extends RootIpcChannel, Result>(
    channel: C,
    body: InvokeHandler<IpcArgs<C>, Result>,
  ): void;
  handleOpenRoots<Result>(
    channel: "project:load-workspace",
    body: InvokeHandler<IpcArgs<"project:load-workspace">, Result>,
  ): void;
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

/**
 * The only authority allowed to register RefRain invoke handlers.
 *
 * Main-frame admission, payload parsing and the opened-root set live in one
 * closure. Before this wrapper, `files:scan` accepted a temp Root the workspace
 * had never opened, `agent:enqueue` accepted a task whose agent id was a number,
 * and every new channel inherited both capabilities unless its author happened
 * to remember local checks.
 */
export const createIpcAuthority = (ipc: IpcMain): IpcAuthority => {
  const openedRoots = new Set<string>();

  const handle = <C extends IpcChannel, Result>(
    channel: C,
    body: InvokeHandler<IpcArgs<C>, Result>,
  ): void => {
    ipc.handle(channel, async (event, ...values: unknown[]) => {
      assertMainFrame(event, channel);
      const args = parseIpcArgs(channel, values);
      return await body(event, ...args);
    });
  };

  const handleRoot = <C extends RootIpcChannel, Result>(
    channel: C,
    body: InvokeHandler<IpcArgs<C>, Result>,
  ): void => {
    handle(channel, (event, ...args) => {
      const root = args[0];
      if (typeof root !== "string") return refuse(channel, "root parser returned a non-string");
      if (!openedRoots.has(root)) refuse(channel, `root is not an opened root: ${root}`);
      return body(event, ...args);
    });
  };

  const handleOpenRoots = <Result>(
    channel: "project:load-workspace",
    body: InvokeHandler<IpcArgs<"project:load-workspace">, Result>,
  ): void => {
    handle(channel, async (event, roots) => {
      const unique = [...new Set(roots)];
      const result = await body(event, unique);
      // Open/create/drop only choose candidates in the real renderer flow. The
      // workspace load is the first operation that proves all Roots can be
      // described; replacing after it returns both avoids half-granted
      // permissions and revokes a Root the author has removed.
      openedRoots.clear();
      for (const root of unique) openedRoots.add(root);
      return result;
    });
  };

  return { handle, handleRoot, handleOpenRoots };
};
