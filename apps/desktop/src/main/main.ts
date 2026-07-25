import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { registerHandlers } from "./ipc.ts";

/**
 * Windowing and packaging only (SPEC 5.2 rule 4). Business logic lives in
 * packages/core and packages/agent, so this shell stays replaceable.
 */

const isDev = !app.isPackaged;

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#faf9f7",
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      // The renderer holds no privilege. Every capability arrives through the
      // preload bridge, which exposes named channels and nothing else.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // SPEC 1.3: the app process makes no outbound requests. Enforced here rather
  // than trusted: a stray link in rendered Markdown must not become navigation.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && !url.startsWith("http://localhost:")) event.preventDefault();
  });

  if (isDev) window.loadURL("http://localhost:5173");
  else window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
};

app.whenReady().then(() => {
  registerHandlers(ipcMain, dialog);
  const window = createWindow();

  // CI launches the packaged binary with --smoke: the window must actually
  // finish loading, then the process exits. A build that emits files but
  // cannot open a window is not a deliverable, and only a real launch says so.
  if (process.argv.includes("--smoke"))
    window.webContents.once("did-finish-load", () => {
      console.log("SMOKE_OK window loaded");
      setTimeout(() => app.exit(0), 500);
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
