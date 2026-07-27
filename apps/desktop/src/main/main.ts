import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { cssVariables, profileForBounds } from "./display.ts";
import { closeWorkbenches, registerHandlers } from "./ipc.ts";
import { mayOpenExternally, rendererMayNavigate } from "./navigation.ts";

/**
 * Windowing and packaging only (SPEC 5.2 rule 4). Business logic lives in
 * packages/core and packages/agent, so this shell stays replaceable.
 */

/**
 * Where this bundle actually sits at runtime.
 *
 * `__dirname` cannot be trusted here: the bundler inlines the build machine's
 * source path as a string literal, so a packaged app looks for its preload next
 * to a directory that exists only on the machine that built it. `require.main`
 * is correct in dist/ and inside an asar archive alike.
 */
const bundleDir = (): string => {
  const main = require.main?.filename;
  return main ? dirname(main) : join(app.getAppPath(), "dist", "main");
};

/**
 * The renderer comes from the dev server only when one is expected.
 * `isPackaged` is the wrong signal: running the built bundle under a plain
 * `electron` binary reports false, so CI's launch check went hunting for a dev
 * server that was never started.
 */
const useDevServer = process.env.REFRAIN_DEV === "1";

const createWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#faf9f7",
    // Windows draws its own caption; overriding it produced a stray coloured
    // band with no affordances. The system frame is the correct one to use.
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(bundleDir(), "preload.cjs"),
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
    if (mayOpenExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!rendererMayNavigate(url, useDevServer)) event.preventDefault();
  });

  // Zen mode asks the OS for real fullscreen; the renderer only says when.
  ipcMain.removeHandler("window:fullscreen");
  ipcMain.handle("window:fullscreen", (_event, on: boolean) => {
    window.setFullScreen(on);
    return window.isFullScreen();
  });

  /*
   * The panel decides the frame budget.
   *
   * A 165 Hz monitor has 6.06 ms per frame and a 60 Hz one 16.67; motion
   * quantised to a constant stutters on the first and wastes the second. The
   * renderer receives the measured rate and expresses durations in frames.
   */
  ipcMain.removeHandler("display:profile");
  ipcMain.handle("display:profile", () => {
    const profile = profileForBounds(screen, window.getBounds());
    return { ...profile, css: cssVariables(profile) };
  });

  /*
   * Dragging between monitors changes the target. Without this the window keeps
   * whichever budget it started with, which is the wrong one for the panel the
   * writer is now looking at.
   */
  let lastProfile = "";
  const announceDisplay = () => {
    if (window.isDestroyed()) return;
    const profile = profileForBounds(screen, window.getBounds());
    const signature = `${profile.refreshHz}/${profile.scaleFactor}`;
    if (signature === lastProfile) return;
    lastProfile = signature;
    window.webContents.send("display:changed", { ...profile, css: cssVariables(profile) });
  };

  window.on("move", announceDisplay);
  window.on("resize", announceDisplay);
  window.webContents.once("did-finish-load", announceDisplay);
  screen.on("display-metrics-changed", announceDisplay);

  /*
   * The window asks the renderer to write before it goes.
   *
   * Saving happened on Ctrl+S and on a chapter switch, and nowhere else, so
   * finishing a paragraph and closing the window — the most ordinary sequence
   * in a writing application — lost it in silence. `before-quit` only closed
   * the ledger database; nothing wrote the manuscript.
   *
   * The close is held rather than cancelled: the renderer answers on its own
   * token, and a renderer that never answers still gets three seconds before
   * the window leaves, because a hung save must not make the application
   * unclosable.
   */
  let closing = false;
  window.on("close", (event) => {
    if (closing || window.webContents.isDestroyed()) return;
    event.preventDefault();
    closing = true;

    const token = Date.now();
    const release = () => {
      ipcMain.removeListener("window:close-ready", answered);
      clearTimeout(deadline);
      window.destroy();
    };
    const answered = (_event: unknown, replied: number) => {
      if (replied === token) release();
    };
    const deadline = setTimeout(release, 3_000);

    ipcMain.on("window:close-ready", answered);
    window.webContents.send("window:closing", token);
  });

  if (useDevServer) window.loadURL("http://localhost:5173");
  else window.loadFile(join(bundleDir(), "..", "renderer", "index.html"));

  return window;
};

app.whenReady().then(() => {
  // A writing application has no use for File/Edit/View/Window: every command
  // lives in the palette, which is reachable from one key. The default menu was
  // a black strip of affordances that duplicated nothing the app offers.
  Menu.setApplicationMenu(null);

  registerHandlers(ipcMain, dialog);
  const window = createWindow();

  // CI launches the built app with --smoke: the window must actually finish
  // loading, then the process exits. Files on disk prove nothing about launch.
  //
  // The failure path needs its own exit. Without a deadline a window that never
  // loads hangs the job until the runner kills it, which reports as a timeout
  // rather than as the launch failure it is.
  if (process.argv.includes("--smoke")) {
    const deadline = setTimeout(() => {
      console.error("SMOKE_FAIL window did not finish loading within 30s");
      app.exit(1);
    }, 30_000);

    window.webContents.once("did-finish-load", () => {
      clearTimeout(deadline);
      console.log("SMOKE_OK window loaded");
      setTimeout(() => app.exit(0), 500);
    });

    window.webContents.once("did-fail-load", (_event, code, description) => {
      clearTimeout(deadline);
      console.error(`SMOKE_FAIL ${code} ${description}`);
      app.exit(1);
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", closeWorkbenches);
