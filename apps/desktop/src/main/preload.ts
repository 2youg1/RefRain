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

  /** Opens one of this project's own pages; main refuses anything else. */
  openProjectUrl: (url: string) => ipcRenderer.invoke("shell:open-project-url", url),

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
  searchLedger: (root: string, fragment: string) =>
    ipcRenderer.invoke("ledger:search", root, fragment),

  /**
   * The file layer. Every call returns a tagged result rather than throwing:
   * a machine without the platform binary keeps its editor and loses only the
   * browser, and the renderer needs to tell those apart.
   */
  files: {
    scan: (root: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("files:scan", root, options),
    page: (root: string, offset: number, limit: number) =>
      ipcRenderer.invoke("files:page", root, offset, limit),
    search: (root: string, query: string, limit?: number) =>
      ipcRenderer.invoke("files:search", root, query, limit),
    searchDirectories: (root: string, query: string, limit?: number) =>
      ipcRenderer.invoke("files:search-directories", root, query, limit),
    sort: (root: string, order: string, descending: boolean) =>
      ipcRenderer.invoke("files:sort", root, order, descending),
    move: (root: string, from: string, to: string, replace?: boolean) =>
      ipcRenderer.invoke("files:move", root, from, to, replace),
    copy: (root: string, from: string, to: string, replace?: boolean) =>
      ipcRenderer.invoke("files:copy", root, from, to, replace),
    /** Deletes to the system trash. There is deliberately no permanent variant. */
    trash: (root: string, targets: string[]) => ipcRenderer.invoke("files:trash", root, targets),
    /** For a volume with no trash of its own (SPEC Q8); still recoverable. */
    trashViaHome: (root: string, target: string) =>
      ipcRenderer.invoke("files:trash-via-home", root, target),
    link: (root: string, target: string, linkPath: string) =>
      ipcRenderer.invoke("files:link", root, target, linkPath),
    createDirectory: (root: string, path: string) =>
      ipcRenderer.invoke("files:create-directory", root, path),
    uniqueName: (root: string, desired: string) =>
      ipcRenderer.invoke("files:unique-name", root, desired),
    admits: (root: string, path: string) => ipcRenderer.invoke("files:admits", root, path),
  },

  /**
   * The panel this window is on: its refresh rate and pixel density.
   *
   * `onDisplayChange` fires when the window moves to another monitor, so a drag
   * from a 60 Hz laptop panel to a 165 Hz desktop one retargets the motion
   * instead of keeping the budget it started with.
   */
  displayProfile: () => ipcRenderer.invoke("display:profile"),
  onDisplayChange: (listener: (profile: unknown) => void) => {
    const wrapped = (_event: unknown, profile: unknown) => listener(profile);
    ipcRenderer.on("display:changed", wrapped);
    return () => ipcRenderer.removeListener("display:changed", wrapped);
  },
} as const;

export type RefRainApi = typeof api;

contextBridge.exposeInMainWorld("refrain", api);
