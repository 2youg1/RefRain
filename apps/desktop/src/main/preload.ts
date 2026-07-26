import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The only bridge between renderer and main. Named channels, no `ipcRenderer`
 * handed through, no dynamic channel names: the renderer can invoke exactly
 * what is listed here and nothing else.
 */
const api = {
  openProject: () => ipcRenderer.invoke("project:open"),
  openFile: () => ipcRenderer.invoke("project:open-file"),
  createProject: () => ipcRenderer.invoke("project:create"),
  loadProject: (root: string) => ipcRenderer.invoke("project:load", root),
  loadWorkspace: (roots: string[]) => ipcRenderer.invoke("project:load-workspace", roots),

  /** The record of what the author changed, and how to put any of it back. */
  editsBetween: (before: string, after: string) =>
    ipcRenderer.invoke("edits:between", before, after),
  revertEdit: (text: string, edit: unknown) => ipcRenderer.invoke("edits:revert", text, edit),
  revertAll: (text: string, edits: unknown[]) =>
    ipcRenderer.invoke("edits:revert-all", text, edits),
  describeEdits: (edits: unknown[]) => ipcRenderer.invoke("edits:describe", edits),
  saveChapter: (root: string, title: string, text: string) =>
    ipcRenderer.invoke("project:save", root, title, text),

  /**
   * A dropped File carries no path in a sandboxed renderer; `webUtils` is
   * Electron's supported way to recover one. Kept here rather than in the
   * renderer so the renderer never touches an Electron module.
   */
  pathFor: (file: File) => webUtils.getPathForFile(file),
  resolveDrop: (path: string) => ipcRenderer.invoke("project:resolve-drop", path),

  fullscreen: (on: boolean) => ipcRenderer.invoke("window:fullscreen", on),

  /** Faces installed on this machine, so the author can pick from their own library. */
  systemFonts: () => ipcRenderer.invoke("fonts:list"),

  listAgents: (root: string) => ipcRenderer.invoke("agent:list", root),
  probeAgent: (root: string, id: string) => ipcRenderer.invoke("agent:probe", root, id),
  removeAgent: (root: string, id: string) => ipcRenderer.invoke("agent:remove", root, id),
  addAgent: (root: string, name: string, command: string) =>
    ipcRenderer.invoke("agent:add", root, name, command),
  enqueue: (root: string, task: unknown) => ipcRenderer.invoke("agent:enqueue", root, task),
  manifest: (root: string) => ipcRenderer.invoke("agent:manifest", root),
  send: (root: string) => ipcRenderer.invoke("agent:send", root),
  collect: (root: string, runId: string) => ipcRenderer.invoke("agent:collect", root, runId),
  runs: (root: string) => ipcRenderer.invoke("agent:runs", root),

  commit: (root: string, payload: unknown) => ipcRenderer.invoke("review:commit", root, payload),
  ledger: (root: string) => ipcRenderer.invoke("ledger:all", root),
  reply: (root: string, proposalId: string) => ipcRenderer.invoke("ledger:reply", root, proposalId),
} as const;

export type RefRainApi = typeof api;

contextBridge.exposeInMainWorld("refrain", api);
