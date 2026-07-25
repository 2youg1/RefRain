import { contextBridge, ipcRenderer } from "electron";

/**
 * The only bridge between renderer and main. Named channels, no `ipcRenderer`
 * handed through, no dynamic channel names: the renderer can invoke exactly
 * what is listed here and nothing else.
 */
const api = {
  openProject: () => ipcRenderer.invoke("project:open"),
  loadProject: (root: string) => ipcRenderer.invoke("project:load", root),
  saveChapter: (root: string, title: string, text: string) =>
    ipcRenderer.invoke("project:save", root, title, text),

  listAgents: (root: string) => ipcRenderer.invoke("agent:list", root),
  addAgent: (root: string, name: string, command: string) =>
    ipcRenderer.invoke("agent:add", root, name, command),
  enqueue: (root: string, task: unknown) => ipcRenderer.invoke("agent:enqueue", root, task),
  manifest: (root: string) => ipcRenderer.invoke("agent:manifest", root),
  send: (root: string) => ipcRenderer.invoke("agent:send", root),
  collect: (root: string, runId: string) => ipcRenderer.invoke("agent:collect", root, runId),
  runs: (root: string) => ipcRenderer.invoke("agent:runs", root),

  slice: (proposal: unknown) => ipcRenderer.invoke("review:slice", proposal),
  commit: (root: string, payload: unknown) => ipcRenderer.invoke("review:commit", root, payload),
  ledger: (root: string) => ipcRenderer.invoke("ledger:all", root),
  reply: (root: string, proposalId: string) => ipcRenderer.invoke("ledger:reply", root, proposalId),
} as const;

export type RecensionApi = typeof api;

contextBridge.exposeInMainWorld("recension", api);
