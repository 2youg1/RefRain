import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { type IpcArgs, type IpcChannel, parseIpcArgs, type RootIpcChannel } from "./ipc-payload.ts";
import { RootAuthority } from "./root-authority.ts";

type InvokeHandler<Args extends unknown[], Result> = (
  event: IpcMainInvokeEvent,
  ...args: Args
) => Result | Promise<Result>;

interface OpenedWorkspace {
  readonly roots: readonly { readonly path: string; readonly missing?: boolean }[];
  readonly warnings?: readonly string[];
}

export interface IpcAuthority {
  approveRoot(path: string): boolean;
  handle<C extends IpcChannel, Result>(channel: C, body: InvokeHandler<IpcArgs<C>, Result>): void;
  handleRoot<C extends RootIpcChannel, Result>(
    channel: C,
    body: InvokeHandler<IpcArgs<C>, Result>,
  ): void;
  handleOpenRoots<Result extends OpenedWorkspace>(
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
export const createIpcAuthority = (
  ipc: IpcMain,
  rootAuthority = new RootAuthority(),
): IpcAuthority => {
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
      if (!openedRoots.has(root) || rootAuthority.status(root) !== "present")
        refuse(channel, `root is not an opened root: ${root}`);
      return body(event, ...args);
    });
  };

  const handleOpenRoots = <Result extends OpenedWorkspace>(
    channel: "project:load-workspace",
    body: InvokeHandler<IpcArgs<"project:load-workspace">, Result>,
  ): void => {
    handle(channel, async (event, roots) => {
      const unique = [...new Set(roots)];
      // A held path may be missing, which is a quiet workspace state rather than
      // a refusal. Anything present is identity-checked before `loadWorkspace`
      // can create project state or Source Backup inside it; a familiar pathname
      // is not permission to mutate a replacement directory.
      const held = new Map(
        unique.flatMap((root) =>
          rootAuthority.holds(root) ? [[root, rootAuthority.status(root)] as const] : [],
        ),
      );
      const admitted = unique.filter(
        (root) => held.get(root) !== undefined && held.get(root) !== "denied",
      );
      const refused = unique.flatMap((root) => {
        const status = held.get(root);
        if (status === "denied")
          return [{ root, warning: `Root 的文件系统身份已改变，请重新选择：${root}` }];
        return status === undefined
          ? [
              {
                root,
                warning: `Root 未获主进程授权，请重新选择；Source Backup 也不能作为 Root：${root}`,
              },
            ]
          : [];
      });
      const result = await body(event, admitted);

      openedRoots.clear();
      for (const root of result.roots) {
        if (root.missing !== true && rootAuthority.status(root.path) === "present")
          openedRoots.add(root.path);
      }

      if (refused.length === 0) return result;
      return {
        ...result,
        warnings: [...(result.warnings ?? []), ...refused.map(({ warning }) => warning)],
      } satisfies OpenedWorkspace;
    });
  };

  return {
    approveRoot: (path) => rootAuthority.approve(path),
    handle,
    handleRoot,
    handleOpenRoots,
  };
};
