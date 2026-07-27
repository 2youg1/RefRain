export interface ExistingWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  readonly webContents: { send(channel: string, paths: string[]): void };
}

/** Paths an operating-system file association handed to the second instance. */
export const secondInstancePaths = (
  argv: readonly string[],
  executable: string,
  application: string,
  exists: (path: string) => boolean,
): string[] =>
  argv.filter(
    (arg) => arg !== executable && arg !== application && !arg.startsWith("--") && exists(arg),
  );

/** Bring the one writing window back, then give it what the OS asked to open. */
export const receiveSecondInstance = (window: ExistingWindow, paths: string[]): void => {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (paths.length > 0) window.webContents.send("app:open-paths", paths);
};
