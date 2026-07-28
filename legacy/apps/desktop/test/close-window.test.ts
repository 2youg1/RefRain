import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow, Dialog, IpcMain } from "electron";
import { guardWindowClose } from "../src/main/close-window.ts";

const fixture = (dialogResponse = 0, timeoutMs = 20) => {
  const ipc = new EventEmitter();
  const windowEvents = new EventEmitter();
  const sent: { channel: string; token: number }[] = [];
  let destroyed = false;
  let prevented = false;
  let prompts = 0;
  const window = {
    on: windowEvents.on.bind(windowEvents),
    destroy: () => {
      destroyed = true;
    },
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, token: number) => sent.push({ channel, token }),
    },
  } as unknown as BrowserWindow;
  const dialog = {
    showMessageBox: async () => {
      prompts += 1;
      return { response: dialogResponse };
    },
  } as unknown as Dialog;

  guardWindowClose(window, ipc as unknown as IpcMain, dialog, timeoutMs);
  const close = () =>
    windowEvents.emit("close", {
      preventDefault: () => {
        prevented = true;
      },
    });
  const token = () => {
    const request = sent.at(-1);
    if (!request) throw new Error("the window sent no close request");
    return request.token;
  };

  return {
    ipc,
    close,
    token,
    destroyed: () => destroyed,
    prevented: () => prevented,
    prompts: () => prompts,
  };
};

test("a renderer-confirmed save releases the window", () => {
  const held = fixture();
  held.close();

  expect(held.prevented()).toBe(true);
  expect(held.destroyed()).toBe(false);
  held.ipc.emit("window:close-ready", {}, held.token());
  expect(held.destroyed()).toBe(true);
});

test("a refused save keeps the window and permits a later close attempt", () => {
  const held = fixture();
  held.close();
  held.ipc.emit("window:close-cancel", {}, held.token());

  expect(held.destroyed()).toBe(false);
  held.close();
  held.ipc.emit("window:close-ready", {}, held.token());
  expect(held.destroyed()).toBe(true);
});

test("a silent renderer defaults to keeping the manuscript open", async () => {
  const held = fixture(0, 1);
  held.close();
  await Bun.sleep(10);

  expect(held.prompts()).toBe(1);
  expect(held.destroyed()).toBe(false);
});

test("only the author's explicit timeout choice closes without confirmation", async () => {
  const held = fixture(1, 1);
  held.close();
  await Bun.sleep(10);

  expect(held.prompts()).toBe(1);
  expect(held.destroyed()).toBe(true);
});
