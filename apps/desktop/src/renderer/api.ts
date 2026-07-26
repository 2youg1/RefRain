/**
 * The renderer's whole capability surface. Everything else — file access,
 * process launch, the ledger — lives in the main process behind these channels.
 */
export interface ChapterView {
  title: string;
  text: string;
}

export interface SliceView {
  id: string;
  kind: "same" | "del" | "ins";
  text: string;
}

export interface ProposalView {
  id: string;
  runId: string;
  baseline: string;
  scope: { id: string; blockIds: string[] };
  before: string;
  after: string | null;
  slices: SliceView[];
}

export interface ManifestEntryView {
  agentName: string;
  harness: string;
  model: string;
  reasoningEffort: string;
  runCount: number;
  scopes: string[];
  prompts: string[];
  drifted: string[];
}

export interface RunView {
  id: string;
  state: string;
  resultPath: string;
  agentId: string;
}

export interface VerdictView {
  id: string;
  proposalId: string;
  sliceId?: string;
  kind: "accept" | "accept-modified" | "reject" | "comment-only";
  finalText?: string;
  reason?: string;
  baseline: string;
  decidedAt: string;
}

export interface AgentView {
  id: string;
  name: string;
  binding: { harness: string; model: string; reasoningEffort: string };
}

interface RecensionApi {
  openProject(): Promise<string | null>;
  createProject(): Promise<string | null>;
  pathFor(file: File): string;
  resolveDrop(path: string): Promise<string | null>;
  fullscreen(on: boolean): Promise<boolean>;
  loadProject(root: string): Promise<ChapterView[]>;
  saveChapter(root: string, title: string, text: string): Promise<boolean>;
  listAgents(root: string): Promise<AgentView[]>;
  addAgent(root: string, name: string, command: string): Promise<AgentView>;
  enqueue(root: string, task: unknown): Promise<boolean>;
  manifest(root: string): Promise<ManifestEntryView[]>;
  send(root: string): Promise<{ id: string; requestPath: string; resultPath: string }[]>;
  collect(
    root: string,
    runId: string,
  ): Promise<{ proposals: ProposalView[]; comments: { target: string; text: string }[] }>;
  runs(root: string): Promise<RunView[]>;
  commit(
    root: string,
    payload: { chapter: string; verdicts: VerdictView[] },
  ): Promise<{ ok: true; text: string } | { ok: false; reason: string; detail: string[] }>;
  ledger(root: string): Promise<VerdictView[]>;
  reply(root: string, proposalId: string): Promise<string>;
}

declare global {
  interface Window {
    recension: RecensionApi;
  }
}

export const api = (): RecensionApi => window.recension;
