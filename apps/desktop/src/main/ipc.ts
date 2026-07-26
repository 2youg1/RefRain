import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, ReviewTask } from "@refrain/agent";
import {
  AgentHost,
  after,
  CommandAdapter,
  FileChannelAdapter,
  launch,
  sendManifest,
} from "@refrain/agent";
import {
  type ChangedUnderneath,
  commitDecisionBatch,
  currentText,
  describeEditsForAgent,
  type Edit,
  editsBetween,
  type FileStamp,
  loadProject,
  loadWorkspace,
  type Proposal,
  revertAll,
  revertEdit,
  saveChapter,
  serializeVerdicts,
  sliceProposal,
  type TextHead,
  type Verdict,
  VerdictLedger,
  writeChapter,
} from "@refrain/core";
import type { Workspace as FileWorkspace } from "@refrain/fs";
import type { Dialog, IpcMain } from "electron";
import { registerFileHandlers } from "./files-ipc.ts";
import { type RosterEntry, readRoster, writeRoster } from "./roster.ts";

/**
 * The main process owns state; the renderer only presents and accepts input
 * (SPEC 5.2 rule 6). One workbench per project root, created on first touch.
 */
interface Workbench {
  readonly host: AgentHost;
  readonly ledger: VerdictLedger;
  readonly heads: Map<string, TextHead>;
  /**
   * Where each chapter lives, and what its file looked like when read.
   *
   * Two jobs. It lets a save compare against the disk instead of trusting the
   * cached head — a chapter edited in another editor used to be overwritten
   * without a word. And it removes a `loadProject` from the save path, which
   * re-read every chapter in the project each time (#41).
   */
  readonly onDisk: Map<string, { path: string; stamp?: FileStamp }>;
  readonly proposals: Map<string, Proposal>;
  /**
   * The roster, mirrored to `.refrain/agents.json`.
   *
   * Templates travel with it. Restoring names alone gives a list that cannot
   * run — `agent:add` built each adapter from its template and then dropped it,
   * so a reopened project had agents that failed on dispatch.
   */
  readonly roster: RosterEntry[];
  /**
   * The native file index, built lazily.
   *
   * Lazy because the file layer is a platform binary: a machine without one
   * must still open a project and edit text. The manuscript path does not
   * depend on the file browser, and tying them together would turn a missing
   * `.node` into an application that cannot start.
   */
  files?: FileWorkspace;
  fileError?: string;
}

const workbenches = new Map<string, Workbench>();

export const closeWorkbenches = (): void => {
  for (const workbench of workbenches.values()) workbench.ledger.close();
  workbenches.clear();
};

const openWorkbench = (root: string): Workbench => {
  const existing = workbenches.get(root);
  if (existing) return existing;

  const stateDir = join(root, ".refrain");
  mkdirSync(stateDir, { recursive: true });

  const host = new AgentHost(stateDir, [new FileChannelAdapter(stateDir)]);
  const roster = readRoster(stateDir);

  // Re-register what the author configured last time, adapters included. The
  // roster is the one thing here that cannot be rebuilt from the disk: heads
  // come from the chapters, runs and results are already files under
  // `.refrain/runs/`, and proposals freeze from those.
  for (const entry of roster) {
    if (entry.template !== undefined)
      host.addAdapter(
        new CommandAdapter({ id: entry.agent.binding.harness, template: entry.template }),
      );
    host.register(entry.agent);
  }

  const workbench: Workbench = {
    host,
    ledger: new VerdictLedger(join(stateDir, "verdicts.db")),
    heads: new Map(),
    onDisk: new Map(),
    proposals: new Map(),
    roster,
  };
  workbenches.set(root, workbench);
  return workbench;
};

/**
 * The native file index for a root, built on first use.
 *
 * Returns `undefined` rather than throwing when the platform binary is absent:
 * the file browser is an enhancement over an editor that must work without it.
 * The reason is kept on the workbench so the interface can say which platform
 * lacks a build instead of showing an empty tree.
 */
