import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, ReviewTask } from "@recension/agent";
import { AgentHost, CommandAdapter, FileChannelAdapter, sendManifest } from "@recension/agent";
import {
  commitDecisionBatch,
  currentText,
  loadProject,
  type Proposal,
  saveChapter,
  serializeVerdicts,
  sliceProposal,
  type TextHead,
  type Verdict,
  VerdictLedger,
} from "@recension/core";
import type { Dialog, IpcMain } from "electron";

/**
 * The main process owns state; the renderer only presents and accepts input
 * (SPEC 5.2 rule 6). One workbench per project root, created on first touch.
 */
interface Workbench {
  readonly host: AgentHost;
  readonly ledger: VerdictLedger;
  readonly heads: Map<string, TextHead>;
  readonly proposals: Map<string, Proposal>;
  readonly agents: Agent[];
}

const workbenches = new Map<string, Workbench>();

const openWorkbench = (root: string): Workbench => {
  const existing = workbenches.get(root);
  if (existing) return existing;

  const stateDir = join(root, ".recension");
  mkdirSync(stateDir, { recursive: true });

  const workbench: Workbench = {
    host: new AgentHost(stateDir, [new FileChannelAdapter(stateDir)]),
    ledger: new VerdictLedger(join(stateDir, "verdicts.db")),
    heads: new Map(),
    proposals: new Map(),
    agents: [],
  };
  workbenches.set(root, workbench);
  return workbench;
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

  ipc.handle("project:load", (_e, root: string) => {
    const project = loadProject(root);
    const workbench = openWorkbench(root);
    for (const chapter of project.chapters) workbench.heads.set(chapter.title, chapter.head);
    return project.chapters.map((c) => ({ title: c.title, text: currentText(c.head) }));
  });

  ipc.handle("project:save", (_e, root: string, title: string, text: string) => {
    const head: TextHead = {
      id: `${title}@${Date.now()}`,
      blocks: text
        .split(/\n\s*\n/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map((t, i) => ({ id: `${title}:b${i}`, text: t })),
      cause: "author edit",
    };
    openWorkbench(root).heads.set(title, head);
    saveChapter(loadProject(root), title, head);
    return true;
  });

  ipc.handle("agent:list", (_e, root: string) => openWorkbench(root).agents);

  ipc.handle("agent:add", (_e, root: string, name: string, command: string) => {
    const workbench = openWorkbench(root);
    const harness = command.trim().length > 0 ? `command:${name}` : "file";
    const agent: Agent = {
      id: randomUUID(),
      name,
      binding: { harness, model: "unspecified", reasoningEffort: "unspecified" },
    };
    if (harness !== "file")
      workbench.host.addAdapter(
        new CommandAdapter({ id: harness, template: command.split(/\s+/) }),
      );
    workbench.host.register(agent);
    workbench.agents.push(agent);
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
};
