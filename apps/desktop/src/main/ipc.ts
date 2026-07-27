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
  advanceTextHead,
  type ChangedUnderneath,
  commitDecisionBatch,
  currentText,
  describeEditsForAgent,
  type Edit,
  type FileStamp,
  loadProject,
  loadWorkspace,
  type Proposal,
  persistDecisionCommit,
  readChapterFile,
  recoverDecisionCommit,
  revertAll,
  revertEdit,
  saveChapter,
  serializeVerdicts,
  sliceProposal,
  splitBlocks,
  type TextHead,
  type Verdict,
  VerdictLedger,
  type WriteOutcome,
  writeChapter,
} from "@refrain/core";
import type { Workspace as FileWorkspace } from "@refrain/fs";
import type { Dialog, IpcMain } from "electron";
import { parseCommandLine } from "./command-line.ts";
import { registerFileHandlers } from "./files-ipc.ts";
import { type RosterEntry, readRoster, writeRoster } from "./roster.ts";

/**
 * The main process owns state; the renderer only presents and accepts input
 * (SPEC 5.2 rule 6). One workbench per project root, created on first touch.
 */
interface PendingConflict {
  readonly path: string;
  readonly mine: string;
  readonly onDisk: string;
  readonly stamp: FileStamp;
}

interface Workbench {
  readonly host: AgentHost;
  /**
   * The Verdict Ledger, when SQLite could open one.
   *
   * Optional for the same reason the file index is: a project must open
   * without it. Opening a project used to require opening the database first,
   * so a read-only folder, a synced folder holding a conflicted copy, or a
   * `verdicts.db` truncated by an earlier crash made every one of nineteen IPC
   * channels reject — and neither main nor the renderer caught it, so the
   * application answered a click with nothing at all.
   *
   * The ledger records judgments. Opening, writing and saving do not need it,
   * and `files` next door has been degrading correctly all along with the
   * comment that says why: the file browser is an enhancement on top of the
   * editor. So is the ledger.
   */
  readonly ledger?: VerdictLedger;
  /** Why the ledger is absent, so the interface can say which one it is. */
  readonly ledgerError?: string;
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
  /** A choice may govern only the two versions the conflict dialog displayed. */
  readonly conflicts: Map<string, PendingConflict>;
  readonly proposals: Map<string, Proposal>;
  /** An interrupted Decision Batch that disk evidence could not resolve safely. */
  commitRecovery?: string;
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
  for (const workbench of workbenches.values()) workbench.ledger?.close();
  workbenches.clear();
};

