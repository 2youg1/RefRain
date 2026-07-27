import type { BrowserWindow, Dialog, IpcMain } from "electron";

/**
 * Refuse to close a window until its renderer confirms that manuscript text is
 * on disk. A silent renderer receives a native choice, whose default preserves
 * the window; silence is never interpreted as permission to lose text.
 */
export const guardWindowClose = (
  window: BrowserWindow,
  ipc: IpcMain,
  dialog: Pick<Dialog, "showMessageBox">,
  timeoutMs = 3_000,
): void => {
  let closing = false;
  window.on("close", (event) => {
    if (closing || window.webContents.isDestroyed()) return;
    event.preventDefault();
    closing = true;

    const token = Date.now();
    const cleanup = () => {
      ipc.removeListener("window:close-ready", answered);
      ipc.removeListener("window:close-cancel", cancelled);
      clearTimeout(deadline);
    };
    const release = () => {
      cleanup();
      window.destroy();
    };
    const keepWriting = () => {
      cleanup();
      closing = false;
    };
    const answered = (_event: unknown, replied: number) => {
      if (replied === token) release();
    };
    const cancelled = (_event: unknown, replied: number) => {
      if (replied === token) keepWriting();
    };
    const deadline = setTimeout(() => {
      void dialog
        .showMessageBox(window, {
          type: "warning",
          buttons: ["继续写作 / Keep writing", "不保存并关闭 / Close without saving"],
          defaultId: 0,
          cancelId: 0,
          title: "RefRain",
          message: "手稿尚未确认写入磁盘。 / The manuscript has not been confirmed on disk.",
        })
        .then(({ response }) => {
          if (!closing || window.isDestroyed()) return;
          if (response === 1) release();
          else keepWriting();
        });
    }, timeoutMs);

    ipc.on("window:close-ready", answered);
    ipc.on("window:close-cancel", cancelled);
    window.webContents.send("window:closing", token);
  });
};
