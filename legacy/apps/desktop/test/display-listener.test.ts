/**
 * A window's listener on the shared `screen` object dies with the window.
 *
 * F-16: `screen.on("display-metrics-changed", announceDisplay)` was registered
 * inside `createWindow` and never removed. `screen` is process-global and
 * outlives every window, so each window opened over a session left its
 * `announceDisplay` behind — closing over that window's `webContents` and its
 * `lastProfile`. On macOS, where the app survives its last window and
 * `activate` builds another, the accumulation is unbounded.
 *
 * The listener count on a real `screen` stand-in is what this asserts, because
 * a source-text assertion would pass for a `removeListener` call that never
 * runs.
 */

import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const userData = mkdtempSync(join(tmpdir(), "refrain-display-"));

/** The process-global `screen`, which outlives every window. */
const screenEvents = new EventEmitter();
const windows: FakeWindow[] = [];
let activate: (() => void) | undefined;

const display = {
  displayFrequency: 60,
  scaleFactor: 1,
  size: { width: 1920, height: 1080 },
};

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = {
    setWindowOpenHandler: () => {},
    on: () => {},
    once: () => {},
    send: () => {},
    isDestroyed: () => this.destroyed,
  };
  isDestroyed = () => this.destroyed;
  getBounds = () => ({ x: 0, y: 0, width: 1920, height: 1080 });
  show = () => {};
  loadURL = () => {};
  loadFile = () => {};
  setFullScreen = () => {};
  isFullScreen = () => false;

  constructor() {
    super();
    windows.push(this);
  }

  /** What Electron does on a real close: destroy, then emit `closed`. */
  close(): void {
    this.destroyed = true;
    const index = windows.indexOf(this);
    if (index >= 0) windows.splice(index, 1);
    this.emit("closed");
  }
}

mock.module("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    quit: () => {},
    exit: () => {},
    getPath: () => userData,
    getAppPath: () => userData,
    whenReady: () => Promise.resolve(),
    on: (event: string, listener: () => void) => {
      if (event === "activate") activate = listener;
    },
  },
  BrowserWindow: Object.assign(FakeWindow, {
    fromWebContents: () => windows[0],
    getAllWindows: () => windows,
  }),
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {}, removeListener: () => {} },
  Menu: { setApplicationMenu: () => {} },
  screen: {
    on: (event: string, listener: () => void) => screenEvents.on(event, listener),
    removeListener: (event: string, listener: () => void) =>
      screenEvents.removeListener(event, listener),
    // Exposed so an over-broad removal is a wrong answer this suite can catch
    // rather than a crash inside the stand-in.
    removeAllListeners: (event: string) => screenEvents.removeAllListeners(event),
    getDisplayMatching: () => display,
    getPrimaryDisplay: () => display,
    getAllDisplays: () => [display],
  },
  shell: { openExternal: () => {} },
}));

const metricsListeners = () => screenEvents.listenerCount("display-metrics-changed");

/** `activate` is the only way to reach `createWindow` a second time. */
const openAnotherWindow = () => {
  if (!activate) throw new Error("main never registered an activate handler");
  activate();
};

test("each window's display listener is released when the window closes", async () => {
  await import("../src/main/main.ts");
  await Promise.resolve();

  try {
    expect(windows.length).toBe(1);
    expect(metricsListeners()).toBe(1);

    // The first window closes. Its listener must go with it, not linger holding
    // a destroyed `webContents`.
    windows[0]?.close();
    expect(metricsListeners()).toBe(0);

    // Opening and closing repeatedly must not accumulate. Before the fix this
    // climbed by one per window and never came down.
    for (let round = 0; round < 5; round += 1) {
      openAnotherWindow();
      expect(metricsListeners()).toBe(1);
      windows[0]?.close();
      expect(metricsListeners()).toBe(0);
    }

    // The removal is aimed at this window's own listener. A blanket
    // `removeAllListeners` would also pass every count above while silently
    // unsubscribing anything else the process had registered on `screen`.
    const foreign = () => {};
    screenEvents.on("display-metrics-changed", foreign);
    openAnotherWindow();
    expect(metricsListeners()).toBe(2);

    windows[0]?.close();
    expect(metricsListeners()).toBe(1);
    expect(screenEvents.listeners("display-metrics-changed")).toContain(foreign);
    screenEvents.removeListener("display-metrics-changed", foreign);
  } finally {
    for (const window of [...windows]) window.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