const filesFor = async (
  root: string,
  options?: Record<string, unknown>,
): Promise<FileWorkspace | undefined> => {
  const workbench = openWorkbench(root);
  if (workbench.files) return workbench.files;
  if (workbench.fileError) return undefined;

  try {
    const { Workspace } = await import("@refrain/fs");
    const files = new Workspace([root], options ?? {});
    files.scan();
    workbench.files = files;
    return files;
  } catch (error) {
    workbench.fileError = String(error);
    return undefined;
  }
};

const headFor = (root: string, title: string): TextHead => {
  const workbench = openWorkbench(root);
  const cached = workbench.heads.get(title);
  if (cached) return cached;

  const chapter = loadProject(root).chapters.find((c) => c.title === title);
  if (!chapter) throw new Error(`no chapter ${title}`);
  workbench.heads.set(title, chapter.head);
  return chapter.head;
};

export const registerHandlers = (ipc: IpcMain, dialog: Dialog): void => {
  ipc.handle("project:open", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Open a project folder",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipc.handle("project:create", async () => {
    const result = await dialog.showSaveDialog({
      title: "New project",
      properties: ["createDirectory"],
      buttonLabel: "Create",
    });
    if (result.canceled || !result.filePath) return null;
    mkdirSync(result.filePath, { recursive: true });
    return result.filePath;
  });

  /** A dropped file opens its folder; a dropped folder opens itself. */
  ipc.handle("project:resolve-drop", (_e, path: string) => {
    try {
      return statSync(path).isDirectory() ? path : dirname(path);
    } catch {
      return null;
    }
  });

  ipc.handle("project:open-file", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
      title: "Open a file",
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  /** Several roots at once: a folder kept empty for tidiness locks out nothing. */
  ipc.handle("project:load-workspace", (_e, roots: string[]) => {
    const workspace = loadWorkspace(roots);
    for (const chapter of workspace.chapters) {
      const workbench = openWorkbench(chapter.root);
      workbench.heads.set(chapter.title, chapter.head);
      workbench.onDisk.set(chapter.title, {
        path: chapter.path,
        ...(chapter.stamp === undefined ? {} : { stamp: chapter.stamp }),
      });
    }
    return workspace.chapters.map((c) => ({
      title: c.title,
      text: currentText(c.head),
      root: c.root,
      path: c.path,
    }));
  });

  const asHead = (text: string): TextHead => ({
    id: `mem@${Date.now()}`,
    blocks: text
      .split(/\n\s*\n/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map((t, i) => ({ id: `b${i}`, text: t })),
    cause: "in memory",
  });

  ipc.handle("edits:between", (_e, before: string, after: string) =>
    editsBetween(asHead(before), asHead(after)),
  );

  ipc.handle("edits:revert", (_e, text: string, edit: Edit) =>
    currentText(revertEdit(asHead(text), edit)),
  );

  ipc.handle("edits:revert-all", (_e, text: string, edits: Edit[]) =>
    currentText(revertAll(asHead(text), edits)),
  );

  ipc.handle("edits:describe", (_e, edits: Edit[]) => describeEditsForAgent(edits));

  ipc.handle("project:load", (_e, root: string) => {
    const project = loadProject(root);
    const workbench = openWorkbench(root);
    for (const chapter of project.chapters) workbench.heads.set(chapter.title, chapter.head);
    return project.chapters.map((c) => ({ title: c.title, text: currentText(c.head) }));
  });

  /**
   * Save a chapter, refusing if the file changed underneath.
   *
   * The refusal is the point. Before it, RefRain trusted its own cached head
   * as the truth about the disk, so a chapter the author had edited in another
   * editor was silently overwritten on the next keystroke-triggered save. The
   * file is the truth (SPEC axiom 1); when this process has fallen behind it,
   * a person has to decide, and the outcome carries the disk's text so the
   * interface can show them both.
   */
  ipc.handle("project:save", (_e, root: string, title: string, text: string) => {
    const workbench = openWorkbench(root);
    const head: TextHead = {
      id: `${title}@${Date.now()}`,
      blocks: text
        .split(/\n\s*\n/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t, i) => ({ id: `${title}:b${i}`, text: t })),
      cause: "author edit",
    };

    const known = workbench.onDisk.get(title);
    const outcome = known
      ? writeChapter(known.path, head, known.stamp)
      : saveChapter(loadProject(root), title, head);

    if (!outcome.ok) return outcome satisfies ChangedUnderneath;

    workbench.heads.set(title, head);
    if (known) workbench.onDisk.set(title, { path: known.path, stamp: outcome.stamp });
    return { ok: true as const };
  });

  /**
   * Take the file as it now is, discarding this session's unsaved text.
   *
   * The other half of the refusal above: an author who is told their file moved
   * on needs a way to accept that rather than only a way to be blocked.
   */
  ipc.handle("project:reload-chapter", (_e, root: string, title: string) => {
    const workbench = openWorkbench(root);
    const known = workbench.onDisk.get(title);
    if (!known) return { ok: false as const, reason: "unknown chapter" };

    const chapter = loadProject(root).chapters.find((c) => c.title === title);
    if (!chapter) return { ok: false as const, reason: "no longer on disk" };

    workbench.heads.set(title, chapter.head);
    workbench.onDisk.set(title, {
      path: chapter.path,
      ...(chapter.stamp === undefined ? {} : { stamp: chapter.stamp }),
    });
    return { ok: true as const, text: currentText(chapter.head) };
  });

  /**
   * Faces installed on this machine.
   *
   * Chromium knows them but exposes no API, so they are read from the platform:
   * the registry on Windows, fontconfig elsewhere. Failure returns an empty
   * list rather than throwing — the bundled faces still work.
   */
  ipc.handle("fonts:list", async () => {
    const argv =
      process.platform === "win32"
        ? [
            "powershell",
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Drawing; " +
              "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
              "ForEach-Object { $_.Name }",
          ]
        : ["fc-list", "--format", "%{family[0]}\\n"];

    try {
      const child = launch({ argv });
      await child.exited;
      const text = await child.stdout;
      return [
        ...new Set(
          text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ].sort();
    } catch {
      return [];
    }
  });

  /**
   * Open one of this project's own pages in the system browser.
   *
   * An allowlist rather than a pass-through: handing the renderer an
   * "open any URL" channel would let it originate outbound traffic by proxy,
   * and the no-network invariant would hold only in the letter. The four
   * addresses here are the ones the About page offers.
   */
  ipc.handle("shell:open-project-url", async (_e, url: string) => {
    const allowed = [
      "https://github.com/kaile9/RefRain",
      "https://github.com/kaile9/RefRain/issues",
      "https://github.com/kaile9/RefRain/discussions",
      "https://github.com/kaile9/RefRain/blob/main/LICENSE",
    ];
    if (!allowed.includes(url)) return false;
    // Imported here rather than at the top: outside a real Electron process
    // the `electron` module is a CommonJS stub that exports the binary's
    // path, so a top-level named import fails to parse under `bun test`.
    const { shell } = await import("electron");
    await shell.openExternal(url);
    return true;
  });

  ipc.handle("agent:list", (_e, root: string) =>
    openWorkbench(root).roster.map((entry) => entry.agent),
  );

  /**
   * Ask a harness whether it is actually reachable.
   *
   * Storing a command without ever running it tells the author nothing: they
   * discover the mistake when a run fails silently an hour later. This spawns
   * the command's first token with a version flag and reports what came back.
   */
  ipc.handle("agent:probe", async (_e, root: string, id: string) => {
    const agent = openWorkbench(root).roster.find((entry) => entry.agent.id === id)?.agent;
    if (!agent) return { ok: false, detail: "unknown agent" };
    if (agent.binding.harness === "file") return { ok: true };

    const [program] = agent.binding.harness.replace(/^command:/, "").split(/\s+/);
    if (!program) return { ok: false, detail: "no command configured" };

    try {
      const child = launch({ argv: [program, "--version"] });
      const timer = after(4000);
      const code = await Promise.race([child.exited, timer.promise.then(() => -1)]);
      timer.cancel();
      if (code === -1) {
        child.kill();
        return { ok: false, detail: "timed out after 4s" };
      }
      // A missing binary surfaces as -1 from the spawn error event; saying so
      // beats "exited -1", which tells an author nothing about what to fix.
      if (code === -1) return { ok: false, detail: `cannot run ${program}` };
      const version = (await child.stdout).trim().split("\n")[0];
      const failure = (await child.stderr).trim().split("\n")[0];
      return code === 0
        ? { ok: true, detail: version || undefined }
        : { ok: false, detail: failure || `exited ${code}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });

  ipc.handle("agent:remove", (_e, root: string, id: string) => {
    const workbench = openWorkbench(root);
    const index = workbench.roster.findIndex((entry) => entry.agent.id === id);
    if (index >= 0) workbench.roster.splice(index, 1);
    writeRoster(join(root, ".refrain"), workbench.roster);
    return true;
  });

  ipc.handle("agent:add", (_e, root: string, name: string, command: string) => {
    const workbench = openWorkbench(root);
    const harness = command.trim().length > 0 ? `command:${name}` : "file";
    const agent: Agent = {
      id: randomUUID(),
      name,
      binding: { harness, model: "unspecified", reasoningEffort: "unspecified" },
    };
    const template = harness === "file" ? undefined : command.split(/\s+/);
    if (template !== undefined)
      workbench.host.addAdapter(new CommandAdapter({ id: harness, template }));
    workbench.host.register(agent);
    workbench.roster.push({ agent, ...(template === undefined ? {} : { template }) });
    writeRoster(join(root, ".refrain"), workbench.roster);
    return agent;
  });

  ipc.handle("agent:enqueue", (_e, root: string, task: ReviewTask) => {
    openWorkbench(root).host.enqueue(task);
    return true;
  });

  ipc.handle("agent:manifest", (_e, root: string) => sendManifest(openWorkbench(root).host));

  ipc.handle("agent:send", async (_e, root: string) => {
    const runs = await openWorkbench(root).host.send();
    return runs.map((r) => ({ id: r.id, requestPath: r.requestPath, resultPath: r.resultPath }));
  });

  ipc.handle("agent:runs", (_e, root: string) =>
    openWorkbench(root)
      .host.runs()
      .map((r) => ({ id: r.id, state: r.state, resultPath: r.resultPath, agentId: r.agentId })),
  );

  ipc.handle("agent:collect", async (_e, root: string, runId: string) => {
    const workbench = openWorkbench(root);
    const proposals = await workbench.host.collect(runId);
    for (const proposal of proposals) workbench.proposals.set(proposal.id, proposal);
    return {
      proposals: proposals.map((p) => ({ ...p, slices: sliceProposal(p) })),
      comments: workbench.host.commentsFor(runId),
    };
  });

  ipc.handle("review:slice", (_e, proposal: Proposal) => sliceProposal(proposal));

  ipc.handle(
    "review:commit",
    (_e, root: string, payload: { chapter: string; verdicts: Verdict[] }) => {
      const workbench = openWorkbench(root);
      const head = headFor(root, payload.chapter);
      const staged = [...new Set(payload.verdicts.map((v) => v.proposalId))].flatMap((id) => {
        const proposal = workbench.proposals.get(id);
        return proposal ? [proposal] : [];
      });

      const result = commitDecisionBatch(head, staged, payload.verdicts);
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

      for (const verdict of result.verdicts) workbench.ledger.record(verdict);
      workbench.heads.set(payload.chapter, result.head);
      saveChapter(loadProject(root), payload.chapter, result.head);

      return { ok: true, text: currentText(result.head) };
    },
  );

  ipc.handle("ledger:all", (_e, root: string) => openWorkbench(root).ledger.all());

  ipc.handle("ledger:reply", (_e, root: string, proposalId: string) =>
    serializeVerdicts(openWorkbench(root).ledger.forProposal(proposalId)),
  );

  /*
   * Retrieval over stated reasoning. The ledger informs the author when they
   * revise an agent's persona; it does not compile one for them, which would
   * require an inference this application has no way to perform.
   */
  ipc.handle("ledger:search", (_e, root: string, fragment: string) =>
    openWorkbench(root).ledger.search(fragment),
  );

  // The file layer's channels live in their own module: they degrade as a
  // group when the platform binary is missing, and that rule is easier to hold
  // where it is the only rule in the file.
  registerFileHandlers(ipc, filesFor, (root) => openWorkbench(root).fileError);
};