const openWorkbench = (root: string): Workbench => {
  const existing = workbenches.get(root);
  if (existing) return existing;

  const stateDir = join(root, ".refrain");
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch (error) {
    throw new Error(`无法建立项目状态目录 ${stateDir}：${String(error)}`);
  }

  const host = new AgentHost(stateDir, [new FileChannelAdapter(stateDir)]);
  const roster = readRoster(stateDir);

  // Re-register what the author configured last time. The roster is the one
  // thing here that cannot be rebuilt from the disk: heads come from the
  // chapters, runs and results are already files under `.refrain/runs/`, and
  // proposals freeze from those.
  //
  // The command adapter waits for consent. `agents.json` sits inside the
  // project folder, so it travels with the project — a clone, a shared drive,
  // an archive from a colleague — and building the adapter here used to be
  // enough: opening the Agents screen probes every agent, and a probe runs the
  // binary. Reading someone else's writing project executed their choice of
  // program before the author had seen its name. The agent is listed either
  // way, so nothing disappears; what waits is the ability to run it.
  for (const entry of roster) {
    if (entry.template !== undefined && entry.trusted === true)
      host.addAdapter(
        new CommandAdapter({ id: entry.agent.binding.harness, template: entry.template }),
      );
    host.register(entry.agent);
  }

  /*
   * A ledger that will not open is a lost capability, not a lost project.
   *
   * This threw, and nothing caught it — not here, and not in the renderer's
   * `reload()`. Nineteen of twenty-seven channels pass through this function,
   * so one unwritable folder or one truncated `verdicts.db` turned opening,
   * saving, dispatching and judging into clicks that produced silence. The
   * dialogs that did work were exactly the ones that skip this function, which
   * is why choosing a file felt fine and nothing followed it.
   *
   * Two causes are measured: a state directory that cannot be written yields
   * "unable to open database file", and a corrupted database yields "file is
   * not a database" — both ordinary on a synced or removable volume.
   */
  let ledger: VerdictLedger | undefined;
  let ledgerError: string | undefined;
  try {
    ledger = new VerdictLedger(join(stateDir, "verdicts.db"));
  } catch (error) {
    ledgerError = String(error instanceof Error ? error.message : error);
  }

  const recovery = ledger ? recoverDecisionCommit(stateDir, ledger) : { ok: true as const };
  const workbench: Workbench = {
    host,
    ...(ledger === undefined ? {} : { ledger }),
    ...(ledgerError === undefined ? {} : { ledgerError }),
    heads: new Map(),
    onDisk: new Map(),
    conflicts: new Map(),
    proposals: new Map(),
    roster,
    ...(recovery.ok ? {} : { commitRecovery: recovery.detail ?? "Decision Batch recovery failed" }),
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

const headFor = (root: string, chapterId: string): TextHead => {
  const workbench = openWorkbench(root);
  const cached = workbench.heads.get(chapterId);
  if (cached) return cached;

  const chapter = loadProject(root).chapters.find((candidate) => candidate.id === chapterId);
  if (!chapter) throw new Error(`no chapter ${chapterId}`);
  workbench.heads.set(chapterId, chapter.head);
  return chapter.head;
};

const chapterHead = (chapterId: string, text: string, cause: string): TextHead => ({
  id: `${chapterId}@${Date.now()}`,
  // `core` owns where a block begins. This was one of three copies of that
  // rule; block identity is positional, so any disagreement between them
  // renumbers blocks across the process boundary and silently detaches every
  // queued proposal from the text it was written against.
  blocks: splitBlocks(text).map((block, index) => ({ id: `${chapterId}:b${index}`, text: block })),
  cause,
});

const advanceChapter = (workbench: Workbench, chapterId: string, text: string, cause: string) =>
  advanceTextHead(
    workbench.heads.get(chapterId) ?? chapterHead(chapterId, "", "new chapter"),
    text,
    cause,
  );

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
  /*
   * A refusal carries its reason, the way the file layer's do.
   *
   * `null` meant "cannot use this", and the renderer answered it with nothing
   * at all — so dropping a file from an unreadable volume, a disconnected
   * network share, or a cloud placeholder that had not materialised looked
   * exactly like dropping it onto a program that ignores drops.
   */
  ipc.handle("project:resolve-drop", (_e, path: string) => {
    try {
      return { ok: true, path: statSync(path).isDirectory() ? path : dirname(path) };
    } catch (error) {
      return {
        ok: false,
        reason: "unreadable-path",
        detail: error instanceof Error ? error.message : String(error),
      };
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
    const pathOf = new Map(workspace.roots.map((root) => [root.id, root.path]));

    for (const chapter of workspace.chapters) {
      // A workbench is keyed by the root's own path. For a single opened file
      // that is the file, not its folder — which is the whole of why a lone
      // file used to open into an empty interface.
      const owner = pathOf.get(chapter.rootId);
      if (owner === undefined) continue;
      const workbench = openWorkbench(owner);
      workbench.heads.set(chapter.id, chapter.head);
      workbench.onDisk.set(chapter.id, {
        path: chapter.path,
        ...(chapter.stamp === undefined ? {} : { stamp: chapter.stamp }),
      });
    }

    return {
      roots: workspace.roots.map((root) => ({
        id: root.id,
        path: root.path,
        name: root.name,
        kind: root.kind,
        ...(root.missing === undefined ? {} : { missing: root.missing }),
      })),
      chapters: workspace.chapters.map((c) => ({
        id: c.id,
        title: c.title,
        text: currentText(c.head),
        rootId: c.rootId,
        root: pathOf.get(c.rootId) ?? "",
        role: c.role,
        path: c.path,
      })),
    };
  });

  ipc.handle("edits:revert", (_e, root: string, chapterId: string, edit: Edit) => {
    const workbench = openWorkbench(root);
    const head = revertEdit(headFor(root, chapterId), edit);
    workbench.heads.set(chapterId, head);
    return currentText(head);
  });

  ipc.handle("edits:revert-all", (_e, root: string, chapterId: string, edits: Edit[]) => {
    const workbench = openWorkbench(root);
    const head = revertAll(headFor(root, chapterId), edits);
    workbench.heads.set(chapterId, head);
    return currentText(head);
  });

  ipc.handle("edits:describe", (_e, edits: Edit[]) => describeEditsForAgent(edits));

  ipc.handle("project:load", (_e, root: string) => {
    const project = loadProject(root);
    const workbench = openWorkbench(root);
    for (const chapter of project.chapters) {
      workbench.heads.set(chapter.id, chapter.head);
      workbench.onDisk.set(chapter.id, {
        path: chapter.path,
        ...(chapter.stamp === undefined ? {} : { stamp: chapter.stamp }),
      });
    }
    return project.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      text: currentText(chapter.head),
      rootId: chapter.rootId,
      root: project.root,
      role: chapter.role,
      path: chapter.path,
    }));
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
  ipc.handle("project:save", (_e, root: string, chapterId: string, text: string) => {
    const workbench = openWorkbench(root);
    const advanced = advanceChapter(workbench, chapterId, text, "author edit");
    const head = advanced.head;

    const known = workbench.onDisk.get(chapterId);
    const outcome = known
      ? writeChapter(known.path, head, known.stamp)
      : saveChapter(loadProject(root), chapterId, head);

    if (!outcome.ok) {
      workbench.conflicts.set(chapterId, {
        path: outcome.path,
        mine: text,
        onDisk: outcome.onDisk,
        stamp: outcome.stamp,
      });
      return outcome satisfies ChangedUnderneath;
    }

    workbench.conflicts.delete(chapterId);
    workbench.heads.set(chapterId, head);
    workbench.onDisk.set(chapterId, { path: outcome.path, stamp: outcome.stamp });
    return { ok: true as const, edits: advanced.edits };
  });

  ipc.handle("project:resolve-conflict", (_e, root: string, chapterId: string, choice: unknown) => {
    const workbench = openWorkbench(root);
    const pending = workbench.conflicts.get(chapterId);
    if (!pending) return { ok: false as const, reason: "no pending conflict" };
    if (choice !== "mine" && choice !== "disk")
      return { ok: false as const, reason: "invalid conflict choice" };
    if (choice === "disk") {
      const actual = readChapterFile(pending.path);
      if (actual === undefined)
        return { ok: false as const, reason: "chapter no longer exists on disk" };
      if (actual.stamp.digest !== pending.stamp.digest) {
        workbench.conflicts.set(chapterId, {
          path: pending.path,
          mine: pending.mine,
          onDisk: actual.text,
          stamp: actual.stamp,
        });
        return {
          ok: false as const,
          reason: "changed-underneath" as const,
          path: pending.path,
          onDisk: actual.text,
          stamp: actual.stamp,
        };
      }
      const head = advanceChapter(
        workbench,
        chapterId,
        pending.onDisk,
        "author accepted an external edit",
      ).head;
      workbench.conflicts.delete(chapterId);
      workbench.heads.set(chapterId, head);
      workbench.onDisk.set(chapterId, { path: pending.path, stamp: pending.stamp });
      return { ok: true as const, text: pending.onDisk };
    }

    const advanced = advanceChapter(
      workbench,
      chapterId,
      pending.mine,
      "author resolved an external edit",
    );
    const head = advanced.head;
    const outcome = writeChapter(pending.path, head, pending.stamp);
    if (!outcome.ok) {
      workbench.conflicts.set(chapterId, {
        path: outcome.path,
        mine: pending.mine,
        onDisk: outcome.onDisk,
        stamp: outcome.stamp,
      });
      return outcome;
    }

    workbench.conflicts.delete(chapterId);
    workbench.heads.set(chapterId, head);
    workbench.onDisk.set(chapterId, { path: pending.path, stamp: outcome.stamp });
    return { ok: true as const, text: pending.mine, edits: advanced.edits };
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

  /**
   * The roster, with the command each entry runs and whether it may run yet.
   *
   * The argv travels to the interface deliberately: a confirmation that says
   * "trust this agent?" without showing what it executes asks the author to
   * agree to something they cannot read.
   */
  ipc.handle("agent:list", (_e, root: string) =>
    openWorkbench(root).roster.map((entry) => ({
      ...entry.agent,
      ...(entry.template === undefined ? {} : { command: entry.template.join(" ") }),
      trusted: entry.template === undefined || entry.trusted === true,
    })),
  );

  /**
   * Record that the author read this agent's command and accepted it.
   *
   * Trust is per project, because it is a judgment about this project's
   * `agents.json` and not about an agent's name.
   */
  ipc.handle("agent:trust", (_e, root: string, id: string) => {
    const workbench = openWorkbench(root);
    const index = workbench.roster.findIndex((entry) => entry.agent.id === id);
    const entry = workbench.roster[index];
    if (!entry || entry.template === undefined) return false;

    const next: RosterEntry = { ...entry, trusted: true };
    workbench.roster.splice(index, 1, next);
    writeRoster(join(root, ".refrain"), workbench.roster);
    workbench.host.addAdapter(
      new CommandAdapter({ id: next.agent.binding.harness, template: entry.template }),
    );
    return true;
  });

  /**
   * Ask a harness whether it is actually reachable.
   *
   * Storing a command without ever running it tells the author nothing: they
   * discover the mistake when a run fails silently an hour later. This spawns
   * the command's first token with a version flag and reports what came back.
   */
  ipc.handle("agent:probe", async (_e, root: string, id: string) => {
    const entry = openWorkbench(root).roster.find((candidate) => candidate.agent.id === id);
    if (!entry) return { ok: false, detail: "unknown agent" };
    if (entry.agent.binding.harness === "file") return { ok: true };

    // A probe is an execution. An agent restored from a project file the author
    // has not vouched for does not get run just because a screen was opened.
    if (entry.template !== undefined && entry.trusted !== true)
      return { ok: false, reason: "untrusted", detail: entry.template.join(" ") };

    const program = entry.template?.[0];
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
    if (!workbench.roster.some((entry) => entry.agent.id === id)) return false;
    const next = workbench.roster.filter((entry) => entry.agent.id !== id);
    writeRoster(join(root, ".refrain"), next);
    workbench.host.unregister(id);
    workbench.roster.splice(0, workbench.roster.length, ...next);
    return true;
  });

  ipc.handle("agent:add", (_e, root: string, name: string, command: string) => {
    const workbench = openWorkbench(root);
    const id = randomUUID();
    const template = command.trim().length > 0 ? parseCommandLine(command) : undefined;
    const harness = template === undefined ? "file" : `command:${id}`;
    const agent: Agent = {
      id,
      name,
      binding: { harness, model: "unspecified", reasoningEffort: "unspecified" },
    };
    // Typed here, in this window, a moment ago: the author is the source, so
    // there is nothing to confirm. Consent is owed for commands that arrive
    // with a project, not for the ones someone just wrote.
    const entry = { agent, ...(template === undefined ? {} : { template, trusted: true }) };
    const next = [...workbench.roster, entry];
    writeRoster(join(root, ".refrain"), next);
    if (template !== undefined)
      workbench.host.addAdapter(new CommandAdapter({ id: harness, template }));
    workbench.host.register(agent);
    workbench.roster.push(entry);
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

  /**
   * The runs, each carrying why it failed.
   *
   * The reason was recorded on the Host and had no channel out, so the
   * interface could show that a run failed but never what went wrong — which
   * for a harness misconfiguration is the only useful part.
   */
  ipc.handle("agent:runs", (_e, root: string) => {
    const workbench = openWorkbench(root);
    return workbench.host.runs().map((r) => {
      const failure = workbench.host.failureFor(r.id);
      return {
        id: r.id,
        state: r.state,
        resultPath: r.resultPath,
        agentId: r.agentId,
        ...(failure === undefined ? {} : { failure }),
      };
    });
  });

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
      if (workbench.commitRecovery)
        return { ok: false, reason: "recovery-required", detail: [workbench.commitRecovery] };
      const head = headFor(root, payload.chapter);
      const known = workbench.onDisk.get(payload.chapter);
      if (!known?.stamp)
        return { ok: false, reason: "chapter-not-loaded", detail: [payload.chapter] };
      const staged = [...new Set(payload.verdicts.map((v) => v.proposalId))].flatMap((id) => {
        const proposal = workbench.proposals.get(id);
        return proposal ? [proposal] : [];
      });

      const result = commitDecisionBatch(head, staged, payload.verdicts);
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };

      // A merge and its verdicts land together or not at all. Without a ledger
      // the judgments have nowhere to go, and merging anyway would move the
      // manuscript while losing the record of who decided what and why — which
      // is the one thing this application exists to keep.
      const { ledger } = workbench;
      if (!ledger)
        return {
          ok: false,
          reason: "ledger-unavailable",
          detail: [workbench.ledgerError ?? "the ledger could not be opened"],
        };

      let written: WriteOutcome;
      try {
        written = persistDecisionCommit(
          join(root, ".refrain"),
          known.path,
          known.stamp,
          result.head,
          result.verdicts,
          ledger,
        );
      } catch (error) {
        const recovery = recoverDecisionCommit(join(root, ".refrain"), ledger);
        if (!recovery.ok) workbench.commitRecovery = recovery.detail ?? String(error);
        throw error;
      }
      if (!written.ok) return { ok: false, reason: written.reason, detail: [written.path] };

      workbench.heads.set(payload.chapter, result.head);
      workbench.onDisk.set(payload.chapter, { path: written.path, stamp: written.stamp });
      return { ok: true, text: currentText(result.head) };
    },
  );

  /*
   * The ledger's three channels answer with a reason rather than an exception.
   *
   * An empty list would be a lie the author cannot tell apart from an empty
   * ledger, and an exception crossing the bridge arrives as an opaque string.
   * The refusal carries what SQLite said, so the panel can name the cause.
   */
  const ledgerOf = (root: string): { ledger: VerdictLedger } | { detail: string } => {
    const workbench = openWorkbench(root);
    return workbench.ledger
      ? { ledger: workbench.ledger }
      : { detail: workbench.ledgerError ?? "the ledger could not be opened" };
  };

  ipc.handle("ledger:all", (_e, root: string) => {
    const held = ledgerOf(root);
    return "ledger" in held
      ? { ok: true, verdicts: held.ledger.all() }
      : { ok: false, reason: "ledger-unavailable", detail: held.detail };
  });

  ipc.handle("ledger:reply", (_e, root: string, proposalId: string) => {
    const held = ledgerOf(root);
    return "ledger" in held ? serializeVerdicts(held.ledger.forProposal(proposalId)) : "";
  });

  /*
   * Retrieval over stated reasoning. The ledger informs the author when they
   * revise an agent's persona; it does not compile one for them, which would
   * require an inference this application has no way to perform.
   */
  ipc.handle("ledger:search", (_e, root: string, fragment: string) => {
    const held = ledgerOf(root);
    return "ledger" in held
      ? { ok: true, verdicts: held.ledger.search(fragment) }
      : { ok: false, reason: "ledger-unavailable", detail: held.detail };
  });

  // The file layer's channels live in their own module: they degrade as a
  // group when the platform binary is missing, and that rule is easier to hold
  // where it is the only rule in the file.
  registerFileHandlers(ipc, filesFor, (root) => openWorkbench(root).fileError);
};
