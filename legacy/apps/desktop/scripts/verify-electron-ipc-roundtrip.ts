import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { closeWorkbenches, registerHandlers } from "../src/main/ipc.ts";
import { RootAuthority } from "../src/main/root-authority.ts";
import { terminateAfterCleanup } from "./verification-teardown.ts";

interface RendererResult {
  readonly accepted: boolean;
  readonly agentId: string;
  readonly contexts: readonly string[];
  readonly scopes: readonly unknown[];
}

const preload = resolve("dist", "main", "preload.cjs");
const root = mkdtempSync(join(tmpdir(), "refrain-electron-ipc-"));
let window: BrowserWindow | undefined;
let finished = false;

app.disableHardwareAcceleration();

const finish = (code: number): void => {
  if (finished) return;
  finished = true;
  terminateAfterCleanup(
    code,
    () => {
      closeWorkbenches();
      window?.destroy();
      rmSync(root, { recursive: true, force: true });
    },
    (outcome) => app.exit(outcome),
  );
};

const fail = (message: string): never => {
  throw new Error(message);
};

const verify = async (): Promise<void> => {
  writeFileSync(join(root, "01.md"), "第一段。\n\n第二段。\n", "utf8");
  if (!existsSync(preload)) fail(`shipping preload does not exist at ${preload}`);
  const authority = new RootAuthority();
  if (!authority.approve(root)) fail(`could not approve fixture Root ${root}`);
  registerHandlers(ipcMain, dialog, authority);

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.on("preload-error", (_event, path, error) => {
    console.error(`PRELOAD_FAIL ${path}: ${error.message}`);
  });
  await window.loadURL("data:text/html,<meta charset=utf-8><title>RefRain IPC check</title>");

  const result = (await window.webContents.executeJavaScript(`
    (async () => {
      const root = ${JSON.stringify(root)};
      const workspace = await window.refrain.loadWorkspace([root]);
      if (!workspace.roots.some((entry) => entry.path === root))
        throw new Error("preload could not open the approved Root");
      const agent = await window.refrain.addAgent(root, "roundtrip", "", "unknown", "unknown");
      const accepted = await window.refrain.enqueue(root, {
        id: "electron-roundtrip",
        agentId: agent.id,
        chapter: "01.md",
        prompt: "只评论全章。",
        editScopes: [],
      });
      const [manifest] = await window.refrain.manifest(root);
      return {
        accepted,
        agentId: agent.id,
        contexts: manifest?.contexts ?? [],
        scopes: manifest?.scopes ?? [],
      };
    })()
  `)) as RendererResult;

  if (!result.accepted) fail("shipping preload returned a refused enqueue");
  if (result.contexts.length !== 1 || result.contexts[0] !== "chapter:01.md")
    fail(`manifest lost whole-chapter context: ${JSON.stringify(result.contexts)}`);
  if (result.scopes.length !== 0)
    fail(`whole-chapter task gained write authority: ${JSON.stringify(result.scopes)}`);

  const state = JSON.parse(readFileSync(join(root, ".refrain", "host.json"), "utf8")) as {
    version?: unknown;
    queue?: Array<Record<string, unknown>>;
  };
  const task = state.queue?.[0] as
    | {
        agentId?: unknown;
        baseline?: unknown;
        contextScope?: unknown;
        editScopes?: unknown;
      }
    | undefined;
  if (state.version !== 2) fail(`HostState version is ${String(state.version)}, not 2`);
  const queued = task ?? fail("HostState persisted no queued Review Task");
  if (queued.agentId !== result.agentId) fail("HostState did not persist the Agent from preload");
  if (typeof queued.baseline !== "string" || !queued.baseline.startsWith("th:"))
    fail(`main did not bind a Text Head Revision: ${String(queued.baseline)}`);
  if (
    JSON.stringify(queued.contextScope) !==
    JSON.stringify([
      {
        kind: "material",
        id: "chapter:01.md",
        text: "第一段。\n\n第二段。",
      },
    ])
  )
    fail(`HostState lost material Context Scope: ${JSON.stringify(queued.contextScope)}`);
  if (!Array.isArray(queued.editScopes) || queued.editScopes.length !== 0)
    fail(`HostState invented an Edit Scope: ${JSON.stringify(queued.editScopes)}`);

  console.log("PASS  shipping preload binds one Review Task through authenticated Electron IPC");
};

const deadline = setTimeout(() => {
  console.error("FAIL  Electron IPC round trip did not settle within 30s");
  finish(1);
}, 30_000);

void app
  .whenReady()
  .then(verify)
  .then(
    () => {
      clearTimeout(deadline);
      finish(0);
    },
    (error) => {
      clearTimeout(deadline);
      console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
      finish(1);
    },
  );
