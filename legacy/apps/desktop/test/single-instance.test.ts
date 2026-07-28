import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { receiveSecondInstance, secondInstancePaths } from "../src/main/single-instance";

test("the process takes its lock before Electron can create a window", () => {
  const source = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const lock = source.indexOf("app.requestSingleInstanceLock()");
  const ready = source.indexOf("app.whenReady()");

  expect(lock).toBeGreaterThan(-1);
  expect(ready).toBeGreaterThan(lock);
  expect(source).toContain('app.on("second-instance"');
});

test("only existing document paths survive a second instance argv", () => {
  const existing = new Set(["C:\\书\\第一章.md", "C:\\书"]);

  expect(
    secondInstancePaths(
      ["C:\\RefRain.exe", "C:\\app.asar", "--flag", "C:\\书\\第一章.md", "C:\\书"],
      "C:\\RefRain.exe",
      "C:\\app.asar",
      (path) => existing.has(path),
    ),
  ).toEqual(["C:\\书\\第一章.md", "C:\\书"]);
});

test("the primary window is restored before paths are delivered", () => {
  const events: string[] = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => events.push("restore"),
    show: () => events.push("show"),
    focus: () => events.push("focus"),
    webContents: {
      send: (channel: string, paths: string[]) => events.push(`${channel}:${paths.join(",")}`),
    },
  };

  receiveSecondInstance(window, ["C:\\书\\第一章.md"]);

  expect(events).toEqual(["restore", "show", "focus", "app:open-paths:C:\\书\\第一章.md"]);
});

test("the delivered path crosses preload and reaches workspace adoption", () => {
  const preload = readFileSync(new URL("../src/main/preload.ts", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../src/renderer/App.svelte", import.meta.url), "utf8");

  expect(preload).toContain('ipcRenderer.on("app:open-paths"');
  expect(preload).toContain('ipcRenderer.removeListener("app:open-paths"');
  expect(renderer).toContain("api().onOpenPaths");
  expect(renderer).toContain("void addRoots(paths)");
});

test("a destroyed window receives nothing", () => {
  let touched = false;
  receiveSecondInstance(
    {
      isDestroyed: () => true,
      isMinimized: () => false,
      restore: () => {
        touched = true;
      },
      show: () => {
        touched = true;
      },
      focus: () => {
        touched = true;
      },
      webContents: {
        send: () => {
          touched = true;
        },
      },
    },
    ["x"],
  );

  expect(touched).toBe(false);
});
