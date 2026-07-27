import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import { guardWindowClose } from "./close-window.ts";
import { cssVariables, profileForBounds } from "./display.ts";
import { closeWorkbenches, registerHandlers } from "./ipc.ts";
import { mayOpenExternally, rendererMayNavigate } from "./navigation.ts";
import { RootAuthority } from "./root-authority.ts";
import { receiveSecondInstance, secondInstancePaths } from "./single-instance.ts";

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

/**
 * Window-scoped capabilities register once and derive their owner from the
 * authenticated sender. Re-registering them inside `createWindow` made the
 * latest window steal global handlers from every earlier one.
 */
const registerWindowHandlers = (handlers: ReturnType<typeof registerHandlers>): void => {
  handlers.handle("window:fullscreen", (event, on) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Refused IPC window:fullscreen: sender has no window");
    window.setFullScreen(on);
    return window.isFullScreen();
  });

  handlers.handle("display:profile", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("Refused IPC display:profile: sender has no window");
    const profile = profileForBounds(screen, window.getBounds());
    return { ...profile, css: cssVariables(profile) };
  });
};

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

  /*
   * Dragging between monitors changes the target. Without this the window keeps
   * whichever budget it started with, which is wrong for the panel the writer
   * is now looking at.
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

  guardWindowClose(window, ipcMain, dialog);

  if (useDevServer) window.loadURL("http://localhost:5173");
  else window.loadFile(join(bundleDir(), "..", "renderer", "index.html"));

  return window;
};

/*
 * One project has one main-process owner.
 *
 * Without the lock, two ordinary launches could open the same root, each with
 * its own cached Text Head and ledger connection, and whichever one saved last
 * silently overwrote the other. The second process does not become an error:
 * it brings the existing window back and hands over the file or folder the OS
 * asked it to open.
 */
let rootAuthority: RootAuthority | undefined;
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else
  app.on("second-instance", (_event, argv) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    const paths = secondInstancePaths(argv, process.execPath, app.getAppPath(), existsSync);
    for (const path of paths) rootAuthority?.approve(path);
    receiveSecondInstance(window, paths);
  });

if (primaryInstance)
  app.whenReady().then(() => {
    // A writing application has no use for File/Edit/View/Window: every command
    // lives in the palette, which is reachable from one key. The default menu was
    // a black strip of affordances that duplicated nothing the app offers.
    Menu.setApplicationMenu(null);

    rootAuthority = new RootAuthority(join(app.getPath("userData"), "roots.json"));
    const handlers = registerHandlers(ipcMain, dialog, rootAuthority);
    registerWindowHandlers(handlers);
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
