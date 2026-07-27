import { afterEach, expect, test } from "bun:test";
import type { Launch, Launched } from "@refrain/agent";
import { __setSystemFontLauncher, registerHandlers } from "../src/main/ipc.ts";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
type FontLauncher = (options: Launch) => Launched;

const mainFrame = { isDestroyed: () => false };
const event = { sender: { isDestroyed: () => false, mainFrame }, senderFrame: mainFrame };
const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
};

const completed = (stdout: string, exited: Promise<number> = Promise.resolve(0)): Launched => ({
  child: {} as never,
  exited,
  stdout: Promise.resolve(stdout),
  stderr: Promise.resolve(""),
  kill: () => undefined,
});

const fontHandler = (launcher: FontLauncher): Handler => {
  __setSystemFontLauncher(launcher);
  const handlers = new Map<string, Handler>();
  registerHandlers(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    dialog as never,
  );
  const handler = handlers.get("fonts:list");
  if (!handler) throw new Error("fonts:list was not registered");
  return handler;
};

afterEach(() => __setSystemFontLauncher(undefined));

test("two sequential font requests enumerate the system once", async () => {
  let launches = 0;
  const handler = fontHandler(() => {
    launches += 1;
    return completed(" Yu Mincho \nNoto Sans SC\nYu Mincho\n\n");
  });

  expect(await handler(event)).toEqual(["Noto Sans SC", "Yu Mincho"]);
  expect(await handler(event)).toEqual(["Noto Sans SC", "Yu Mincho"]);
  expect(launches).toBe(1);
});

test("two concurrent font requests share the in-flight enumeration", async () => {
  let launches = 0;
  let finish!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const handler = fontHandler(() => {
    launches += 1;
    return completed("Shippori Mincho\n", exited);
  });

  const first = handler(event);
  const second = handler(event);
  expect(launches).toBe(1);

  finish(0);
  expect(await Promise.all([first, second])).toEqual([["Shippori Mincho"], ["Shippori Mincho"]]);
  expect(launches).toBe(1);
});

test("a failed font enumeration is retryable", async () => {
  let launches = 0;
  const handler = fontHandler(() => {
    launches += 1;
    if (launches === 1) return completed("", Promise.resolve(1));
    return completed("Zen Kaku Gothic New\n");
  });

  expect(await handler(event)).toEqual([]);
  expect(await handler(event)).toEqual(["Zen Kaku Gothic New"]);
  expect(launches).toBe(2);
});
